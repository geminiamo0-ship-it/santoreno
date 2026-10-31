#!/usr/bin/env python3
"""#295 Dev-only, one-shot owner manual QA lesson: no Production, no CI cleanup.

The two test accounts must ALREADY exist with password credentials. Only
pre-approved synthetic phone fingerprints match; no phone/password is logged.
The authorized Github Actions operator directly seeds a synthetic Dev
teacher/assignment/lesson after checking D1 ownership and guards. Never
reuse this entry point for production or real learners.
"""
import hashlib
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from uuid import uuid4

DB = "noor-core-staging"
WORKER = "noor-site-staging"
OWNER_HASH = "f043236099dc6f3539ad6fc5ec3bff08ec2d5310d134b2c6ae08b92551cd66ff"
SHEIKH_HASH = "b94f5193ca2605d95976fbe52619b49fbd2101f515c374a7c7fb8fe1d0c19766"
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
HEX_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\\Z")
UUID = re.compile(r"[0-9a-f-]{36}\\Z")

def fail(reason):
    raise RuntimeError("NOOR_OWNER_DEV_LESSON: " + reason)

def api(path, payload=None):
    url = "https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT + path
    headers = {"Authorization": "Bearer " + TOKEN,
               "Content-Type": "application/json", "Accept": "application/json"}
    req = urllib.request.Request(url, headers=headers,
          data=json.dumps(payload).encode() if payload is not None else None,
          method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.load(resp)
    except Exception:
        fail("CLOUDFLARE_REQUEST_FAILED")  # do not leak API payload/headers
    if not isinstance(body, dict) or body.get("success") is not True:
        fail("CLOUDFLARE_REJECTED")
    return body["result"]

def query(dbid, sql, params=None):
    raw = api("/d1/database/" + dbid + "/query",
              {"sql": sql, "params": params or []})
    if not isinstance(raw, list) or len(raw) != 1 or not raw[0].get("success"):
        fail("D1_QUERY_FAILED")
    data = raw[0].get("results")
    if not isinstance(data, list):
        fail("D1_INVALID_RESPONSE")
    return data

def scalar_id(value, title):
    if not isinstance(value, str) or not HEX_ID.fullmatch(value):
        fail("INVALID_" + title)
    return value

def db_id():
    result = api("/d1/database")
    rows = result if isinstance(result, list) else result.get("results", [])
    matches = [x for x in rows if x.get("name") == DB]
    if len(matches) != 1:
        fail("EXACT_STAGING_DATABASE_NOT_FOUND")
    value = matches[0].get("uuid") or matches[0].get("id")
    if not isinstance(value, str) or not UUID.fullmatch(value) or set(value.replace("-", "")) == {"0"}:
        fail("INVALID_STAGING_DB_UUID")
    return value

def match_existing(rows, fingerprint):
    matches = [x for x in rows if isinstance(x.get("phone_number"), str) and
               hashlib.sha256(x["phone_number"].strip().encode()).hexdigest() == fingerprint]
    if len(matches) != 1:
        fail("EXPECTED_SYNTHETIC_ACCOUNT_NOT_FOUND_OR_AMBIGUOUS")
    return matches[0]

def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")

def main():
    if os.environ.get("NOOR_OWNER_QA_ONLY") != "true":
        fail("EXPLICIT_DEV_FLAG_REQUIRED")
    if os.environ.get("NOOR_SHA", "") != "acdd869ac596edb4019bf453d8b1ccf6f56c5c51":
        fail("EXPECTED_NOOR_MAIN_SHA_MISMATCH")
    if os.environ.get("GITHUB_REPOSITORY") != "geminiamo0-ship-it/santoreno":
        fail("UNTRUSTED_REPOSITORY")
    db = db_id()
    if query(db, "SELECT version FROM noor_schema_meta WHERE component=?", ["staff_schedule"]) != [{"version": 1}]:
        fail("STAFF_SCHEDULE_SCHEMA_NOT_READY")
    people = query(db, """SELECT u.id, u.phone_number, a.id AS account_id,
                          a.status AS account_status FROM auth_users u
                          JOIN accounts a ON a.auth_subject=u.id
                          WHERE u.phone_number IS NOT NULL""")
    owner = match_existing(people, OWNER_HASH)
    sheikh = match_existing(people, SHEIKH_HASH)
    if owner["id"] == sheikh["id"] or owner["account_status"] != "active" or sheikh["account_status"] != "active":
        fail("SYNTHETIC_ACTOR_IDENTITY_OR_STATUS_INVALID")
    owner_id = scalar_id(owner["id"], "OWNER")
    teacher_subject = scalar_id(sheikh["id"], "SHEIKH")
    if not query(db, "SELECT 1 AS ok FROM auth_credentials WHERE user_id=? AND password IS NOT NULL LIMIT 1",
                 [owner_id]) or not query(db, "SELECT 1 AS ok FROM auth_credentials WHERE user_id=? AND password IS NOT NULL LIMIT 1",
                 [teacher_subject]):
        fail("EXISTING_TEST_ACCOUNT_HAS_NO_PASSWORD_LOGIN")
    learners = query(db, """SELECT l.id FROM learners l JOIN accounts a
                     ON l.account_id=a.id
                     WHERE a.auth_subject=? AND l.status='active'
                     ORDER BY l.created_at_ms, l.id""", [owner_id])
    if len(learners) != 1:
        fail("EXACTLY_ONE_ACTIVE_SYNTHETIC_LEARNER_REQUIRED")
    learner_id = scalar_id(learners[0]["id"], "LEARNER")
    teachers = query(db, "SELECT id,qualified,status FROM teachers WHERE auth_subject=?", [teacher_subject])
    if len(teachers) > 1:
        fail("AMBIGUOUS_SHEIKH_ROLE")
    if teachers:
        t = teachers[0]
        if t["qualified"] != 1 or t["status"] != "active":
            fail("SHEIKH_ROLE_DISABLED_OR_UNQUALIFIED__REQUIRES_ADMIN_APPROVAL")
        teacher_id = scalar_id(t["id"], "TEACHER_ID")
    else:
        # Synthetic, named test account only. Scoped operator bootstrap,
        # no temporary staff grant and no unverified public role endpoint.
        teacher_id = str(uuid4())
        query(db, """INSERT INTO teachers(id,auth_subject,qualified,status)
                     VALUES(?,?,1,'active')""", [teacher_id, teacher_subject])

    # Reuse an eligible existing scheduled session: reruns must never double-book.
    now = int(time.time() * 1000)
    recent = query(db, """SELECT id,starts_at_ms,ends_at_ms FROM lessons
                WHERE learner_id=? AND actual_teacher_id=? AND status='scheduled'
                AND starts_at_ms>? AND starts_at_ms<?
                ORDER BY starts_at_ms LIMIT 2""",
                [learner_id, teacher_id, now - 5 * 60_000, now + 3 * 60 * 60_000])
    if len(recent) > 1:
        fail("MULTIPLE_UPCOMING_OWNER_TEST_LESSONS")
    if recent:
        lesson_id = scalar_id(recent[0]["id"], "LESSON_ID")
        start = int(recent[0]["starts_at_ms"])
        end = int(recent[0]["ends_at_ms"])
        result = "REUSED_EXISTING"
    else:
        # Start after this workflow finishes; no automatic Start or End.
        start = ((now + 35 * 60_000 + 299999) // 300000) * 300000
        end = start + 40 * 60_000
        grants = query(db, """SELECT id,teacher_id,starts_at_ms,ends_at_ms FROM teacher_assignments
             WHERE learner_id=? AND revoked_at_ms IS NULL
               AND starts_at_ms<? AND ends_at_ms>?""",
             [learner_id, end, start])
        if grants:
            if len(grants) != 1 or grants[0]["teacher_id"] != teacher_id or (
               int(grants[0]["starts_at_ms"]) > start or int(grants[0]["ends_at_ms"]) < end):
                fail("CONFLICTING_TEACHER_ASSIGNMENT")
        else:
            query(db, """INSERT INTO teacher_assignments(
                       id,learner_id,teacher_id,starts_at_ms,ends_at_ms)
                       VALUES(?,?,?,?,?)""",
                       [str(uuid4()), learner_id, teacher_id, now + 60_000,
                        end + 30 * 60_000])
        lesson_id = str(uuid4())
        # Native D1 scheduling triggers validate teacher/learner, 40-minute
        # slot and conflicts; NO direct live state, fake Start/End, or media.
        query(db, """INSERT INTO lessons(id,learner_id,actual_teacher_id,kind,status,
                    starts_at_ms,ends_at_ms)
                    VALUES(?,?,?,'standard','scheduled',?,?)""",
                    [lesson_id, learner_id, teacher_id, start, end])
        result = "CREATED_NEW"

    checked = query(db, """SELECT id,learner_id,actual_teacher_id,status,starts_at_ms,
                           ends_at_ms FROM lessons WHERE id=?""", [lesson_id])
    if len(checked) != 1 or checked[0]["learner_id"] != learner_id or (
      checked[0]["actual_teacher_id"] != teacher_id or checked[0]["status"] != "scheduled" or
      checked[0]["starts_at_ms"] != start or checked[0]["ends_at_ms"] != end):
        fail("SIGNED_LESSON_D1_READBACK_FAILED")
    subdomain = api("/workers/subdomain").get("subdomain")
    if not isinstance(subdomain, str) or not re.fullmatch(r"[a-z0-9-]+", subdomain):
        fail("CANNOT_VERIFY_WORKER_SUBDOMAIN")
    base = "https://" + WORKER + "." + subdomain + ".workers.dev"
    teacher_url = base + "/classroom/live?role=teacher&lessonId=" + lesson_id
    learner_url = base + "/classroom/live?role=learner&lessonId=" + lesson_id + "&learnerId=" + learner_id
    summary = ("### Noor signed Dev owner-QA lesson #295\n\n"
               + "- Result: **" + result + "** (D1 readback verified)\n"
               + "- Start UTC: **" + iso(start) + "** (Cairo +02:00)\n"
               + "- End UTC: **" + iso(end) + "**\n"
               + "- Sheikh: " + teacher_url + "\n"
               + "- Learner: " + learner_url + "\n"
               + "- Existing test logins were located by fingerprint, but passwords were not read/verified.\n"
               + "- No passwords, cookies, real learner data, media, production or automatic Start/End.\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
        fh.write(summary)
    print("PASS: NOOR_OWNER_QA_LESSON_" + result)
    print("LESSON_ID=" + lesson_id)
    print("LEARNER_ID=" + learner_id)
    print("START_UTC=" + iso(start))
    print("TEACHER_LINK=" + teacher_url)
    print("LEARNER_LINK=" + learner_url)

if __name__ == "__main__":
    main()
