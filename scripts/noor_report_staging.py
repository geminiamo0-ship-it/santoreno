"""Noor Phase 07A real remote Dev smoke, synthetic records ONLY (#256).

Called from the existing noor_private_staging.py protected synthetic staff/teacher
lifecycle. No Cloudflare secrets, no production access and no test media.
The SQL Start/End events are an explicitly synthetic acceptance fixture, NOT
proof of the real Classroom presence verification or attendance.
"""
import re
import time
from uuid import uuid4

STAGING_DB = "noor-core-staging"


def verify_report_flow(origin, database_id, owner, foreign, learner_id, other_learner,
                       teacher_id, post, http, qa_write, d1_read_only,
                       require_status, json_body, on_scheduled_lesson=None):
    if not re.fullmatch(r"[a-f0-9-]{36}", learner_id) or not re.fullmatch(r"[a-f0-9-]{36}", teacher_id):
        raise RuntimeError("Phase 07A: refused invalid synthetic identity")
    if not re.fullmatch(r"[a-f0-9-]{36}", other_learner):
        raise RuntimeError("Phase 07A: refused unrelated learner")
    if not re.fullmatch(r"[a-fA-F0-9-]{32,36}", database_id):
        raise RuntimeError("Phase 07A: staging UUID required")

    schema = d1_read_only(database_id,
                          "SELECT version FROM noor_schema_meta WHERE component='lesson_reports'")
    if len(schema) != 1 or schema[0].get("version") != 1:
        raise RuntimeError("Phase 07A migration 0013 absent; refusing report acceptance")

    owner_path = "/v1/me/learners/" + learner_id + "/reports"
    other_path = "/v1/me/learners/" + other_learner + "/reports"
    code, payload, headers = http(origin, owner_path, opener=owner)
    require_status(code, 200, "Phase 07A initial owner reports")
    if json_body(payload).get("reports") != [] or headers.get("Cache-Control") != "no-store":
        raise RuntimeError("Phase 07A new learner has unexpected report history/cache")
    for who, label in ((foreign, "foreign owner"), (None, "anonymous")):
        code, _, _ = http(origin, owner_path, opener=who)
        require_status(code, 404 if who is not None else 401, "Phase 07A " + label)
    code, _, _ = http(origin, other_path, opener=owner)
    require_status(code, 404, "Phase 07A archived sibling reports")

    # The staff booking is genuine authenticated HTTP, within the actual
    # synthetic primary assignment. Never manually seed staff permissions here.
    starts = int(time.time() * 1000) + 7000
    booking = post("/v1/staff/schedule-actions",
                   {"action": "book", "operationId": str(uuid4()),
                    "reason": "Synthetic report acceptance classroom lifecycle only",
                    "learnerId": learner_id, "teacherId": teacher_id,
                    "startsAtMs": starts, "kind": "standard"}, owner, 201)
    lesson_id = booking.get("resourceId")
    if not isinstance(lesson_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", lesson_id):
        raise RuntimeError("Phase 07A remote staff booking lacked valid lesson id")
    path = "/v1/teacher/lessons/" + lesson_id + "/report"
    action_path = path + "-actions"

    code, _, _ = http(origin, path, opener=foreign)
    require_status(code, 404, "Phase 07A report before verified END")
    code, _, _ = http(origin, action_path, method="POST", opener=foreign,
                       body={"kind": "publish", "operationId": str(uuid4()), "expectedRevision": 0})
    require_status(code, 404, "Phase 07A no report for scheduled lesson")
    # The final integrated Dev suite uses real verified teacher Start/End.
    # Legacy isolated fixture remains for offline/unit test callers.
    signed = on_scheduled_lesson(lesson_id) is True if on_scheduled_lesson else False
    if not signed:
        # Only dedicated noor-core-staging D1 is updated by guarded synthetic test.
        time.sleep(max(0.0, (starts + 750 - int(time.time() * 1000)) / 1000.0))
        started = int(time.time() * 1000)
        qa_write("UPDATE lessons SET status='live' WHERE id='" + lesson_id +
                 "' AND status='scheduled'")
        qa_write("INSERT INTO lesson_lifecycle_events(id,lesson_id,teacher_id,action,at_ms,operation_id) "
                 "VALUES('" + str(uuid4()) + "','" + lesson_id + "','" + teacher_id + "',"
                 "'start'," + str(started) + ",'" + str(uuid4()) + "')")
        ended = int(time.time() * 1000)
        qa_write("UPDATE lessons SET status='completed',ended_at_ms=" + str(ended) +
                 " WHERE id='" + lesson_id + "' AND status='live'")
        qa_write("INSERT INTO lesson_lifecycle_events(id,lesson_id,teacher_id,action,at_ms,operation_id) "
                 "VALUES('" + str(uuid4()) + "','" + lesson_id + "','" + teacher_id + "',"
                 "'end'," + str(ended) + ",'" + str(uuid4()) + "')")

    code, raw, _ = http(origin, path, opener=foreign)
    require_status(code, 200, "Phase 07A verified acting teacher report")
    seeded = json_body(raw).get("report")
    if signed and (not isinstance(seeded,dict) or seeded.get("revision")!=1
                   or seeded.get("status")!="draft"):
        raise RuntimeError("Signed End must prepare private report draft before review")
    if not signed and seeded is not None:
        raise RuntimeError("Legacy completed fixture unexpectedly has a report")
    offset = 1 if signed else 0
    code, _, _ = http(origin, path, opener=owner)
    require_status(code, 404, "Phase 07A owner cannot read teacher draft")
    code, _, _ = http(origin, path, opener=None)
    require_status(code, 401, "Phase 07A anonymous teacher read forbidden")

    note = {"scope": "Synthetic al-Fatiha scope (not Quran content)",
            "strengths": "Synthetic strength", "corrections": "Synthetic correction",
            "nextPlan": "Synthetic next review",
            "memorization": None, "recitation": 0, "tajweed": 10}
    first = {"kind": "save", "operationId": str(uuid4()), "expectedRevision": offset, **note}
    result = post(action_path, first, foreign, 200)
    if result.get("code") != "REPORT_DRAFT_SAVED" or result.get("revision") != 1+offset:
        raise RuntimeError("Phase 07A draft save ACK invalid")
    if post(action_path, first, foreign, 200).get("code") != "REPORT_ALREADY_APPLIED":
        raise RuntimeError("Phase 07A duplicate operation not idempotent")
    post(action_path, {**first, "scope": "Forged same UUID content"}, foreign, 409)
    post(action_path, {**first, "operationId": str(uuid4())}, foreign, 409)
    code, raw, _ = http(origin, owner_path, opener=owner)
    require_status(code, 200, "Phase 07A student cannot see draft")
    if json_body(raw).get("reports") != []:
        raise RuntimeError("Private draft leaked into learner reports")

    publication = {"kind": "publish", "operationId": str(uuid4()), "expectedRevision": 1+offset}
    result = post(action_path, publication, foreign, 201)
    if result.get("code") != "REPORT_PUBLISHED":
        raise RuntimeError("Phase 07A explicit publication failed")
    if post(action_path, publication, foreign, 200).get("code") != "REPORT_ALREADY_APPLIED":
        raise RuntimeError("Phase 07A publish replay failed")
    code, raw, _ = http(origin, owner_path, opener=owner)
    require_status(code, 200, "Phase 07A published owner report")
    published = json_body(raw).get("reports")
    if not isinstance(published, list) or len(published) != 1 or published[0].get("revision") != 1+offset:
        raise RuntimeError("Phase 07A missing latest approved snapshot")
    if any(published[0].get(k) != v for k, v in
           (("memorization", None), ("recitation", 0), ("tajweed", 10))):
        raise RuntimeError("Phase 07A null vs zero/ten score contract failed")

    updated = {**note, "scope": "Synthetic revised scope", "memorization": 8}
    second = {"kind": "save", "operationId": str(uuid4()), "expectedRevision": 1+offset, **updated}
    post(action_path, second, foreign, 200)
    code, raw, _ = http(origin, owner_path, opener=owner)
    require_status(code, 200, "Phase 07A previous approved survives new draft")
    history = json_body(raw).get("reports")
    if len(history) != 1 or history[0].get("revision") != 1+offset or history[0].get("scope") != note["scope"]:
        raise RuntimeError("Phase 07A unapproved revision leaked to learner")
    post(action_path, {"kind": "publish", "operationId": str(uuid4()),
                       "expectedRevision": 2+offset}, foreign, 201)
    code, raw, _ = http(origin, owner_path, opener=owner)
    require_status(code, 200, "Phase 07A latest report changed")
    latest = json_body(raw).get("reports")
    if len(latest) != 1 or latest[0].get("revision") != 2+offset or latest[0].get("memorization") != 8:
        raise RuntimeError("Phase 07A learner does not see only latest approval")
    count = d1_read_only(database_id,
                         "SELECT COUNT(*) AS n FROM lesson_report_publications WHERE lesson_id='" +
                         lesson_id + "'")
    if len(count) != 1 or count[0].get("n") != 2:
        raise RuntimeError("Phase 07A immutable revision history lost")
    code, _, _ = http(origin, owner_path, opener=foreign)
    require_status(code, 404, "Phase 07A foreign owner cannot access approved reports")
    print("PASS: Noor remote Phase 07A completed synthetic END, draft/private, publish, "
          "replay 200, conflict 409, prior approved and latest-only, foreign 404")
    return lesson_id
