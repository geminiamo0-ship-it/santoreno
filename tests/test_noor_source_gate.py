"""Offline fail-closed regression for Noor Dev source pinning (#306)."""
import importlib.util
from pathlib import Path
import unittest

source = Path(__file__).resolve().parents[1] / "scripts/noor_source_gate.py"
spec = importlib.util.spec_from_file_location("noor_source_gate", source)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

SHA = "a" * 40
OTHER = "b" * 40


def eligible_pr(sha=SHA):
    return {
        "state": "open",
        "draft": False,
        "user": {"login": "owner"},
        "head": {"sha": sha, "repo": {"full_name": gate.REPO}},
        "base": {"ref": "main", "repo": {"full_name": gate.REPO}},
    }


def approved(sha=SHA, reviewer="reviewer", state="APPROVED", at="2026-10-31T10:00:00Z"):
    return {
        "user": {"login": reviewer},
        "state": state,
        "commit_id": sha,
        "submitted_at": at,
    }


def runs(sha=SHA, event="pull_request", conclusion="success"):
    return {"workflow_runs": [{
        "name": "Verify", "head_sha": sha, "event": event,
        "status": "completed", "conclusion": conclusion,
        "created_at": "2026-10-31T10:00:00Z", "id": 1,
    }]}


def fixture(pr=None, reviews=None, workflow=None, permissions=None):
    mapping = {
        "branches/main": {"commit": {"sha": SHA}},
        "pulls/288": eligible_pr() if pr is None else pr,
        "pulls/288/reviews?per_page=100": [approved()] if reviews is None else reviews,
        "actions/runs?head_sha=" + SHA + "&per_page=100": runs() if workflow is None else workflow,
    }
    def get_json(path):
        if path.startswith("collaborators/") and path.endswith("/permission"):
            reviewer = path.split("/")[1]
            permission = (permissions or {}).get(reviewer, "write")
            return {"permission": permission}
        return mapping[path]
    return get_json


class SourceGateTests(unittest.TestCase):
    def test_reviewed_same_repo_exact_head_is_eligible(self):
        self.assertEqual(gate.resolve_source("288", fixture()), SHA)

    def test_denies_unprivileged_approvals_even_when_review_and_ci_green(self):
        for role in ("read", "triage", None, "unknown"):
            with self.subTest(permission=role):
                with self.assertRaisesRegex(gate.SourceGateError, "write permission"):
                    gate.resolve_source("288", fixture(permissions={"reviewer": role}))

    def test_accepts_only_verified_reviewer_write_or_higher(self):
        for role in ("write", "maintain", "admin"):
            with self.subTest(permission=role):
                self.assertEqual(
                    gate.resolve_source("288", fixture(permissions={"reviewer": role})),
                    SHA,
                )

    def test_one_valid_writer_needed_among_independent_approvers(self):
        reviews = [
            approved(reviewer="alice"),
            approved(reviewer="bob", at="2026-10-31T11:00:00Z"),
        ]
        self.assertEqual(gate.resolve_source(
            "288", fixture(reviews=reviews, permissions={"alice": "read", "bob": "write"})
        ), SHA)
        with self.assertRaisesRegex(gate.SourceGateError, "write permission"):
            gate.resolve_source(
                "288", fixture(reviews=reviews, permissions={"alice": "read", "bob": "triage"})
            )

    def test_permission_lookup_error_is_fail_closed(self):
        base = fixture()
        def fail_permission(path):
            if path.startswith("collaborators/"):
                raise gate.SourceGateError("GitHub source verification unavailable")
            return base(path)
        with self.assertRaisesRegex(gate.SourceGateError, "unavailable"):
            gate.resolve_source("288", fail_permission)

    def test_unknown_reviewer_logins_cannot_construct_api_paths(self):
        for reviewer in ("../admin", "outsider/permission", "q" * 50):
            with self.subTest(reviewer=reviewer):
                with self.assertRaisesRegex(gate.SourceGateError, "approval"):
                    gate.resolve_source("288", fixture(reviews=[approved(reviewer=reviewer)]))

    def test_default_main_requires_successful_push_verify(self):
        def get_json(path):
            if path == "branches/main":
                return {"commit": {"sha": SHA}}
            return runs(SHA, "push")
        self.assertEqual(gate.resolve_source("", get_json), SHA)
        with self.assertRaisesRegex(gate.SourceGateError, "main Verify"):
            gate.resolve_source("", lambda path: {"commit": {"sha": SHA}} if path == "branches/main" else runs(SHA, "pull_request"))

    def test_later_failed_or_pending_exact_sha_verify_overrides_older_success(self):
        earlier = {
            "name": "Verify", "head_sha": SHA, "event": "push",
            "status": "completed", "conclusion": "success",
            "created_at": "2026-10-31T10:00:00Z", "id": 11,
        }
        for status, conclusion in (("completed", "failure"), ("in_progress", None),
                                   ("completed", "cancelled")):
            newer = {**earlier, "status": status, "conclusion": conclusion,
                     "created_at": "2026-10-31T11:00:00Z", "id": 12}
            for order in ([earlier, newer], [newer, earlier]):
                def get_json(path):
                    if path == "branches/main":
                        return {"commit": {"sha": SHA}}
                    return {"workflow_runs": order}
                with self.subTest(status=status, order=order):
                    with self.assertRaisesRegex(gate.SourceGateError, "main Verify"):
                        gate.resolve_source("", get_json)
        fresh = {**earlier, "id": 12, "created_at": "2026-10-31T11:00:00Z"}
        def green_get_json(path):
            if path == "branches/main":
                return {"commit": {"sha": SHA}}
            return {"workflow_runs": [earlier, fresh]}
        self.assertEqual(gate.resolve_source("", green_get_json), SHA)

    def test_missing_or_incomplete_verify_history_fails_closed(self):
        base = runs(SHA, "push")["workflow_runs"][0]
        for result in (
            {"workflow_runs": [{k: v for k, v in base.items() if k != "created_at"}]},
            {"workflow_runs": [{**base, "created_at": "unparseable"}]},
            {"workflow_runs": [{k: v for k, v in base.items() if k != "id"}]},
            {"workflow_runs": [base] * 100},
            {"workflow_runs": None},
        ):
            def get_json(path):
                if path == "branches/main":
                    return {"commit": {"sha": SHA}}
                return result
            with self.subTest(result=str(result)[:100]):
                with self.assertRaisesRegex(gate.SourceGateError, "main Verify"):
                    gate.resolve_source("", get_json)

    def test_waits_only_for_same_main_sha_completed_successful_push_verify(self):
        calls = {"runs": 0, "sleeps": []}
        def get_json(path):
            if path == "branches/main":
                return {"commit": {"sha": SHA}}
            if path.startswith("actions/runs?"):
                calls["runs"] += 1
                if calls["runs"] == 1:
                    return {"workflow_runs": [{
                        "name": "Verify", "head_sha": SHA, "event": "push",
                        "status": "in_progress", "conclusion": None,
                        "created_at": "2026-10-31T10:00:00Z", "id": 2,
                    }]}
                return runs(SHA, "push")
            self.fail("Unexpected GitHub endpoint")
        self.assertEqual(gate.resolve_source(
            "", get_json, sleep=lambda seconds: calls["sleeps"].append(seconds),
            main_checks=3,
        ), SHA)
        self.assertEqual(calls["sleeps"], [12])
        self.assertEqual(calls["runs"], 2)

    def test_main_ref_change_during_ci_wait_fails_closed(self):
        counts = {"branch": 0, "sleeps": []}
        def get_json(path):
            if path == "branches/main":
                counts["branch"] += 1
                return {"commit": {"sha": SHA if counts["branch"] <= 2 else OTHER}}
            if path.startswith("actions/runs?"):
                return {"workflow_runs": []}
            self.fail("Unexpected GitHub endpoint")
        with self.assertRaisesRegex(gate.SourceGateError, "main changed"):
            gate.resolve_source(
                "", get_json, sleep=lambda n: counts["sleeps"].append(n),
                main_checks=4,
            )
        self.assertEqual(counts["sleeps"], [12])
    
    def test_pending_or_failed_main_verify_never_unlocks_staging(self):
        for status, conclusion in [
            ("in_progress", None), ("completed", "failure"),
            ("completed", "cancelled"),
        ]:
            with self.subTest(status=status, conclusion=conclusion):
                observed = []
                def get_json(path):
                    if path == "branches/main":
                        return {"commit": {"sha": SHA}}
                    return {"workflow_runs": [{
                        "name": "Verify", "head_sha": SHA, "event": "push",
                        "status": status, "conclusion": conclusion,
                        "created_at": "2026-10-31T10:00:00Z", "id": 3,
                    }]}
                with self.assertRaisesRegex(gate.SourceGateError, "main Verify"):
                    gate.resolve_source(
                        "", get_json, sleep=lambda n: observed.append(n),
                        main_checks=3,
                    )
                self.assertEqual(observed, [12, 12])

    def test_retry_limits_are_bounded_and_no_waiter_fails_closed(self):
        def get_json(path):
            return {"commit": {"sha": SHA}} if path == "branches/main" else runs(SHA, "push")
        for checks in (0, 11, -1, True, "10"):
            # Bool is a Python int subclass, but should never be an accepted
            # caller-controlled retry count.
            with self.subTest(checks=checks):
                with self.assertRaises(gate.SourceGateError):
                    gate.verified_main_source(SHA, get_json, sleep=lambda _: None, checks=checks)
        with self.assertRaisesRegex(gate.SourceGateError, "bounded sleeper"):
            gate.verified_main_source(SHA, get_json, checks=2)
        
    def test_reject_fork_draft_wrong_base_and_closed(self):
        for key, value in [
            ("head", {"sha": SHA, "repo": {"full_name": "outsider/fork"}}),
            ("draft", True),
            ("state", "closed"),
            ("base", {"ref": "development", "repo": {"full_name": gate.REPO}}),
        ]:
            with self.subTest(key=key):
                pr = eligible_pr()
                pr[key] = value
                with self.assertRaises(gate.SourceGateError):
                    gate.resolve_source("288", fixture(pr=pr))

    def test_reject_missing_self_approved_stale_and_withdrawn_reviews(self):
        for reviews in [
            [],
            [approved(reviewer="owner")],
            [approved(sha=OTHER)],
            [approved(), approved(state="CHANGES_REQUESTED", at="2026-10-31T11:00:00Z")],
        ]:
            with self.subTest(reviews=reviews):
                with self.assertRaisesRegex(gate.SourceGateError, "approval"):
                    gate.resolve_source("288", fixture(reviews=reviews))

    def test_review_gate_rejects_cross_reviewer_veto_and_case_aliases(self):
        for reviews in [
            [approved(reviewer="OWNER")],
            [approved(reviewer="Reviewer"), approved(reviewer="reviewer", state="CHANGES_REQUESTED", at="2026-10-31T11:00:00Z")],
            [approved(reviewer="alice"), approved(reviewer="bob", state="CHANGES_REQUESTED", at="2026-10-31T11:00:00Z")],
            [approved(reviewer="bob", state="CHANGES_REQUESTED"), approved(reviewer="alice", at="2026-10-31T11:00:00Z")],
            [
                approved(reviewer="alice", state="CHANGES_REQUESTED"),
                approved(reviewer="bob", at="2026-10-31T11:00:00Z"),
                approved(reviewer="alice", state="COMMENTED", at="2026-10-31T12:00:00Z"),
            ],
            [approved(reviewer="reviewer")] * 100,
        ]:
            with self.subTest(reviews=reviews[:2], count=len(reviews)):
                with self.assertRaisesRegex(gate.SourceGateError, "approval"):
                    gate.resolve_source("288", fixture(reviews=reviews))

    def test_review_gate_allows_resolved_change_request(self):
        reviews = [
            approved(reviewer="alice", state="CHANGES_REQUESTED"),
            approved(reviewer="bob", at="2026-10-31T11:00:00Z"),
            approved(reviewer="alice", state="DISMISSED", at="2026-10-31T12:00:00Z"),
        ]
        self.assertEqual(gate.resolve_source("288", fixture(reviews=reviews)), SHA)
        self.assertEqual(
            gate.resolve_source("288", fixture(reviews=[
                approved(reviewer="alice"),
                approved(reviewer="alice", state="COMMENTED", at="2026-10-31T11:00:00Z"),
            ])),
            SHA,
        )

    def test_reject_wrong_event_failed_ci_or_stale_sha(self):
        for result in [
            runs(event="push"),
            runs(conclusion="failure"),
            runs(sha=OTHER),
            {"workflow_runs": []},
        ]:
            with self.subTest(result=result):
                with self.assertRaisesRegex(gate.SourceGateError, "PR Verify"):
                    gate.resolve_source("288", fixture(workflow=result))

    def test_reject_invalid_pr_input_without_network(self):
        for value in ["../../1", "0", "288;echo", "-1", "x", "9" * 20]:
            with self.subTest(value=value):
                with self.assertRaisesRegex(gate.SourceGateError, "PR number"):
                    gate.resolve_source(value, lambda _: self.fail("unexpected network"))


if __name__ == "__main__":
    unittest.main()
