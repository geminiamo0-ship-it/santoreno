#!/usr/bin/env python3
"""Fail-closed Noor source selection for isolated Dev staging (#306).

Only a verified main SHA, or an independently reviewed exact PR head from the
same Noor repository, may be built with staging Cloudflare credentials.
"""
import json
import os
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO = "geminiamo0-ship-it/nour-elquran"
SHA = re.compile(r"[0-9a-f]{40}\Z")
PR_NUMBER = re.compile(r"[1-9][0-9]{0,5}\Z")


class SourceGateError(Exception):
    pass


def api_json(path):
    token = os.environ.get("GH_TOKEN", "")
    if not token:
        raise SourceGateError("GitHub read token missing")
    req = Request(
        "https://api.github.com/repos/" + REPO + "/" + path,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(req, timeout=20) as response:
            return json.load(response)
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        # Never include raw HTTP response, headers or token in Actions logs.
        raise SourceGateError("GitHub source verification unavailable") from None


def verify_run(sha, event, get_json):
    result = get_json("actions/runs?head_sha=" + sha + "&per_page=100")
    runs = result.get("workflow_runs") if isinstance(result, dict) else None
    if not isinstance(runs, list) or len(runs) >= 100:
        # The first page may omit a newer failure or pending Verify.
        return False
    matching = [
        run for run in runs
        if isinstance(run, dict)
        and run.get("name") == "Verify"
        and run.get("head_sha") == sha
        and run.get("event") == event
    ]
    if not matching:
        return False
    # A previous green run must not authorize Dev secrets if a later run
    # is pending or failed on the exact same source SHA. GitHub timestamps
    # are authoritative; unknown/malformed dates are denied.
    if any(
        not isinstance(run.get("created_at"), str)
        or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", run["created_at"])
        or not isinstance(run.get("id"), int)
        for run in matching
    ):
        return False
    newest = max(matching, key=lambda run: (run["created_at"], run["id"]))
    return newest.get("status") == "completed" and newest.get("conclusion") == "success"


def eligible_approvers(reviews, sha, author):
    """Candidate reviewers after the full review/veto history is checked.

    APPROVED alone is not authority to deploy other people's code with
    Cloudflare secrets: caller must separately verify reviewer write access.
    """
    if not isinstance(reviews, list):
        return []
    # The REST endpoint returns at most 100 reviews per page. Deny when the
    # response may be incomplete, rather than missing an outstanding veto.
    if len(reviews) >= 100:
        return []
    latest = {}
    for review in sorted(
        (item for item in reviews if isinstance(item, dict) and item.get("submitted_at")),
        key=lambda item: item["submitted_at"],
    ):
        user = review.get("user") or {}
        login = user.get("login") if isinstance(user, dict) else None
        # COMMENTED reviews do not withdraw an outstanding change request.
        # Only decisive review states replace the prior decision.
        if (
            isinstance(login, str)
            and login
            and login.casefold() != author.casefold()
            and review.get("state") in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED")
        ):
            latest[login.casefold()] = review
    # One reviewer's outstanding change request must not be overridden by
    # another reviewer's approval; a later dismissal or approval clears it.
    if any(item.get("state") == "CHANGES_REQUESTED" for item in latest.values()):
        return []
    return [
        login for login, item in latest.items()
        if item.get("state") == "APPROVED" and item.get("commit_id") == sha
        and re.fullmatch(r"[a-z0-9-]{1,39}", login)
    ]


def independently_approved(reviews, sha, author):
    """Source-history check; does not by itself establish reviewer authority."""
    return bool(eligible_approvers(reviews, sha, author))


def has_write_reviewer(approvers, get_json):
    """Only repo collaborators with verified write+ may approve a Dev deploy.

    Trust the authenticated GitHub collaborator permission endpoint, never a
    reviewer's claimed association, submitted review state, or PR author.
    Endpoint errors are fail-closed by api_json; no identity or secret logged.
    """
    for reviewer in approvers:
        response = get_json("collaborators/" + reviewer + "/permission")
        permission = response.get("permission") if isinstance(response, dict) else None
        if permission in ("admin", "maintain", "write"):
            return True
    return False


def verified_main_source(sha, get_json, sleep=None, checks=1):
    """Wait a bounded time for the exact Noor main SHA CI, without weakening it.

    A same-minute Santoreno push can run before Noor's Verify finishes. Recheck
    the main ref before every attempt, and NEVER accept an older SHA, another
    event, or an in-progress/failed workflow as success. Unit tests leave
    sleep disabled; only the workflow entry point enables bounded retries.
    """
    if type(checks) is not int or not 1 <= checks <= 10:
        raise SourceGateError("Invalid Noor Verify retry count")
    if checks > 1 and sleep is None:
        raise SourceGateError("Noor Verify retry must provide a bounded sleeper")
    for attempt in range(checks):
        branch = get_json("branches/main")
        current = (branch.get("commit") or {}).get("sha") if isinstance(branch, dict) else None
        if current != sha:
            raise SourceGateError("Noor main changed during exact-head Verify check")
        if verify_run(sha, "push", get_json):
            return sha
        if attempt + 1 < checks:
            sleep(12)
    raise SourceGateError("No successful exact-head Noor main Verify")


def resolve_source(pr_number, get_json, *, sleep=None, main_checks=1):
    if not pr_number:
        branch = get_json("branches/main")
        sha = (branch.get("commit") or {}).get("sha") if isinstance(branch, dict) else None
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise SourceGateError("Invalid Noor main commit")
        return verified_main_source(sha, get_json, sleep=sleep, checks=main_checks)

    if not PR_NUMBER.fullmatch(pr_number):
        raise SourceGateError("Invalid Noor PR number")
    pr = get_json("pulls/" + pr_number)
    if not isinstance(pr, dict):
        raise SourceGateError("Invalid Noor PR response")
    head = pr.get("head") or {}
    base = pr.get("base") or {}
    sha = head.get("sha")
    author = (pr.get("user") or {}).get("login")
    if not (
        pr.get("state") == "open"
        and pr.get("draft") is False
        and (head.get("repo") or {}).get("full_name") == REPO
        and (base.get("repo") or {}).get("full_name") == REPO
        and base.get("ref") == "main"
        and isinstance(sha, str)
        and SHA.fullmatch(sha)
        and isinstance(author, str)
    ):
        raise SourceGateError("Noor PR is not an eligible same-repository main PR")
    reviews = get_json("pulls/" + pr_number + "/reviews?per_page=100")
    approvers = eligible_approvers(reviews, sha, author)
    if not approvers:
        raise SourceGateError("No independent exact-head Noor PR approval")
    if not has_write_reviewer(approvers, get_json):
        raise SourceGateError("No approved Noor reviewer has verified write permission")
    if not verify_run(sha, "pull_request", get_json):
        raise SourceGateError("No successful exact-head Noor PR Verify")
    return sha


def main():
    try:
        print(resolve_source(
            os.environ.get("NOOR_PR_NUMBER", ""), api_json,
            sleep=time.sleep, main_checks=10,
        ))
    except SourceGateError as exc:
        print("NOOR_SOURCE_GATE_DENIED: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
