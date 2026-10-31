#!/usr/bin/env python3
"""Fail-closed Noor source selection for isolated Dev staging (#306).

Only a verified main SHA, or an independently reviewed exact PR head from the
same Noor repository, may be built with staging Cloudflare credentials.
"""
import json
import os
import re
import sys
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
    runs = result.get("workflow_runs", []) if isinstance(result, dict) else []
    return any(
        isinstance(run, dict)
        and run.get("name") == "Verify"
        and run.get("head_sha") == sha
        and run.get("event") == event
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        for run in runs
    )


def independently_approved(reviews, sha, author):
    if not isinstance(reviews, list):
        return False
    # The REST endpoint returns at most 100 reviews per page. Deny when the
    # response may be incomplete, rather than missing an outstanding veto.
    if len(reviews) >= 100:
        return False
    latest = {}
    for review in sorted(
        (item for item in reviews if isinstance(item, dict) and item.get("submitted_at")),
        key=lambda item: item["submitted_at"],
    ):
        user = review.get("user") or {}
        login = user.get("login") if isinstance(user, dict) else None
        if isinstance(login, str) and login and login.casefold() != author.casefold():
            latest[login.casefold()] = review
    # One reviewer's outstanding change request must not be overridden by
    # another reviewer's approval; a later dismissal or approval clears it.
    if any(item.get("state") == "CHANGES_REQUESTED" for item in latest.values()):
        return False
    return any(
        item.get("state") == "APPROVED" and item.get("commit_id") == sha
        for item in latest.values()
    )


def resolve_source(pr_number, get_json):
    if not pr_number:
        branch = get_json("branches/main")
        sha = (branch.get("commit") or {}).get("sha") if isinstance(branch, dict) else None
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise SourceGateError("Invalid Noor main commit")
        if not verify_run(sha, "push", get_json):
            raise SourceGateError("No successful exact-head Noor main Verify")
        return sha

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
    if not independently_approved(reviews, sha, author):
        raise SourceGateError("No independent exact-head Noor PR approval")
    if not verify_run(sha, "pull_request", get_json):
        raise SourceGateError("No successful exact-head Noor PR Verify")
    return sha


def main():
    try:
        print(resolve_source(os.environ.get("NOOR_PR_NUMBER", ""), api_json))
    except SourceGateError as exc:
        print("NOOR_SOURCE_GATE_DENIED: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
