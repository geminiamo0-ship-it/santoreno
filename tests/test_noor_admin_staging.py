"""Offline contract checks for signed Noor Admin staging (#327)."""
import importlib.util
import json
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "scripts/noor_admin_staging.py"
spec = importlib.util.spec_from_file_location("noor_admin_staging", path)
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)

GOOD = {"code": "STAFF_OVERVIEW", "requestId": "synthetic-uuid-request",
        "readOnly": True, "asOfMs": 1793600000000,
        "metrics": {"activeLearners": 2, "activeQualifiedTeachers": 1,
                    "upcomingLessons": 0, "completedLessons": 3}}


class AdminStagingTests(unittest.TestCase):
    def test_only_approved_nonidentifying_counts_accepted(self):
        self.assertTrue(admin.assert_admin_overview(GOOD))
        mutations = [
            {**GOOD, "email": "test@example.invalid"},
            {**GOOD, "requestId": ""},
            {**GOOD, "requestId": {"email": "bad"}},
            {key: value for key, value in GOOD.items() if key != "requestId"},
            {**GOOD, "metrics": {**GOOD["metrics"], "guardianPhone": "hidden"}},
            {**GOOD, "metrics": {**GOOD["metrics"], "activeLearners": True}},
            {**GOOD, "metrics": {**GOOD["metrics"], "completedLessons": -1}},
            {**GOOD, "readOnly": False},
            {**GOOD, "asOfMs": "today"},
            {**GOOD, "metrics": []},
        ]
        for value in mutations:
            with self.subTest(value=value):
                with self.assertRaises(RuntimeError):
                    admin.assert_admin_overview(value)

    def test_signed_role_matrix_and_revocation_are_fail_closed(self):
        calls = []
        def fake_http(_origin, path, method="GET", body=None, opener=None):
            calls.append((path, method, opener))
            if method != "GET":
                return 405, b'{"code":"METHOD_NOT_ALLOWED"}', {}
            if opener is None:
                return 401, b'{"code":"AUTH_REQUIRED"}', {}
            if opener == "teacher" or opener == "revoked":
                return 403, b'{"code":"STAFF_ACCESS_DENIED"}', {}
            if opener == "staff":
                return 200, json.dumps(GOOD).encode(), {"Cache-Control": "no-store"}
            raise AssertionError("Unexpected session")
        def require_status(value, expected, _label):
            self.assertEqual(value, expected)
        admin.verify_signed_admin_overview("https://staging.invalid", "staff", "teacher",
                                           fake_http, require_status, json.loads)
        admin.verify_revoked_admin_overview("https://staging.invalid", "revoked",
                                            fake_http, require_status)
        self.assertEqual([row[1] for row in calls], ["GET", "GET", "GET", "POST", "GET"])
        self.assertEqual(calls[-1][2], "revoked")

    def test_teacher_directory_strict_rows_and_signed_role_matrix(self):
        teacher = {
            "id": "synthetic-teacher", "name": "شيخ تجريبي",
            "qualified": True, "status": "active",
            "currentLearners": 1, "upcomingLessons": 0,
        }
        good = {
            "code": "STAFF_TEACHER_DIRECTORY", "requestId": "safe-request",
            "asOfMs": 1793600000000, "readOnly": True,
            "teachers": [teacher], "truncated": False,
        }
        self.assertTrue(admin.assert_teacher_directory(good, teacher["id"], 1))
        for invalid in [
            {**good, "phone": "000"},
            {**good, "requestId": "!"},
            {**good, "teachers": [{**teacher, "phone": "bad"}]},
            {**good, "teachers": [{**teacher, "currentLearners": True}]},
            {**good, "teachers": [{**teacher, "id": "bad/id"}]},
            {**good, "teachers": [teacher, teacher]},
            {**good, "truncated": True},
            {**good, "teachers": [teacher] * 51},
            {**good, "readOnly": False},
        ]:
            with self.subTest(invalid=invalid):
                with self.assertRaises(RuntimeError):
                    admin.assert_teacher_directory(invalid)
        with self.assertRaises(RuntimeError):
            admin.assert_teacher_directory(good, "wrong-teacher", 1)

        calls = []
        def fake_http(_origin, _path, method="GET", body=None, opener=None):
            calls.append((method, opener))
            if method == "POST":
                return 405, b'{"code":"METHOD_NOT_ALLOWED"}', {}
            if opener == "staff":
                return 200, json.dumps(good).encode(), {"Cache-Control": "no-store"}
            if opener is None:
                return 401, b'{"code":"UNAUTHENTICATED"}', {}
            return 403, b'{"code":"STAFF_ACCESS_DENIED"}', {}
        def require_status(actual, expected, _label):
            self.assertEqual(actual, expected)
        admin.verify_signed_teacher_directory(
            "https://staging.invalid", "staff", "teacher", teacher["id"],
            fake_http, require_status, json.loads, min_learners=1,
        )
        admin.verify_revoked_teacher_directory(
            "https://staging.invalid", "revoked", fake_http, require_status,
        )
        self.assertEqual(calls, [
            ("GET", None), ("GET", "teacher"), ("GET", "staff"),
            ("POST", "staff"), ("GET", "revoked"),
        ])

    def test_unexpected_staff_response_never_passes(self):
        def fail_http(_origin, _path, method="GET", body=None, opener=None):
            if opener is None:
                return 401, b'{}', {}
            if opener == "teacher":
                return 403, b'{}', {}
            return 200, b'{"metrics":{"activeLearners":8}}', {"Cache-Control": "no-store"}
        with self.assertRaises(RuntimeError):
            admin.verify_signed_admin_overview("", "staff", "teacher", fail_http,
                lambda status, expected, label: self.assertEqual(status, expected),
                json.loads)


if __name__ == "__main__":
    unittest.main()
