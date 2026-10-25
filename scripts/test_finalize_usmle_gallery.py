"""Fail-closed one-known-error release gating tests; never access Cloudflare."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from finalize_usmle_gallery import (
    TOTAL_COUNT, USMLE_APPROVED_COUNT, KNOWN_ERROR_ID,
    validate_status, filter_manifest
)

FAILURE = {
    "id": "7cbf6ca4388540a88cdaecb1d1daca56",
    "key": "usmle_L116818.json",
    "error": "workers_ai_timeout_error",
    "source_id": "builtin",
    "status": "error",
}
CLEAN = {
    "completed": TOTAL_COUNT,
    "queued": 0, "running": 0, "error": 0, "skipped": 0, "degraded": 0,
}
ONE = {**CLEAN, "completed": TOTAL_COUNT - 1, "error": 1}


class PartialReleaseGateTests(unittest.TestCase):
    def test_zero_errors_allows_full_manifest(self):
        self.assertIsNone(validate_status(CLEAN, []))

    def test_exact_known_failure_only(self):
        self.assertEqual(validate_status(ONE, [FAILURE]), KNOWN_ERROR_ID)

    def test_reject_unknown_failed_source(self):
        for update in ({"key": "img_000004.json"}, {"key": "usmle_L321.json"},
                       {"error": "parse_error"}, {"source_id": "r2"}, {"status": "running"}):
            with self.subTest(update=update), self.assertRaises(RuntimeError):
                validate_status(ONE, [{**FAILURE, **update}])

    def test_reject_incomplete_or_unknown_error_count(self):
        for bad in (
            {**ONE, "running": 1, "completed": TOTAL_COUNT - 2},
            {**ONE, "error": 2, "completed": TOTAL_COUNT - 2},
            {**ONE, "skipped": 1, "completed": TOTAL_COUNT - 2},
            {**ONE, "degraded": 1},
            {**ONE, "completed": TOTAL_COUNT - 2},
        ):
            with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                validate_status(bad, [FAILURE])

    def test_approved_manifest_only_excludes_known_error(self):
        manifest = {f"usmle_L{i}": {"rights_status": "approved", "display_ready": True}
                    for i in range(1, USMLE_APPROVED_COUNT)}
        manifest[KNOWN_ERROR_ID] = {"rights_status": "approved", "display_ready": True}
        self.assertEqual(len(manifest), USMLE_APPROVED_COUNT)
        result = filter_manifest(manifest, KNOWN_ERROR_ID)
        self.assertEqual(len(result), USMLE_APPROVED_COUNT - 1)
        self.assertNotIn(KNOWN_ERROR_ID, result)
        self.assertEqual(len(filter_manifest(manifest, None)), USMLE_APPROVED_COUNT)

    def test_reject_unapproved_or_extra_or_missing_known_item(self):
        manifest = {f"usmle_L{i}": {"rights_status": "approved", "display_ready": True}
                    for i in range(1, USMLE_APPROVED_COUNT + 1)}
        with self.assertRaises(RuntimeError):
            filter_manifest(manifest, KNOWN_ERROR_ID)
        manifest["usmle_L12"]["display_ready"] = False
        with self.assertRaises(RuntimeError):
            filter_manifest(manifest, None)


if __name__ == "__main__":
    unittest.main()
