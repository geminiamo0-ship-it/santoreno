"""Signed, no-fixture Noor Admin Dev acceptance (#327).

Receives request helpers from the existing isolated staging runner. Never
creates production credentials, imports public records or logs sessions.
"""

METRIC_KEYS = {
    "activeLearners", "activeQualifiedTeachers",
    "upcomingLessons", "completedLessons",
}
OVERVIEW_KEYS = {"code", "asOfMs", "metrics", "readOnly"}


def assert_admin_overview(data):
    """Fail closed on leaked personal fields or invented aggregate values."""
    if not isinstance(data, dict) or set(data) != OVERVIEW_KEYS:
        raise RuntimeError("Admin Dev overview has an unexpected response shape")
    if data.get("code") != "STAFF_OVERVIEW" or data.get("readOnly") is not True:
        raise RuntimeError("Admin Dev overview is not the approved read-only contract")
    timestamp = data.get("asOfMs")
    if type(timestamp) is not int or timestamp <= 0:
        raise RuntimeError("Admin Dev overview has no valid source timestamp")
    metrics = data.get("metrics")
    if not isinstance(metrics, dict) or set(metrics) != METRIC_KEYS:
        raise RuntimeError("Admin Dev overview contains unapproved metrics")
    if not all(type(value) is int and value >= 0 for value in metrics.values()):
        raise RuntimeError("Admin Dev overview returned non-integer or negative counts")
    return True


def verify_signed_admin_overview(origin, staff, nonstaff, http, require_status, json_body):
    """Check real Better Auth cookies and fresh D1 grant on isolated Dev."""
    route = "/v1/staff/overview"
    code, body, _ = http(origin, route)
    require_status(code, 401, "Admin overview anonymous denial")
    if b'"metrics"' in body:
        raise RuntimeError("Admin metrics leaked in anonymous response")
    code, body, _ = http(origin, route, opener=nonstaff)
    require_status(code, 403, "Admin overview signed nonstaff denial")
    if b'"metrics"' in body:
        raise RuntimeError("Admin metrics leaked to a signed Sheikh")
    code, body, headers = http(origin, route, opener=staff)
    require_status(code, 200, "Admin overview valid signed staff")
    assert_admin_overview(json_body(body))
    if headers.get("Cache-Control") != "no-store":
        raise RuntimeError("Admin overview response is cacheable")
    code, _, _ = http(origin, route, method="POST", body={}, opener=staff)
    require_status(code, 405, "Admin overview forbids write methods")
    print("PASS: Noor Admin Dev signed staff 200, anonymous 401, Sheikh 403, POST 405, aggregate-only no-store")


def verify_revoked_admin_overview(origin, staff, http, require_status):
    code, body, _ = http(origin, "/v1/staff/overview", opener=staff)
    require_status(code, 403, "Revoked staff still sees Admin overview")
    if b'"metrics"' in body:
        raise RuntimeError("Revoked staff received protected aggregate metrics")
    print("PASS: Noor Admin Dev revoked staff grant immediately returns 403")
