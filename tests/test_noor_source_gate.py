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
    }]}


def fixture(pr=None, reviews=None, workflow=None):
    mapping = {
        "branches/main": {"commit": {"sha": SHA}},
        "pulls/288": eligible_pr() if pr is None else pr,
        "pulls/288/reviews?per_page=100": [approved()] if reviews is None else reviews,
        "actions/runs?head_sha=" + SHA + "&per_page=100": runs() if workflow is None else workflow,
    }
    return lambda path: mapping[path]


class SourceGateTests(unittest.TestCase):
    def test_reviewed_same_repo_exact_head_is_eligible(self):
        self.assertEqual(gate.resolve_source("288", fixture()), SHA)

    def test_default_main_requires_successful_push_verify(self):
        def get_json(path):
            if path == "branches/main":
                return {"commit": {"sha": SHA}}
            return runs(SHA, "push")
        self.assertEqual(gate.resolve_source("", get_json), SHA)
        with self.assertRaisesRegex(gate.SourceGateError, "main Verify"):
            gate.resolve_source("", lambda path: {"commit": {"sha": SHA}} if path == "branches/main" else runs(SHA, "pull_request"))

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
