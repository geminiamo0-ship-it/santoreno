"""Signed, no-fixture Noor Admin Dev acceptance (#327).

Receives request helpers from the existing isolated staging runner. Never
creates production credentials, imports public records or logs sessions.
"""

METRIC_KEYS = {
    "activeLearners", "activeQualifiedTeachers",
    "upcomingLessons", "completedLessons",
}
# Noor's shared Worker reply() always adds a nonidentifying trace requestId.
# Do not allow any other envelope fields, including names or financial data.
OVERVIEW_KEYS = {"code", "asOfMs", "metrics", "readOnly", "requestId"}


def assert_admin_overview(data):
    """Fail closed on leaked personal fields or invented aggregate values."""
    if not isinstance(data, dict) or set(data) != OVERVIEW_KEYS:
        raise RuntimeError("Admin Dev overview has an unexpected response shape")
    request_id = data.get("requestId")
    if (not isinstance(request_id, str) or not 1 <= len(request_id) <= 128 or
            not all(ch.isalnum() or ch == "-" for ch in request_id)):
        raise RuntimeError("Admin Dev overview has an invalid trace request ID")
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


TEACHER_KEYS = {
    "id", "name", "qualified", "status", "currentLearners", "upcomingLessons",
}
DIRECTORY_KEYS = {"code", "asOfMs", "readOnly", "teachers", "truncated", "requestId"}


def assert_teacher_directory(data, teacher_id=None, min_learners=0):
    if not isinstance(data, dict) or set(data) != DIRECTORY_KEYS:
        raise RuntimeError("Admin Sheikh directory unexpected response fields")
    if data.get("code") != "STAFF_TEACHER_DIRECTORY" or data.get("readOnly") is not True:
        raise RuntimeError("Admin Sheikh directory not read-only")
    trace = data.get("requestId")
    if (not isinstance(trace, str) or not 1 <= len(trace) <= 128 or
            not all(c.isalnum() or c == "-" for c in trace)):
        raise RuntimeError("Invalid Admin Sheikh directory requestId")
    if type(data.get("asOfMs")) is not int or data["asOfMs"] <= 0:
        raise RuntimeError("Admin Sheikh directory missing source timestamp")
    rows = data.get("teachers")
    if (not isinstance(rows, list) or len(rows) > 50 or
            type(data.get("truncated")) is not bool or
            data["truncated"] and len(rows) != 50):
        raise RuntimeError("Admin Sheikh directory unbounded or inconsistent")
    ids = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != TEACHER_KEYS:
            raise RuntimeError("Admin Sheikh directory contains personal fields")
        identifier = row.get("id")
        if (not isinstance(identifier, str) or not 1 <= len(identifier) <= 128 or
                not all(c.isalnum() or c == "-" for c in identifier) or
                identifier in ids):
            raise RuntimeError("Admin Sheikh directory duplicate or invalid teacher ID")
        ids.add(identifier)
        name = row.get("name")
        if (not isinstance(name, str) or not 1 <= len(name) <= 120 or
                name != name.strip() or
                type(row.get("qualified")) is not bool or
                row.get("status") not in ("active", "disabled") or
                type(row.get("currentLearners")) is not int or
                type(row.get("upcomingLessons")) is not int or
                row["currentLearners"] < 0 or row["upcomingLessons"] < 0):
            raise RuntimeError("Admin Sheikh directory row invalid")
    if teacher_id is not None:
        matching = [row for row in rows if row["id"] == teacher_id]
        if (len(matching) != 1 or matching[0]["qualified"] is not True or
                matching[0]["status"] != "active" or
                matching[0]["currentLearners"] < min_learners):
            raise RuntimeError("Signed synthetic teacher/assignment not in directory")
    return True


def verify_signed_teacher_directory(origin, staff, teacher, teacher_id,
                                    http, require_status, json_body,
                                    min_learners=0):
    route = "/v1/staff/teachers"
    code, body, _ = http(origin, route)
    require_status(code, 401, "Anonymous Admin Sheikh directory")
    if b'"teachers"' in body:
        raise RuntimeError("Admin roster leaked anonymously")
    code, body, _ = http(origin, route, opener=teacher)
    require_status(code, 403, "Teacher cannot enumerate staff directory")
    if b'"teachers"' in body:
        raise RuntimeError("Admin roster leaked to teacher")
    code, body, headers = http(origin, route, opener=staff)
    require_status(code, 200, "Signed Admin Sheikh directory")
    assert_teacher_directory(json_body(body), teacher_id, min_learners)
    if headers.get("Cache-Control") != "no-store":
        raise RuntimeError("Signed Admin Sheikh directory is cacheable")
    code, _, _ = http(origin, route, method="POST", body={}, opener=staff)
    require_status(code, 405, "Admin Sheikh directory forbids mutation")
    print("PASS: Noor signed Dev Sheikh directory staff 200, teacher 403, anonymous 401, POST 405, no PII")


def verify_revoked_teacher_directory(origin, staff, http, require_status):
    code, body, _ = http(origin, "/v1/staff/teachers", opener=staff)
    require_status(code, 403, "Revoked Admin still reads Sheikh directory")
    if b'"teachers"' in body:
        raise RuntimeError("Revoked Admin received teacher records")
    print("PASS: Noor signed Dev revoked staff denied Sheikh directory immediately")
