#!/usr/bin/env python3
"""Provision ONLY Noor's isolated private Cloudflare staging with synthetic QA.
Runs inside santoreno Actions to reuse its encrypted Cloudflare credentials.
Never touches Santo or Noor production resources, never logs secrets.
"""
import base64
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path.cwd()
NOOR = ROOT / "noor"
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
NOOR_SHA = os.environ["NOOR_SHA"]
DATABASE_NAME = "noor-core-staging"
WORKER_NAME = "noor-site-staging"
WRANGLER = ["npx", "--yes", "wrangler@4.45.0"]


def wrangler(*args):
    result = subprocess.run(WRANGLER + list(args), cwd=NOOR, text=True,
                            capture_output=True, check=False)
    if result.returncode:
        # Do not propagate raw environment, command-line credentials or response bodies.
        raise RuntimeError(f"Wrangler operation failed: {args[0:2]} (exit {result.returncode}); "
                           f"stderr tail: {result.stderr[-900:]}")
    return result.stdout


def names_of_deployed_staging_secrets(config):
    """Read metadata only; preserve signing credentials across a Dev refresh.

    Wrangler returns names and types, never secret values. Refuse an
    unexpected response instead of rotating a live signing key blindly.
    """
    if WORKER_NAME != "noor-site-staging" or DATABASE_NAME != "noor-core-staging":
        raise RuntimeError("Refusing secret read outside Noor isolated Dev")
    listed = json.loads(wrangler("secret", "list", "--config", str(config)))
    if not isinstance(listed, list):
        raise RuntimeError("Unexpected Cloudflare secret metadata")
    names = set()
    for item in listed:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise RuntimeError("Invalid Cloudflare secret metadata")
        names.add(item["name"])
    return names


def select_missing_staging_secrets(candidate, existing_names):
    """Only initialize absent secrets; never rotate active Dev login sessions."""
    allowed = {"AUTH_SECRET", "STAGING_ACCESS_PASSWORD"}
    if set(candidate) != allowed or not all(
        isinstance(value, str) and len(value) >= 32 for value in candidate.values()
    ):
        raise RuntimeError("Unexpected staging secret bootstrap payload")
    if not isinstance(existing_names, set) or not all(
        isinstance(name, str) for name in existing_names
    ):
        raise RuntimeError("Unexpected existing secret names")
    return {key: value for key, value in candidate.items() if key not in existing_names}


def cloudflare_subdomain():
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/subdomain",
        headers={"Authorization": "Bearer " + TOKEN, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=25) as response:
        data = json.load(response)
    subdomain = data.get("result", {}).get("subdomain")
    if not data.get("success") or not isinstance(subdomain, str) or not re.fullmatch(r"[a-z0-9-]+", subdomain):
        raise RuntimeError("Missing valid Cloudflare workers.dev subdomain")
    return subdomain


def staging_database():
    listed = json.loads(wrangler("d1", "list", "--json"))
    databases = listed if isinstance(listed, list) else listed.get("results", listed.get("databases", []))
    matching = [item for item in databases if item.get("name") == DATABASE_NAME]
    if len(matching) > 1:
        raise RuntimeError("Duplicate staging D1 name")
    if not matching:
        wrangler("d1", "create", DATABASE_NAME)
        listed = json.loads(wrangler("d1", "list", "--json"))
        databases = listed if isinstance(listed, list) else listed.get("results", listed.get("databases", []))
        matching = [item for item in databases if item.get("name") == DATABASE_NAME]
    if len(matching) != 1:
        raise RuntimeError("Cannot identify dedicated Noor staging D1")
    database_id = matching[0].get("uuid") or matching[0].get("id") or matching[0].get("database_id")
    if not isinstance(database_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{32,36}", database_id) or set(database_id.replace("-", "")) == {"0"}:
        raise RuntimeError("Refusing missing/local-only D1 identifier")
    return database_id


def write_config(target, database_id, origin, access_password, auth_secret):
    cfg = json.loads((NOOR / "wrangler.jsonc").read_text())
    if not (NOOR / "workers/site/src/staging-access.ts").is_file():
        raise RuntimeError("Noor staging guard missing")
    cfg.pop("previews", None)
    cfg.update(name=WORKER_NAME, workers_dev=True, preview_urls=False)
    cfg["main"] = str(NOOR / "workers/site/src/index.ts")
    cfg["assets"]["directory"] = str(NOOR / "apps/web/out")
    # Essential: an assets-only request must never bypass the staging gate.
    cfg["assets"]["run_worker_first"] = True
    cfg["d1_databases"] = [{
        "binding": "DB", "database_name": DATABASE_NAME, "database_id": database_id,
        "migrations_dir": str(NOOR / "workers/api/migrations"),
    }]
    # Only the Noor developer Worker, never its Production binding.
    # Pinned Wrangler 4.45 supports new_sqlite_classes legacy migrations.
    if WORKER_NAME != "noor-site-staging" or DATABASE_NAME != "noor-core-staging":
        raise RuntimeError("Refusing Classroom DO outside the isolated Noor Dev worker")
    cfg["durable_objects"] = {"bindings": [
        {"name": "LESSON_ROOMS", "class_name": "LessonRoom"},
    ]}
    cfg["migrations"] = [{"tag":"noor-classroom-sqlite-v1",
                           "new_sqlite_classes":["LessonRoom"]}]
    cfg["vars"] = {
        "NOOR_ENVIRONMENT": "staging", "NOOR_DEV_OPEN": "true",
        "AUTH_ENABLED": "true", "AUTH_ORIGIN": origin,
        # DEV ONLY: independently gated teacher/learner signed live ink & realtime.
        "NOOR_REALTIME_HINTS_ENABLED": "true",
        # #327: only the existing isolated Noor Dev Worker.
        "NOOR_ADMIN_PORTAL_ENABLED": "true",
        "NOOR_CUMULATIVE_INK_ENABLED": "true",
    }
    config = target / "wrangler-staging.json"
    config.write_text(json.dumps(cfg, ensure_ascii=False))
    secure = target / "secrets.json"
    secure.write_text(json.dumps({"AUTH_SECRET": auth_secret, "STAGING_ACCESS_PASSWORD": access_password}))
    secure.chmod(0o600)
    return config, secure


def http(origin, path, secret=None, method="GET", body=None, opener=None, max_bytes=1024 * 128):
    # A browser-like User-Agent avoids Cloudflare edge filtering Python's
    # default urllib user agent; this is synthetic QA, never real user data.
    headers = {"Accept": "application/json",
               "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0.0.0 Safari/537.36"}
    if secret is not None:
        token = base64.b64encode(("noor-preview:" + secret).encode()).decode()
        headers["Authorization"] = "Basic " + token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
        headers["Origin"] = origin
    request = urllib.request.Request(origin + path, headers=headers, method=method, data=data)
    client = opener or urllib.request.build_opener()
    try:
        with client.open(request, timeout=25) as response:
            return response.status, response.read(max_bytes), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(max_bytes), error.headers


def require_status(status, expected, label):
    if status != expected:
        raise RuntimeError(f"{label}: expected HTTP {expected}, got {status}")


def json_body(content):
    return json.loads(content.decode())


def verify_signed_marked_homework(origin, database_id, owner, teacher, learner_id,
                                   foreign_learner, edition, teacher_tasks,
                                   owner_tasks, post):
    """Owner QA #284: synthetic signed Dev draft -> publish -> learner projection."""
    from uuid import uuid4
    metadata = d1_read_only(database_id,
        "SELECT version FROM noor_schema_meta WHERE component='teacher_assignment_drafts'")
    if metadata != [{"version":1}]:
        raise RuntimeError("Dev D1 teacher ink draft migration 0018 missing")
    drafts="/v1/teacher/learners/"+learner_id+"/assignment-drafts"
    code,body,_=http(origin,drafts,opener=teacher)
    require_status(code,200,"Teacher signed private drafts GET")
    if json_body(body).get("drafts")!=[]:
        raise RuntimeError("Synthetic student already has Sheikh drafts")
    code,body,_=http(origin,
        "/v1/teacher/learners/"+learner_id+
        "/assignment-page-range?editionId=hafs-kfqc%3Av1.1.1&surah=1&fromAyah=1&toAyah=7",
        opener=teacher)
    require_status(code,200,"Signed Quran homework range")
    if json_body(body).get("startPage")!=1 or json_body(body).get("endPage")!=1:
        raise RuntimeError("Sheikh Quran homework range mismatch")
    marks=[
      {"id":"mk-"+uuid4().hex,"kind":"highlight","page":1,
       "surah":1,"ayah":1,"payload":{"color":"#d0a94c"}},
      {"id":"mk-"+uuid4().hex,"kind":"pen","page":1,"surah":None,"ayah":None,
       "payload":{"color":"#d0a94c","width":3,
                  "points":[{"x":120,"y":220},{"x":140,"y":235}]}}
    ]
    draft_id=str(uuid4())
    task={"kind":"revision","editionId":edition,"surah":1,"fromAyah":1,
          "toAyah":7,"dueAtMs":int(time.time()*1000)+86400000,
          "instructions":"Synthetic marked Quran review, no child data"}
    draft={**task,"draftId":draft_id,"revision":1,"marks":marks}
    status,raw,_=http(origin,drafts,method="POST",body=draft,opener=teacher)
    if status!=201:
        # Only static machine-readable error classes, never runtime SQL,
        # user credentials, request IDs, cookie values or marker coordinates.
        response=json_body(raw) if raw else {}
        code=response.get("code") if isinstance(response,dict) else None
        reason=response.get("reason") if isinstance(response,dict) else None
        allowed_codes={"DRAFT_STORAGE_UNAVAILABLE","DRAFT_WRITE_REJECTED",
                       "DRAFT_SCHEMA_NOT_READY","INVALID_DRAFT"}
        allowed_reasons={"D1_JSON","D1_SCHEMA","D1_CONSTRAINT",
                         "D1_NETWORK","D1_UNKNOWN"}
        safe_code=code if code in allowed_codes else "OTHER"
        safe_reason=reason if reason in allowed_reasons else "UNCLASSIFIED"
        raise RuntimeError("Sheikh marked homework save HTTP "+str(status)+
                           " code="+safe_code+" reason="+safe_reason)
    result=json_body(raw)
    if (result.get("code")!="DRAFT_SAVED" or
            result.get("draft",{}).get("revision")!=1 or
            len(result.get("draft",{}).get("marks",[]))!=2):
        raise RuntimeError("Private Sheikh draft marks not committed")
    if post(drafts,draft,teacher,200).get("code")!="DRAFT_ALREADY_SAVED":
        raise RuntimeError("Sheikh draft replay not idempotent")
    code,body,_=http(origin,drafts,opener=teacher)
    require_status(code,200,"Sheikh ink draft reload")
    if not any(x.get("draftId")==draft_id and len(x.get("marks",[]))==2
               for x in json_body(body).get("drafts",[])):
        raise RuntimeError("Sheikh draft ink not visible after refresh")
    code,_,_=http(origin,drafts,opener=owner)
    require_status(code,404,"Owner must not read unpublished Sheikh draft")
    code,_,_=http(origin,
        "/v1/teacher/learners/"+foreign_learner+"/assignment-drafts",opener=teacher)
    require_status(code,404,"Unassigned learner draft denied")
    owner_page="/v1/me/learners/"+learner_id+"/cumulative-quran?page=1"
    code,body,_=http(origin,owner_page,opener=owner)
    require_status(code,200,"Owner initial cumulative Quran page")
    if any(x.get("originType")=="assignment" for x in json_body(body).get("current",[])):
        raise RuntimeError("Private Sheikh draft leaked before publication")
    task_id=post(teacher_tasks,{**task,"draftId":draft_id,"operationId":str(uuid4())},
                 teacher,201).get("assignmentId")
    if not isinstance(task_id,str) or not re.fullmatch(r"[0-9a-fA-F-]{36}",task_id):
        raise RuntimeError("Marked task publication lacks verified assignment ID")
    code,body,_=http(origin,owner_tasks,opener=owner)
    require_status(code,200,"Owner marked assignment list")
    if not any(row.get("id")==task_id for row in json_body(body).get("assignments",[])):
        raise RuntimeError("Marked task missing from published learner training")
    code,body,_=http(origin,owner_page,opener=owner)
    require_status(code,200,"Owner global Quran with published Sheikh ink")
    visible=[x for x in json_body(body).get("current",[])
             if x.get("originType")=="assignment" and x.get("originId")==task_id]
    if len(visible)!=2 or {m.get("kind") for m in visible}!={"pen","highlight"}:
        raise RuntimeError("Published Sheikh marks not projected into global Mushaf")
    code,body,_=http(origin,drafts,opener=teacher)
    require_status(code,200,"Published draft removed from private editing")
    if any(x.get("draftId")==draft_id for x in json_body(body).get("drafts",[])):
        raise RuntimeError("Published Sheikh draft still editable")
    code,_,_=http(origin,owner_page,opener=teacher)
    require_status(code,404,"Foreign household cannot read learner Quran")
    print("PASS: Noor Dev signed Sheikh pen+highlight draft/replay, publish, global learner Quran marks and sibling isolation")


def verify_dev_trial_slot_withdrawal(origin, database_id, staff, guardian,
                                     foreign_owner, learner_id, teacher_id):
    """#244: signed isolated DEV 0024 withdrawal test; never Prod or real child data.

    Exercises actual HTTPS session routes plus read-only D1 auditing. A booked
    40-minute trial must survive a denied staff withdrawal; only an explicit
    authenticated owner cancellation releases its advertised slot.
    """
    from uuid import uuid4
    if DATABASE_NAME != "noor-core-staging" or WORKER_NAME != "noor-site-staging":
        raise RuntimeError("Trial withdrawal QA must use isolated Noor Dev")
    schema=d1_read_only(database_id,
        "SELECT version FROM noor_schema_meta WHERE component='trial_slot_close_booking_guard'")
    if schema != [{"version":1}]:
        raise RuntimeError("Dev D1 booked-trial guard 0024 not applied")
    now=int(time.time()*1000)
    begins=now+26*3600000
    trial_root="/v1/me/learners/"+learner_id
    def call(path,method="GET",body=None,opener=None,expect=200):
        status,raw,_=http(origin,path,method=method,body=body,opener=opener)
        require_status(status,expect,"Signed Noor trial slot QA")
        return json_body(raw)
    # The Sheikh is qualified and activated in the standard synthetic role
    # setup; staff can open a future slot but browser never chooses the Sheikh.
    slot=call("/v1/staff/trial-slots","POST",
        {"operationId":str(uuid4()),"teacherId":teacher_id,
         "startsAtMs":begins},staff,201).get("slotId")
    if not isinstance(slot,str) or not re.fullmatch(r"[0-9a-f-]{36}",slot):
        raise RuntimeError("Synthetic staff publication lacked real slot ID")
    avail=call(trial_root+"/trial-slots",opener=guardian)
    if not avail.get("eligible") or not any(v.get("slotId")==slot for v in avail.get("slots",[])):
        raise RuntimeError("New signed Dev trial slot not available to guardian")
    call(trial_root+"/trial-slots",opener=foreign_owner,expect=404)
    booked=call(trial_root+"/trial-bookings","POST",
        {"operationId":str(uuid4()),"slotId":slot},guardian,201)
    lesson=booked.get("lessonId")
    if not isinstance(lesson,str) or not re.fullmatch(r"[0-9a-f-]{36}",lesson):
        raise RuntimeError("Synthetic guardian booking lacks confirmed lesson")
    # A live first-trial booking must revoke eligibility before cancellation.
    booked_availability=call(trial_root+"/trial-slots",opener=guardian)
    if booked_availability.get("eligible") is not False or booked_availability.get("slots")!=[]:
        raise RuntimeError("Booked first trial still appeared rebookable to guardian")
    close_url="/v1/staff/trial-slots/"+slot+"/close"
    denied=call(close_url,"POST",
        {"operationId":str(uuid4()),"reason":"Synthetic booked-slot withdrawal denial"},
        staff,409)
    if denied.get("code")!="TRIAL_SLOT_CLOSE_DENIED":
        raise RuntimeError("Booked trial withdrawal did not use denied outcome")
    # Only synthetic UUIDs obtained through signed responses are included.
    # This D1 query is READ ONLY and confirms the committed booking survived.
    committed=d1_read_only(database_id,
      "SELECT l.status AS status, (SELECT COUNT(*) FROM trial_slot_closure_events "
      "c WHERE c.slot_id='"+slot+"') AS closures "
      "FROM lessons l WHERE l.id='"+lesson+"'")
    if committed!=[{"status":"scheduled","closures":0}]:
        raise RuntimeError("Denied staff withdrawal changed booked lesson or closure history")
    call(trial_root+"/trial-cancellations","POST",
        {"operationId":str(uuid4()),"lessonId":lesson},guardian,201)
    # Read authoritative signed D1 eligibility BEFORE staff can withdraw slot.
    released=call(trial_root+"/trial-slots",opener=guardian)
    if released.get("eligible") is not True or not any(
            row.get("slotId")==slot for row in released.get("slots",[])):
        raise RuntimeError("Confirmed cancellation did not restore signed trial rebooking")
    closed=call(close_url,"POST",
        {"operationId":str(uuid4()),"reason":"Synthetic closure after owner cancellation"},
        staff,200)
    if closed.get("code")!="TRIAL_SLOT_CLOSED":
        raise RuntimeError("Post-cancellation staff closure was not confirmed")
    final=d1_read_only(database_id,
      "SELECT l.status AS status,(SELECT COUNT(*) FROM trial_slot_closure_events "
      "c WHERE c.slot_id='"+slot+"') AS closures "
      "FROM lessons l WHERE l.id='"+lesson+"'")
    if final!=[{"status":"cancelled","closures":1}]:
        raise RuntimeError("Trial cancellation did not precede authorized slot closure")
    denied=call(trial_root+"/trial-bookings","POST",
        {"operationId":str(uuid4()),"slotId":slot},guardian,409)
    if denied.get("code")!="TRIAL_SLOT_UNAVAILABLE":
        raise RuntimeError("Withdrawn trial slot still allowed another booking")
    print("PASS: signed Noor Dev 0024 booked trial withdrawal denied; cancel restored owner rebooking eligibility, staff closure, foreign 404")


def verify_dev_trial_atomic_reschedule(origin, database_id, staff, guardian,
                                       other_owner, learner_id, teacher_id):
    """#244: signed Dev migration 0025 acceptance, only if Noor main contains 0025.

    Always require remote schema when the source includes the migration.
    An older main source explicitly SKIPs, never misreports 0025 acceptance.
    """
    source = NOOR / "workers/api/migrations/0025_trial_owner_reschedule.sql"
    if not source.is_file():
        print("SKIP: Noor main has no 0025 atomic trial replacement; no remote test claimed")
        return False
    if DATABASE_NAME != "noor-core-staging" or WORKER_NAME != "noor-site-staging":
        raise RuntimeError("Trial replacement QA restricted to isolated Noor Dev")
    from uuid import uuid4
    marker=d1_read_only(database_id,
        "SELECT version FROM noor_schema_meta WHERE component='trial_owner_reschedule'")
    if marker!=[{"version":1}]:
        raise RuntimeError("Noor main includes 0025 but Dev D1 reschedule schema is missing")
    def signed(path,actor,method="GET",payload=None,expected=200):
        status,body,_=http(origin,path,method=method,body=payload,opener=actor)
        require_status(status,expected,"Signed atomic trial replacement Dev")
        return json_body(body)
    def request_uuid(value):
        if not isinstance(value,str) or not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}",value,re.I):
            raise RuntimeError("Synthetic trial reply contained invalid UUID")
        return value
    root="/v1/me/learners/"+learner_id
    # Synthetic Teacher and Guardian are distinct signed sessions from the
    # existing staging setup; only the account owner may mutate this learner.
    now=int(time.time()*1000)
    slots=[]
    old_id=None
    other_id=None
    new_id=None
    other_learner=None
    try:
        for hours in (30,32,34):
            result=signed("/v1/staff/trial-slots",staff,"POST",
                 {"operationId":str(uuid4()),"teacherId":teacher_id,
                  "startsAtMs":now+hours*3600000},201)
            slots.append(request_uuid(result.get("slotId")))
        child=signed("/v1/me/learners",other_owner,"POST",
                 {"name":"Synthetic Reschedule Other Household","learnerType":"child"},201)
        other_learner=child.get("learner",{}).get("id")
        if not isinstance(other_learner,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}",other_learner):
            raise RuntimeError("Foreign synthetic account learner missing")
        old_id=request_uuid(signed(root+"/trial-bookings",guardian,"POST",
            {"operationId":str(uuid4()),"slotId":slots[0]},201).get("lessonId"))
        other_id=request_uuid(signed("/v1/me/learners/"+other_learner+
            "/trial-bookings",other_owner,"POST",
            {"operationId":str(uuid4()),"slotId":slots[1]},201).get("lessonId"))
        alternatives=signed(root+"/trial-reschedule-slots?lessonId="+old_id,guardian)
        allowed={x.get("slotId") for x in alternatives.get("slots",[])}
        if (alternatives.get("code")!="TRIAL_RESCHEDULE_SLOTS"
            or slots[0] in allowed or slots[1] in allowed or slots[2] not in allowed):
            raise RuntimeError("Owner replacement availability did not enforce occupancy")
        signed(root+"/trial-reschedule-slots?lessonId="+old_id,other_owner,expected=404)
        denied=signed(root+"/trial-reschedules",other_owner,"POST",
               {"operationId":str(uuid4()),"oldLessonId":old_id,"slotId":slots[2]},404)
        if denied.get("code")!="NOT_FOUND":
            raise RuntimeError("Other owner was not denied a trial reschedule")
        attempt=signed(root+"/trial-reschedules",guardian,"POST",
               {"operationId":str(uuid4()),"oldLessonId":old_id,"slotId":slots[1]},409)
        if attempt.get("code")!="TRIAL_RESCHEDULE_UNAVAILABLE":
            raise RuntimeError("Occupied alternative was not denied atomically")
        # Read committed remote D1, not UI optimistic state or a mocked SQLite.
        before=d1_read_only(database_id,
            "SELECT (SELECT status FROM lessons WHERE id='"+old_id+
            "') AS old_status, (SELECT status FROM lessons WHERE id='"+other_id+
            "') AS other_status, (SELECT COUNT(*) FROM trial_owner_reschedule_events "
            "WHERE old_lesson_id='"+old_id+"') AS replacements")
        if before!=[{"old_status":"scheduled","other_status":"scheduled","replacements":0}]:
            raise RuntimeError("Denied reschedule altered original/foreign booked lessons")
        op=str(uuid4())
        command={"operationId":op,"oldLessonId":old_id,"slotId":slots[2]}
        receipt=signed(root+"/trial-reschedules",guardian,"POST",command,201)
        new_id=request_uuid(receipt.get("lessonId"))
        if receipt.get("code")!="TRIAL_RESCHEDULED":
            raise RuntimeError("Replacement did not return committed result")
        replay=signed(root+"/trial-reschedules",guardian,"POST",command,200)
        if replay.get("code")!="TRIAL_RESCHEDULE_REPLAY" or replay.get("lessonId")!=new_id:
            raise RuntimeError("Idempotent trial replacement replay mismatch")
        conflict=signed(root+"/trial-reschedules",guardian,"POST",
            {**command,"slotId":slots[0]},409)
        if conflict.get("code")!="TRIAL_OPERATION_CONFLICT":
            raise RuntimeError("Modified operation ID reused as a new reschedule")
        # Even if the other household steals the exact operation ID, it
        # cannot replay the successful receipt or mutate the learner.
        foreign_replay=signed(root+"/trial-reschedules",other_owner,"POST",command,404)
        if foreign_replay.get("code")!="NOT_FOUND":
            raise RuntimeError("Foreign owner replay exposed private booking")
        # A second fresh operation against the *cancelled* old lesson is
        # forbidden: cancellation and replacement must be one-time and atomic.
        stale=signed(root+"/trial-reschedules",guardian,"POST",
            {**command,"operationId":str(uuid4())},404)
        if stale.get("code")!="NOT_FOUND":
            raise RuntimeError("Already replaced trial was reusable")
        completed=d1_read_only(database_id,
            "SELECT (SELECT status FROM lessons WHERE id='"+old_id+
            "') AS old_status, (SELECT status FROM lessons WHERE id='"+new_id+
            "') AS new_status, (SELECT status FROM lessons WHERE id='"+other_id+
            "') AS other_status, (SELECT COUNT(*) FROM trial_owner_reschedule_events "
            "WHERE old_lesson_id='"+old_id+"') AS replacements, "
            "(SELECT COUNT(*) FROM teacher_assignments g "
            "JOIN trial_booking_auto_grants a ON a.assignment_id=g.id "
            "JOIN trial_booking_events b ON b.id=a.booking_id "
            "WHERE b.lesson_id='"+old_id+"' AND g.revoked_at_ms IS NOT NULL) AS revoked, "
            "(SELECT COUNT(*) FROM teacher_assignments g "
            "JOIN trial_booking_auto_grants a ON a.assignment_id=g.id "
            "JOIN trial_booking_events b ON b.id=a.booking_id "
            "WHERE b.lesson_id='"+new_id+"' AND g.revoked_at_ms IS NULL) AS active, "
            "(SELECT ends_at_ms-starts_at_ms FROM lessons "
            "WHERE id='"+new_id+"') AS reserved_ms")
        if completed!=[{"old_status":"cancelled","new_status":"scheduled",
                        "other_status":"scheduled","replacements":1,"revoked":1,"active":1,
                        "reserved_ms":2400000}]:
            raise RuntimeError("Replacement D1 audit/grant/foreign isolation inconsistent")
        print("PASS: Noor Dev 0025 signed atomic trial replace 201, replay 200, conflict 409, original rollback, foreign 404, proper grant revocation")
        return True
    finally:
        # Only confirmed synthetic IDs are ever sent to signed owner
        # cancellation; no staff override, direct SQL deletion, or real child.
        for account,path,lesson in (
            (guardian,root, new_id or old_id),
            (other_owner,"/v1/me/learners/"+(other_learner or ""),other_id)):
            if lesson and (account is guardian or other_learner):
                try:
                    status,_,_=http(origin,path+"/trial-cancellations",method="POST",
                           body={"operationId":str(uuid4()),"lessonId":lesson},opener=account)
                    if status not in (200,201):
                        raise RuntimeError("Synthetic future trial cleanup denied")
                except Exception:
                    # Do not suppress a failing acceptance; existing staff
                    # role cleanup in plan_stage_synthetic_smoke still runs.
                    print("WARNING: synthetic trial cancellation cleanup needs inspection")


def verify_dev_subscription_ledger_read(origin, database_id, owner, foreign_owner,
                                        active_learner, archived_sibling):
    """#244 source-gated, signed, read-only remote Dev 0026 ledger acceptance.

    No sample money, synthetic credits, payment statuses or paid bookings are
    minted by this test. A missing source is SKIP; an unupgraded D1 is FAIL.
    """
    source = NOOR / "workers/api/migrations/0026_subscription_ledger_foundation.sql"
    if not source.is_file():
        print("SKIP: Noor main has no 0026 subscription ledger; Dev not accepted")
        return False
    if DATABASE_NAME != "noor-core-staging" or WORKER_NAME != "noor-site-staging":
        raise RuntimeError("Subscription ledger QA is restricted to isolated Noor Dev")
    marker = d1_read_only(database_id,
        "SELECT version FROM noor_schema_meta WHERE component='subscription_ledger'")
    if marker != [{"version": 1}]:
        raise RuntimeError("Noor main includes 0026 but remote Dev D1 ledger schema is missing")
    if not all(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value or "")
               for value in (active_learner, archived_sibling)):
        raise RuntimeError("Non-synthetic learner ID passed to subscription QA")
    # Read-only D1 metadata audit first: a test run must never manufacture
    # paid entitlements from fixture assumptions.
    rows = d1_read_only(database_id,
        "SELECT "
        "(SELECT COUNT(*) FROM subscription_cycles WHERE learner_id='"
        + active_learner + "') AS cycles, "
        "(SELECT COUNT(*) FROM subscription_compensation_grants WHERE learner_id='"
        + active_learner + "') AS grants, "
        "(SELECT COUNT(*) FROM subscription_spend_events WHERE learner_id='"
        + active_learner + "') AS spends")
    if rows != [{"cycles": 0, "grants": 0, "spends": 0}]:
        raise RuntimeError("New synthetic Dev learner unexpectedly has entitlement rows")
    endpoint = "/v1/me/learners/" + active_learner + "/subscription-ledger"
    status, body, _ = http(origin, endpoint, opener=owner)
    require_status(status, 200, "Signed guardian subscription read")
    payload = json_body(body)
    expected = {
        "code": "SUBSCRIPTION_LEDGER", "bookingEnabled": False,
        "latestCycle": None, "compensationUnspentSessions": 0,
        "compensationGrantCount": 0,
    }
    if any(payload.get(k) != v for k, v in expected.items()):
        raise RuntimeError("Subscription read fabricated a paid balance or bookable status")
    if any("payment" in k.lower() or "price" in k.lower() or "currency" in k.lower()
           for k in payload.keys()):
        raise RuntimeError("Unapproved financial status exposed by academic ledger")
    status, _, _ = http(origin, endpoint, opener=foreign_owner)
    require_status(status, 404, "Foreign signed household subscription isolation")
    status, _, _ = http(origin,
        "/v1/me/learners/" + archived_sibling + "/subscription-ledger",
        opener=owner)
    require_status(status, 404, "Archived synthetic sibling ledger denial")
    status, _, _ = http(origin, endpoint)
    require_status(status, 401, "Anonymous academic ledger denial")
    status, _, _ = http(origin, endpoint, method="POST", body={},
                       opener=owner)
    require_status(status, 405, "Subscription writer never exposed")
    print("PASS: Noor Dev 0026 remote D1 schema, signed owner-only zero-ledger GET, foreign/archived 404, anonymous 401, credit writes 405, no invented payment")
    return True


def plan_stage_synthetic_smoke(origin, database_id, config, owner_a, owner_b, learner_id, other_learner):
    """#244: authorized synthetic teacher plan end-to-end on dedicated Noor Staging only."""
    from noor_report_staging import verify_report_flow
    from noor_notebook_staging import verify_notebook_flow
    from noor_quran_archive_staging import verify_archive_readonly
    from noor_classroom_staging import (verify_classroom_room, verify_signed_lesson_lifecycle,
                                       verify_browser_lesson_completion)
    from uuid import uuid4
    def subject(opener):
        status, body, _ = http(origin, "/api/auth/session", opener=opener)
        require_status(status, 200, "Synthetic subject validation")
        value = json_body(body).get("user", {}).get("id")
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
            raise RuntimeError("Unexpected synthetic Better Auth ID")
        return value

    staff_subject, teacher_subject = subject(owner_a), subject(owner_b)
    if staff_subject == teacher_subject or DATABASE_NAME != "noor-core-staging":
        raise RuntimeError("Refusing non-isolated synthetic teacher grant")
    if not all(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(learner))
               for learner in (learner_id, other_learner)):
        raise RuntimeError("Unexpected synthetic learner identifier")
    if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", database_id):
        raise RuntimeError("Missing dedicated staging D1 UUID")
    metadata = d1_read_only(database_id,
        "SELECT version FROM noor_schema_meta WHERE component='academic_plan'")
    if len(metadata) != 1 or metadata[0].get("version") != 1:
        raise RuntimeError("Noor academic plan migration 0009 missing")

    def qa_write(statement):
        # The principal IDs above are obtained from two NEW synthetic session
        # subjects, never from command-line args or user-supplied data.
        wrangler("d1", "execute", DATABASE_NAME, "--config", str(config),
                 "--remote", "--command", statement)
    def post(path, data, opener, expected):
        code, body, _ = http(origin, path, method="POST", body=data, opener=opener)
        require_status(code, expected, "Noor synthetic teacher plan operation")
        return json_body(body)
    role_id = None
    assignment_id = None
    staff_seeded = False
    try:
        # This is a synthetic TEST-ONLY bootstrap for the existing Dev D1;
        # no HTTP endpoint allows the user or teacher to grant themselves a role.
        qa_write("UPDATE auth_users SET phone_number_verified=1 WHERE id IN ('"+
                 staff_subject+"','"+teacher_subject+"')")
        staff_seeded = True  # cleanup even when D1 write response is lost
        qa_write("INSERT INTO staff_grants(auth_subject,permission,revoked_at_ms) "
                 "VALUES('"+staff_subject+"','roles.manage',NULL)")
        def role(action):
            return post("/v1/staff/teacher-actions",
                {"action":action,"targetUserId":teacher_subject,
                 "reason":"Synthetic staging verification only",
                 "operationId":str(uuid4())}, owner_a,
                201 if action=="provision" else 200)
        role_id = role("provision").get("teacherId")
        if not isinstance(role_id,str) or not re.fullmatch(r"[0-9a-f-]{36}",role_id):
            raise RuntimeError("Synthetic teacher role provisioning failed")
        role("qualify")
        role("activate")
        from noor_admin_staging import (verify_signed_admin_overview,
                                        verify_revoked_admin_overview,
                                        verify_signed_teacher_directory,
                                        verify_revoked_teacher_directory,
                                        verify_signed_staff_collections,
                                        verify_revoked_staff_collections,
                                        verify_signed_admin_operations,
                                        verify_admin_guard_migrations)
        verify_signed_admin_overview(origin, owner_a, owner_b, http,
                                      require_status, json_body)
        verify_signed_teacher_directory(origin, owner_a, owner_b, role_id,
                                        http, require_status, json_body)
        verify_signed_staff_collections(origin, owner_a, owner_b,
                                        http, require_status, json_body)
        verify_admin_guard_migrations(database_id, d1_read_only)
        verify_signed_admin_operations(origin, owner_a, owner_b, role_id,
                                       http, require_status, json_body)
        if os.environ.get("NOOR_STAGING_BROWSER_QA") == "true":
            def admin_browser_cookies(opener):
                handlers = [h for h in opener.handlers
                            if isinstance(h, urllib.request.HTTPCookieProcessor)]
                if len(handlers) != 1:
                    raise RuntimeError("Synthetic Admin Dev session jar missing")
                cookies = [{"name": c.name, "value": c.value}
                           for c in handlers[0].cookiejar if c.secure]
                if not cookies:
                    raise RuntimeError("Signed synthetic Admin Dev session missing")
                return json.dumps(cookies)
            browser_env = dict(
                os.environ, NOOR_STAGING_ORIGIN=origin + "/",
                NOOR_SYNTHETIC_STAFF_COOKIES=admin_browser_cookies(owner_a),
                NOOR_SYNTHETIC_TEACHER_COOKIES=admin_browser_cookies(owner_b),
            )
            browser = subprocess.run(
                ["node", "scripts/noor_staging_admin_browser.mjs"],
                cwd=ROOT, env=browser_env, capture_output=True, text=True, timeout=180,
            )
            if browser.returncode != 0:
                raise RuntimeError(
                    "Noor signed Admin Dev Chrome failed; inspect synthetic screenshot artifact"
                )
            for line in browser.stdout.splitlines():
                if line.startswith("PASS: Noor Admin Dev") and len(line) < 220:
                    print(line)
        verify_dev_subscription_ledger_read(origin,database_id,owner_a,owner_b,
                                            learner_id,other_learner)
        verify_dev_trial_slot_withdrawal(origin,database_id,owner_a,owner_a,
                                        owner_b,learner_id,role_id)
        verify_dev_trial_atomic_reschedule(origin,database_id,owner_a,owner_a,
                                           owner_b,learner_id,role_id)
        now = int(time.time()*1000)
        assigned = post("/v1/staff/schedule-actions",
            {"action":"assign","operationId":str(uuid4()),
             "reason":"Synthetic assignment for academic plan staging",
             "learnerId":learner_id,"teacherId":role_id,
             "startsAtMs":now+9000,"endsAtMs":now+3600000},
            owner_a,201)
        assignment_id = assigned.get("resourceId")
        if not isinstance(assignment_id,str) or not re.fullmatch(r"[0-9a-f-]{36}",assignment_id):
            raise RuntimeError("Synthetic teacher assignment failed")
        time.sleep(max(0,(now+10000-int(time.time()*1000))/1000))
        verify_signed_teacher_directory(origin, owner_a, owner_b, role_id,
                                        http, require_status, json_body,
                                        min_learners=1)
        teacher_path="/v1/teacher/learners/"+learner_id+"/plan"
        write_path=teacher_path+"-actions"
        owner_path="/v1/me/learners/"+learner_id+"/plan"
        code, body, _ = http(origin,teacher_path,opener=owner_b)
        require_status(code,200,"Synthetic assigned teacher plan GET")
        if json_body(body).get("plan") is not None:
            raise RuntimeError("New synthetic learner already has a plan")
        command={"operationId":str(uuid4()),"expectedRevision":0,"level":"beginner",
                 "nextWird":"Synthetic next memorization","revisionWird":"Synthetic review",
                 "focus":"Synthetic reading practice"}
        saved=post(write_path,command,owner_b,200)
        if saved.get("revision")!=1:
            raise RuntimeError("Teacher plan revision ACK incorrect")
        if post(write_path,command,owner_b,200).get("code")!="PLAN_ALREADY_SAVED":
            raise RuntimeError("Teacher plan replay not idempotent")
        post(write_path,{**command,"operationId":str(uuid4()),
                         "nextWird":"Stale overwrite"},owner_b,409)
        code, body, _ = http(origin,owner_path,opener=owner_a)
        require_status(code,200,"Owner visible published plan")
        saved_plan=json_body(body).get("plan")
        if (not isinstance(saved_plan,dict) or saved_plan.get("revision")!=1 or
                saved_plan.get("nextWird")!=command["nextWird"]):
            raise RuntimeError("Owner plan failed to reflect server-confirmed teacher write")
        code,_,_=http(origin,owner_path,opener=owner_b)
        require_status(code,404,"Other household plan boundary")
        code,_,_=http(origin,"/v1/teacher/learners/"+other_learner+"/plan",opener=owner_b)
        require_status(code,404,"Unassigned sibling plan denied")

        # Phase 05A, no Chrome needed: native remote D1 publishes Quran homework
        # from the current primary Sheikh and verifies owner readback/isolation.
        assignment_edition="hafs-kfqc:v1.1.1"
        code,body,_=http(origin,"/v1/teacher/assignment-catalog",opener=owner_b)
        require_status(code,200,"Canonical Quran assignment catalog")
        catalog=json_body(body).get("surahs",[])
        if not any(row.get("editionId")==assignment_edition and
                   row.get("surah")==1 and row.get("ayahCount")==7 for row in catalog):
            raise RuntimeError("Remote assignment catalog lacks verified Hafs al-Fatiha anchors")
        teacher_tasks="/v1/teacher/learners/"+learner_id+"/assignments"
        owner_tasks="/v1/me/learners/"+learner_id+"/assignments"
        code,body,_=http(origin,owner_tasks,opener=owner_a)
        require_status(code,200,"Owner empty assignment list")
        if json_body(body).get("assignments"):
            raise RuntimeError("New synthetic owner student already has published assignments")
        task={"operationId":str(uuid4()),"kind":"memorization","editionId":assignment_edition,
              "surah":1,"fromAyah":1,"toAyah":7,"dueAtMs":int(time.time()*1000)+86400000,
              "instructions":"Synthetic D1 Quran memorization task"}
        assert_status=post(teacher_tasks,task,owner_b,201)
        task_id=assert_status.get("assignmentId")
        if not isinstance(task_id,str) or not re.fullmatch(r"[0-9a-fA-F-]{36}",task_id):
            raise RuntimeError("Remote assignment publish lacked server ID")
        replay=post(teacher_tasks,task,owner_b,200)
        if replay.get("code")!="ASSIGNMENT_ALREADY_PUBLISHED" or replay.get("assignmentId")!=task_id:
            raise RuntimeError("Assignment publish replay is not idempotent")
        post(teacher_tasks,{**task,"instructions":"Forged replay"},owner_b,409)
        post(teacher_tasks,{**task,"operationId":str(uuid4()),"toAyah":300},owner_b,400)
        code,body,_=http(origin,owner_tasks,opener=owner_a)
        require_status(code,200,"Owner published assignment reload")
        tasks=json_body(body).get("assignments",[])
        if len(tasks)!=1 or tasks[0].get("id")!=task_id or tasks[0].get("toAyah")!=7:
            raise RuntimeError("Owner could not reload server-published Quran assignment")
        code,_,_=http(origin,owner_tasks,opener=owner_b)
        require_status(code,404,"Foreign owner assignment denied")
        code,_,_=http(origin,"/v1/teacher/learners/"+other_learner+"/assignments",opener=owner_b)
        require_status(code,404,"Unassigned learner assignment denied")
        print("PASS: Remote Noor Phase 05A canonical teacher publish, replay 200, conflict 409, owner readback, isolation 404")
        # Phase 05B: explicitly submitted TEXT-only student task + active Sheikh review.
        owner_submissions=owner_tasks+"/"+task_id+"/submissions"
        teacher_reviews=teacher_tasks+"/"+task_id+"/reviews"
        code,body,_=http(origin,owner_submissions,opener=owner_a)
        require_status(code,200,"Student empty submission list")
        if json_body(body).get("attempts")!=[]:
            raise RuntimeError("New synthetic task already has attempts")
        code,_,_=http(origin,owner_submissions,opener=owner_b)
        require_status(code,404,"Unrelated owner cannot read homework submissions")
        code,_,_=http(origin,teacher_reviews,opener=owner_a)
        require_status(code,404,"Staff-only account cannot see submitted teacher notes")
        note={"operationId":str(uuid4()),"note":"Synthetic learner confirms preparation; NO AUDIO"}
        post(owner_submissions,note,owner_b,404)
        post(owner_submissions,{**note,"actorAuthSubject":"forged"},owner_a,400)
        submitted=post(owner_submissions,note,owner_a,201)
        submission_id=submitted.get("submissionId")
        if not isinstance(submission_id,str) or not re.fullmatch(r"[a-fA-F0-9-]{36}",submission_id) or submitted.get("attempt")!=1:
            raise RuntimeError("Student submit returned invalid server receipt")
        duplicate=post(owner_submissions,note,owner_a,200)
        if duplicate.get("submissionId")!=submission_id:
            raise RuntimeError("Student submission did not replay exactly")
        post(owner_submissions,{**note,"note":"changed"},owner_a,409)
        post(owner_submissions,{"operationId":str(uuid4()),"note":"duplicate attempt"},owner_a,409)
        code,body,_=http(origin,teacher_reviews,opener=owner_b)
        require_status(code,200,"Teacher submitted text is visible")
        attempts=json_body(body).get("attempts")
        if len(attempts)!=1 or attempts[0].get("id")!=submission_id or attempts[0].get("decision") is not None:
            raise RuntimeError("Teacher cannot reload pending student submission")
        review={"operationId":str(uuid4()),"submissionId":submission_id,
                "decision":"retry_requested","feedback":"Synthetic correction: revisit the first ayah"}
        review_id=post(teacher_reviews,review,owner_b,201).get("reviewId")
        if not isinstance(review_id,str):
            raise RuntimeError("Teacher review missing server ACK")
        if post(teacher_reviews,review,owner_b,200).get("reviewId")!=review_id:
            raise RuntimeError("Teacher review replay mismatch")
        post(teacher_reviews,{**review,"operationId":str(uuid4()),"decision":"accepted"},owner_b,409)
        second=post(owner_submissions,{"operationId":str(uuid4()),"note":"Synthetic retry after feedback"},owner_a,201)
        second_id=second.get("submissionId")
        if second.get("attempt")!=2 or not isinstance(second_id,str):
            raise RuntimeError("Second student attempt not allowed after retry")
        post(teacher_reviews,{"operationId":str(uuid4()),"submissionId":second_id,
                              "decision":"accepted","feedback":"Reviewed and accepted"},owner_b,201)
        code,body,_=http(origin,owner_submissions,opener=owner_a)
        require_status(code,200,"Owner sees immutable review history")
        attempts=json_body(body).get("attempts",[])
        if (len(attempts)!=2 or attempts[0].get("decision")!="accepted" or
                attempts[1].get("decision")!="retry_requested"):
            raise RuntimeError("Student sees incorrect attempt/review history")
        post(owner_submissions,{"operationId":str(uuid4()),"note":"after accepted"},owner_a,409)
        print("PASS: Noor Phase 05B remote student submit/replay and teacher retry+accept, immutable history and owner isolation")
        def check_scheduled_room(room_lesson_id):
            verify_classroom_room(origin,database_id,owner_a,owner_b,learner_id,
                other_learner,room_lesson_id,post,http,d1_read_only,require_status,json_body)
            if os.environ.get("NOOR_STAGING_LIVEKIT_BROWSER_QA")=="true":
                # These separate Better Auth sessions are ephemeral and do not
                # appear in logs, screenshots, URLs, artifacts or GitHub outputs.
                def synthetic_cookies(opener):
                    processors=[h for h in opener.handlers
                                if isinstance(h,urllib.request.HTTPCookieProcessor)]
                    if len(processors)!=1:
                        raise RuntimeError("Missing isolated Noor browser session jar")
                    cookies=[{"name":c.name,"value":c.value}
                             for c in processors[0].cookiejar if c.secure]
                    if not cookies:
                        raise RuntimeError("Missing signed synthetic browser session")
                    return json.dumps(cookies)
                livekit_env=dict(os.environ,
                    NOOR_STAGING_ORIGIN=origin+"/",
                    NOOR_SYNTHETIC_LIVEKIT_QA="true",
                    NOOR_SYNTHETIC_LIVEKIT_LESSON=room_lesson_id,
                    NOOR_SYNTHETIC_LIVEKIT_LEARNER=learner_id,
                    NOOR_SYNTHETIC_TEACHER_COOKIES=synthetic_cookies(owner_b),
                    NOOR_SYNTHETIC_STUDENT_COOKIES=synthetic_cookies(owner_a))
                browser=subprocess.run(["node","scripts/noor_staging_livekit_browser.mjs"],
                    cwd=ROOT,env=livekit_env,capture_output=True,text=True,timeout=180)
                # The child browser hides raw errors because they may contain
                # provider identity, signed cookies or page payloads. Preserve
                # only fixed PASS labels and allowlisted stage identifiers,
                # including on failure, to make independent gates debuggable.
                safe_stages={"browser-preflight","private-correction","signed-end"}
                for line in browser.stdout.splitlines():
                    if line.startswith("PASS: ") and len(line)<220:
                        print(line)
                    elif line.startswith("FAIL_STAGE: ") and line[12:] in safe_stages:
                        print(line)
                if browser.returncode!=0:
                    raise RuntimeError("Noor two-browser LiveKit QA failed; inspect synthetic screenshot artifact")

            # Both branches must prove a signed, completed Start/End. A/V
            # opt-in runs that lifecycle through the actual two-browser UI;
            # regular isolated runs still enforce full signed HTTP corrections.
            if os.environ.get("NOOR_STAGING_LIVEKIT_BROWSER_QA")=="true":
                return verify_browser_lesson_completion(
                    origin,database_id,owner_a,owner_b,learner_id,room_lesson_id,
                    http,d1_read_only,require_status,json_body)
            return verify_signed_lesson_lifecycle(
                origin,database_id,owner_a,owner_b,learner_id,room_lesson_id,
                post,http,d1_read_only,require_status,json_body)

        report_lesson_id = verify_report_flow(
            origin,database_id,owner_a,owner_b,learner_id,other_learner,role_id,
            post,http,qa_write,d1_read_only,require_status,json_body,
            on_scheduled_lesson=check_scheduled_room)
        # The independent P0 D1 marked-homework write must remain fail-fast,
        # but only AFTER signed classroom/LiveKit acceptance. Otherwise its
        # existing HTTP 503 incorrectly hides all separate AV evidence.
        verify_signed_marked_homework(origin,database_id,owner_a,owner_b,
            learner_id,other_learner,assignment_edition,teacher_tasks,owner_tasks,post)
        verify_notebook_flow(
            origin,database_id,owner_a,owner_b,learner_id,other_learner,
            report_lesson_id,http,post,d1_read_only,require_status,json_body)
        verify_archive_readonly(
            origin,database_id,owner_a,owner_b,learner_id,other_learner,
            report_lesson_id,http,d1_read_only,require_status,json_body)

        # Capture the exact approved immutable snapshot BEFORE revoking the
        # Sheikh. Signed classroom End auto-seeds draft revision 1, so the
        # second approved revision is 3 (legacy fixture used revision 2).
        # Compare full snapshot, not an outdated hardcoded revision number.
        code,raw,_=http(origin,"/v1/me/learners/"+learner_id+"/reports",opener=owner_a)
        require_status(code,200,"Capture approved report before teacher revocation")
        approved_before=[x for x in json_body(raw).get("reports",[])
                         if x.get("lessonId")==report_lesson_id]
        if len(approved_before)!=1 or not isinstance(approved_before[0].get("revision"),int):
            raise RuntimeError("Missing single approved report before teacher revocation")





        if os.environ.get("NOOR_STAGING_BROWSER_QA")=="true":
            # The only time the connected Chrome test may use teacher privileges is
            # while the synthetic qualified primary assignment is still current.
            # Cookie values remain in the runner's child process env; no screenshots
            # of cookies, no printed tokens and never user-controlled identities.
            def synthetic_cookies(opener):
                processors=[h for h in opener.handlers
                            if isinstance(h,urllib.request.HTTPCookieProcessor)]
                if len(processors)!=1:
                    raise RuntimeError("Synthetic session cookie jar unavailable")
                cookies=[{"name":c.name,"value":c.value}
                         for c in processors[0].cookiejar if c.secure]
                if not cookies:
                    raise RuntimeError("No secure synthetic Better Auth session")
                return json.dumps(cookies)
            browser_env=dict(os.environ,NOOR_STAGING_ORIGIN=origin+"/",
                             NOOR_SYNTHETIC_TEACHER_COOKIES=synthetic_cookies(owner_b),
                             NOOR_SYNTHETIC_STAFF_COOKIES=synthetic_cookies(owner_a))
            browser=subprocess.run(["node","scripts/noor_staging_teacher_browser.mjs"],
                                   cwd=ROOT,env=browser_env,capture_output=True,text=True)
            if browser.returncode!=0:
                raise RuntimeError("Noor connected teacher Chrome staging failed; inspect synthetic screenshot artifact")
            print(browser.stdout.strip())

        post("/v1/staff/schedule-actions",
            {"action":"revoke","operationId":str(uuid4()),
             "reason":"Cleanup synthetic teacher assignment",
             "resourceId":assignment_id},owner_a,200)
        code,_,_=http(origin,teacher_path,opener=owner_b)
        require_status(code,404,"Former primary teacher plan access revoked")
        code,_,_=http(origin,"/v1/teacher/lessons/"+report_lesson_id+"/report",opener=owner_b)
        require_status(code,404,"Revoked Sheikh cannot read report after reassignment")
        code,_,_=http(origin,"/v1/teacher/lessons/"+report_lesson_id+"/report-actions",
                       method="POST",
                       body={"kind":"publish","operationId":str(uuid4()),"expectedRevision":2},
                       opener=owner_b)
        require_status(code,404,"Revoked Sheikh cannot publish old report")
        code,raw,_=http(origin,"/v1/me/learners/"+learner_id+"/reports",opener=owner_a)
        require_status(code,200,"Owner approved report survives teacher revocation")
        approved=[x for x in json_body(raw).get("reports",[])
                  if x.get("lessonId")==report_lesson_id]
        if approved!=approved_before:
            raise RuntimeError("Archived immutable approved report changed after Sheikh revocation")

        code,_,_=http(origin,write_path,method="POST",body=command,opener=owner_b)
        require_status(code,404,"Former primary teacher replay rejected")
        code,_,_=http(origin,teacher_tasks,method="POST",body=task,opener=owner_b)
        require_status(code,404,"Revoked teacher cannot replay published assignment")
        code,_,_=http(origin,teacher_reviews,opener=owner_b)
        require_status(code,404,"Revoked teacher cannot read past learner submission")
        code,_,_=http(origin,teacher_reviews,method="POST",body=review,opener=owner_b)
        require_status(code,404,"Revoked teacher cannot replay teacher review")

        # #334: exercise the NEW roster-ID transition with a previously
        # verified synthetic Sheikh. D1 0027 must reject outstanding
        # scheduled/live classes: this operation is valid only after the
        # staged classroom and assignment have been closed.
        post("/v1/staff/teachers/transition",
             {"teacherId":role_id,"action":"suspend",
              "reason":"Synthetic Dev staff closes completed Sheikh fixture",
              "operationId":str(uuid4())},owner_a,200)
        # Check the same signed cookie immediately after fresh D1 staff revocation.
        # The existing finally block still cleans up grants and verification.
        qa_write("UPDATE staff_grants SET revoked_at_ms="+str(int(time.time()*1000))+
                 " WHERE auth_subject='"+staff_subject+"' AND permission='roles.manage'")
        verify_revoked_admin_overview(origin, owner_a, http, require_status)
        verify_revoked_teacher_directory(origin, owner_a, http, require_status)
        verify_revoked_staff_collections(origin, owner_a, http, require_status)
        print("PASS: Remote Noor 0009 plan, synthetic staff-managed teacher, owner read, stale 409, replay and revoke 404")
    finally:
        # Important: no synthetic staff grant or qualified active test teacher
        # remains capable of accessing any student after success OR failure.
        timestamp=int(time.time()*1000)
        if assignment_id is not None:
            qa_write("UPDATE teacher_assignments SET revoked_at_ms="+str(timestamp)+
                     " WHERE id='"+assignment_id+"' AND revoked_at_ms IS NULL")
        if role_id is not None:
            qa_write("UPDATE teachers SET status='disabled' WHERE id='"+role_id+"'")
        if staff_seeded:
            qa_write("UPDATE staff_grants SET revoked_at_ms="+str(timestamp)+
                     " WHERE auth_subject='"+staff_subject+"' AND permission='roles.manage'")
        qa_write("UPDATE auth_users SET phone_number_verified=0 WHERE id IN ('"+
                 staff_subject+"','"+teacher_subject+"')")


def verify_disabled_recitation_audio(origin, database_id, owner, foreign, learner_ids):
    """#254: remote Noor-only owner policy remains DISABLED after 0012 migration.

    No recordings, no mutable consent, no R2 objects and no browser sessions.
    """
    if DATABASE_NAME != "noor-core-staging" or WORKER_NAME != "noor-site-staging":
        raise RuntimeError("Noor audio QA requires dedicated isolated Dev resources")
    versions = d1_read_only(database_id,
        "SELECT version FROM noor_schema_meta WHERE component='recitation_audio_privacy'")
    if versions != [{"version": 1}]:
        raise RuntimeError("Noor locked recitation privacy migration 0012 not applied")
    locks = d1_read_only(database_id,
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN "
        "('recitation_consent_grant_locked','recitation_audio_upload_locked') ORDER BY name")
    names = [row.get("name") for row in locks]
    if names != ["recitation_audio_upload_locked", "recitation_consent_grant_locked"]:
        raise RuntimeError("Noor staging audio D1 grant or upload lock missing")
    count = d1_read_only(database_id,
        "SELECT COUNT(*) AS n FROM recitation_audio_assets")
    if count != [{"n": 0}]:
        raise RuntimeError("Noor Dev unexpectedly contains private audio asset metadata")

    if len(learner_ids) != 2 or len(set(learner_ids)) != 2:
        raise RuntimeError("Noor synthetic sibling QA requires exactly two learners")
    for learner_id in learner_ids:
        if not isinstance(learner_id, str) or not re.fullmatch(r"[0-9a-f-]{36}", learner_id):
            raise RuntimeError("Invalid synthetic learner ID")
        path = "/v1/me/learners/" + learner_id + "/recitation-audio-policy"
        code, body, headers = http(origin, path, opener=owner)
        require_status(code, 200, "Owned learner audio capability read")
        response = json_body(body)
        if (response.get("uploadEnabled") is not False or
                response.get("consentStatus") != "not_available" or
                response.get("storageStatus") != "not_configured" or
                response.get("code") != "AUDIO_PRIVACY_APPROVAL_REQUIRED"):
            raise RuntimeError("Noor Dev returned non-disabled recitation capability")
        if headers.get("Cache-Control") != "no-store":
            raise RuntimeError("Noor recitation policy response must be non-cacheable")
        code, _, _ = http(origin, path, opener=foreign)
        require_status(code, 404, "Foreign owner private audio policy")
        code, _, _ = http(origin, path)
        require_status(code, 401, "Anonymous private audio policy")
        code, _, _ = http(origin, path, method="POST",
                           body={"grant": True}, opener=owner)
        require_status(code, 405, "No public guardian grant endpoint")
    print("PASS: Noor Dev 0012 locked, owner/sibling disabled audio policy,"
          " other owner 404, anonymous 401, grant POST 405, no R2 assets")


def smoke(origin, access_password, database_id, config):
    access_password = None  # This development deployment has no staging-wide Basic prompt.
    # Development site: regular application login and learner ownership still apply.
    # The owner requested a browser preview of the *current* Noor main Sheikh
    # portal and interactive classroom. Verify all static routes against the
    # deployed Cloudflare Worker, not just CI's local Next.js build.
    preview_pages = (
        "/", "/student/", "/student/mushaf/",
        "/teacher/", "/teacher/schedule/", "/teacher/students/",
        "/teacher/preparation/", "/teacher/reports/",
        "/teacher/assignments/", "/teacher/notifications/", "/teacher/cases/",
        "/classroom/", "/admin/", "/admin/teachers/",
    )
    for path in preview_pages:
        status, body, _ = http(origin, path)
        require_status(status, 200, "Public demo page: " + path)
        if b"<html" not in body.lower():
            raise RuntimeError("Public demo did not return HTML: " + path)
    # Owner UX acceptance: the refreshed lesson preview must actually include
    # the fullscreen focus control, not an older deployed static build.
    # Next.js static HTML can contain >128KB of serialized React state.
    # Truncating the body hid the new Quran component after the header.
    status, classroom, _ = http(origin, "/classroom/", max_bytes=1024 * 1024)
    require_status(status, 200, "Immersive classroom preview")
    if "وضع الحصة".encode("utf-8") not in classroom:
        raise RuntimeError("Deployed classroom is missing the immersive lesson mode")
    # Additional owner-approved dense layout markers. Check the actual served
    # HTML to reject a stale previous staging build, not just local Next build.
    for marker in ("ضبط الوقت التجريبي", "الصفحة السابقة", "الصفحة التالية"):
        if marker.encode("utf-8") not in classroom:
            raise RuntimeError("Stale classroom staging: missing compact UI marker " + marker)
    # Exact deployed markup from Noor PR #133: the old Quran component used
    # duplicated mobile height restrictions and kept the Quran tiny. Reject
    # a stale Cloudflare Pages asset/SSR build, not just an HTTP 200 document.
    if b'data-quran-layout="viewport-fit"' not in classroom:
        raise RuntimeError("Staging still serves old tiny-Quran layout")
    print("PASS: deployed classroom contains new viewport-fit Quran and compact controls")


    # A random .js file in the build output may not be referenced by this
    # route (and Cloudflare assets can propagate after HTML). Test the actual
    # browser scripts linked by the deployed classroom HTML.
    linked = re.findall(rb'<script[^>]+src="(/_next/static/[^"]+\.js)"', classroom)
    if not linked:
        raise RuntimeError("No browser JavaScript scripts referenced by classroom HTML")
    tested = []
    for raw_path in dict.fromkeys(linked).keys():
        path = raw_path.decode("ascii")
        if not (NOOR / "apps/web/out" / path.lstrip("/")).is_file():
            raise RuntimeError("Classroom references a JS file absent from build")
        status = 0
        for attempt in range(18):
            status, _, _ = http(origin, path)
            if status == 200:
                break
            if status not in (404, 503):
                raise RuntimeError(f"Classroom JS asset HTTP {status}")
            time.sleep(2)
        require_status(status, 200, "Referenced classroom JS " + str(len(tested)+1))
        tested.append(path)
        if len(tested) >= 3:
            break
    print(f"PASS: {len(tested)} real classroom JS script assets loaded HTTP 200")

    # An anonymous visitor does not receive another site-wide password prompt.
    # Application-level session and learner ownership checks still apply.
    status, _, _ = http(origin, "/api/auth/session")
    require_status(status, 401, "Anonymous application session")
    status, _, _ = http(origin, "/v1/me/learners")
    require_status(status, 401, "Anonymous learner API")
    for path in ("/health", "/ready"):
        status, _, _ = http(origin, path)
        require_status(status, 200, "Public development endpoint: " + path)

    for attempt in range(25):
        status, data, _ = http(origin, "/health", access_password)
        if status == 200 and json_body(data).get("status") == "up":
            break
        time.sleep(2)
    else:
        raise RuntimeError("Remote stage /health did not become ready")

    status, data, _ = http(origin, "/ready", access_password)
    require_status(status, 200, "Remote stage /ready")
    ready = json_body(data)
    if ready.get("authentication") != "configured" or ready.get("database") != "ready":
        raise RuntimeError("Remote D1 and auth not ready")

    def account(phone, name):
        jar = CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        password = secrets.token_urlsafe(22) + "Az1!"
        status, result, headers = http(
            origin, "/api/auth/register", access_password, "POST",
            {"name": name, "phoneNumber": phone, "password": password}, opener,
        )
        require_status(status, 200, "Synthetic account signup")
        obj = json_body(result)
        if obj.get("phoneVerified") is not False or not isinstance(obj.get("user", {}).get("id"), str):
            raise RuntimeError("Unexpected synthetic registration verification state")
        session_cookies = headers.get_all("Set-Cookie") or []
        if not any("httponly" in c.lower() and "samesite=lax" in c.lower() for c in session_cookies):
            raise RuntimeError("Missing HttpOnly/SameSite session cookie")
        return opener

    first = secrets.randbelow(9999998)
    owner_a = account(f"+1202{first:07d}", "Synthetic Noor QA A")
    # Secrets uploaded immediately after Wrangler deploy may take time to
    # converge across Cloudflare isolates. Keep real authorization checks;
    # retry 401 only for this short synthetic post-deploy QA window.
    for attempt in range(15):
        status, result, _ = http(origin, "/api/auth/session", access_password, opener=owner_a)
        if status == 200:
            break
        if status != 401:
            raise RuntimeError(f"Unexpected signed-session status HTTP {status}")
        time.sleep(2)
    require_status(status, 200, "Cookie session restore")
    if not json_body(result).get("user", {}).get("id"):
        raise RuntimeError("Cookie session returned no verified user")

    learner_id = ""
    for index in (1, 2):
        for attempt in range(15):
            status, result, _ = http(origin, "/v1/me/learners", access_password, "POST",
                                     {"name": f"Synthetic Learner {index}", "learnerType": "child"}, owner_a)
            if status == 201:
                break
            if status != 401:
                raise RuntimeError(f"Unexpected learner create status HTTP {status}")
            time.sleep(2)
        require_status(status, 201, "Synthetic learner creation")
        learner_id = json_body(result)["learner"]["id"]
    status, result, _ = http(origin, "/v1/me/learners", access_password, opener=owner_a)
    require_status(status, 200, "Synthetic family query")
    if len(json_body(result).get("learners", [])) != 2:
        raise RuntimeError("Learner profile persistence failed")

    owner_b = account(f"+1202{first+1:07d}", "Synthetic Noor QA B")
    status, _, _ = http(origin, "/v1/learners/" + learner_id, access_password, opener=owner_b)
    require_status(status, 404, "Cross-account isolation")
    # #254: only a read-only, disabled audio-policy API is allowed.
    # Verify the existing Dev D1 locks and BOTH synthetic sibling profiles.
    synthetic_learners = [row["id"] for row in json_body(result)["learners"]]
    verify_disabled_recitation_audio(origin, database_id, owner_a, owner_b, synthetic_learners)
    # Actual private Quran persistence acceptance on the SAME open Dev origin.
    # Use disposable owner accounts and the independently verified 6236 anchors.
    from uuid import uuid4
    endpoint = "/v1/me/learners/" + learner_id + "/mushaf"
    def persist(kind, item_id, payload, expected=0, action="put"):
        command = {"operationId": str(uuid4()), "itemId": item_id,
                   "kind": kind, "action": action, "page": 1,
                   "expectedVersion": expected, "payload": payload}
        code, body, _ = http(origin, endpoint, access_password, "POST", command, owner_a)
        require_status(code, 201, "Quran "+kind+" "+action)
        value = json_body(body).get("item", {})
        if value.get("itemId") != item_id or value.get("version") != expected+1:
            raise RuntimeError("D1 private Quran save ACK did not match expected revision")
        return value
    stroke = "synthetic-ink-" + str(uuid4())
    persist("pen", stroke, {"color": "#f6cd46", "width": 3,
                            "points": [{"x": 120, "y": 220}, {"x": 180, "y": 280}]})
    persist("marker", "synthetic-marker-"+str(uuid4()),
            {"color": "#86c5a8", "width": 16,
             "points": [{"x": 180, "y": 320}, {"x": 230, "y": 340}]})
    note = "note-synthetic-" + str(uuid4())
    note_data = {"target": {"surah": 1, "ayah": 1, "wordIndex": None},
                 "color": "#f6cd46", "text": "Synthetic development check"}
    persist("note", note, note_data)
    persist("bookmark", "bookmark-1", {})
    code, page_data, _ = http(origin, endpoint+"?page=1", access_password, opener=owner_a)
    require_status(code, 200, "Quran stored page read")
    if not any(item.get("itemId") == stroke for item in json_body(page_data).get("items", [])):
        raise RuntimeError("Saved Quran pen not present after D1 reload")
    persist("note", note, {}, 1, "hide")
    code, index_data, _ = http(origin, endpoint+"?index=1", access_password, opener=owner_a)
    require_status(code, 200, "Quran stored index read")
    if not any(item.get("itemId") == note and item.get("version") == 2
               and item.get("visible") is False
               for item in json_body(index_data).get("items", [])):
        raise RuntimeError("Private Quran tombstone not preserved after reload")
    persist("note", note, note_data, 2)
    code, _, _ = http(origin, endpoint+"?page=1", access_password, opener=owner_b)
    require_status(code, 404, "Other account Quran isolation")
    print("PASS: open Dev account-backed Quran pen/marker/note/bookmark, save/reload/restore, foreign-owner 404")

    # Noor #157: all mutations are authenticated *through deployed staging*,
    # never direct SQL. Only read-only D1 counts are used for archive audit proof.
    if not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", learner_id):
        raise RuntimeError("Unexpected learner identifier from deployed Noor")
    profile_path = "/v1/me/learners/" + learner_id + "/profile-actions"
    code, payload, _ = http(origin, "/v1/me/learners", access_password, opener=owner_a)
    require_status(code, 200, "Profile revisions initial GET")
    profiles = json_body(payload).get("learners", [])
    if len(profiles) != 2 or any(p.get("revision") != 1 for p in profiles):
        raise RuntimeError("Profiles lack 0008 revision migration or expected initial state")
    command = {"action": "rename", "name": "Synthetic Learner 2 Updated",
               "expectedRevision": 1, "operationId": str(uuid4())}
    code, _, _ = http(origin, profile_path, access_password, "POST", command, owner_b)
    require_status(code, 404, "Foreign owner profile mutation denied")
    code, payload, _ = http(origin, profile_path, access_password, "POST", command, owner_a)
    require_status(code, 200, "Profile rename with D1 CAS")
    if json_body(payload).get("revision") != 2:
        raise RuntimeError("D1 rename ACK revision mismatch")
    code, payload, _ = http(origin, profile_path, access_password, "POST", command, owner_a)
    require_status(code, 200, "Profile rename replay")
    if json_body(payload).get("code") != "OPERATION_ALREADY_APPLIED":
        raise RuntimeError("Duplicate rename generated a new mutation")
    stale = {**command, "operationId": str(uuid4()), "name": "Stale edit"}
    code, _, _ = http(origin, profile_path, access_password, "POST", stale, owner_a)
    require_status(code, 409, "Profile edit with stale expectedRevision")
    code, payload, _ = http(origin, "/v1/me/learners", access_password, opener=owner_a)
    require_status(code, 200, "Renamed learner refresh")
    profile = next((p for p in json_body(payload).get("learners", [])
                    if p.get("id") == learner_id), None)
    if not profile or profile.get("name") != command["name"] or profile.get("revision") != 2:
        raise RuntimeError("Confirmed profile rename missing after remote GET")

    archive = {"action": "archive", "expectedRevision": 2, "operationId": str(uuid4())}
    code, payload, _ = http(origin, profile_path, access_password, "POST", archive, owner_a)
    require_status(code, 200, "Profile archive")
    if json_body(payload).get("revision") != 3:
        raise RuntimeError("Archive ACK revision mismatch")
    code, payload, _ = http(origin, "/v1/me/learners", access_password, opener=owner_a)
    require_status(code, 200, "Active sibling list after archive")
    active = json_body(payload).get("learners", [])
    if len(active) != 1 or any(p.get("id") == learner_id for p in active):
        raise RuntimeError("Archived learner leaked into active siblings")
    code, _, _ = http(origin, "/v1/learners/" + learner_id, access_password, opener=owner_a)
    require_status(code, 404, "Archived learner detail denied")
    code, _, _ = http(origin, endpoint + "?page=1", access_password, opener=owner_a)
    require_status(code, 404, "Archived learner private Quran access denied")
    # Verify prior private Quran and its immutable profile audit remain in D1
    # without returning child content, audio or private annotations to logs.
    preserved = d1_read_only(database_id,
        "SELECT (SELECT COUNT(*) FROM private_mushaf_items WHERE learner_id='" + learner_id +
        "') AS quran_count, (SELECT COUNT(*) FROM learner_profile_audit WHERE learner_id='" +
        learner_id + "') AS audit_count")
    if len(preserved) != 1 or preserved[0].get("quran_count", 0) < 4 or preserved[0].get("audit_count") != 2:
        raise RuntimeError("Archive did not preserve private Quran records and audit history")
    print("PASS: Noor profile rename, CAS 409, idempotent replay, cross-owner 404, archive, hidden-after-refresh and private history preserved")
    # The original second student is archived above. Stage the plan only on
    # the remaining ACTIVE synthetic sibling to avoid bypassing archive.
    if len(active)!=1:
        raise RuntimeError("Expected exactly one active synthetic student for plan")
    plan_stage_synthetic_smoke(origin,database_id,config,owner_a,owner_b,
                               active[0]["id"],learner_id)


    
    status, _, _ = http(origin, "/api/auth/logout", access_password, "POST", {}, owner_a)
    require_status(status, 200, "Logout revocation")
    status, _, _ = http(origin, "/api/auth/session", access_password, opener=owner_a)
    require_status(status, 401, "Logout replay rejection")
    print("PASS: open dev pages/assets 200, anonymous app sessions 401, D1 readiness, signup, cookie sessions, profiles, isolation and logout; OTP deferred")



# Noor-only, reviewable canonical corpus metadata. Both values come from
# the independent source-verification run in Noor PR #148 / issue #147.
NOOR_MANIFEST_SHA = "864c5474872876b3db8a328d8c74781be83c004a7cdb168ffb4b7eb57477edd2"
NOOR_HAFS_TEXT_SHA = "9b9eb07ff5cff144bf964400924e593d97115e4b937db3c61783f782a5168075"
NOOR_EDITION = "hafs-kfqc:v1.1.1"
NOOR_AYAH_INSERT = re.compile(
    r"^INSERT INTO quran_ayah_anchors\(edition_id,surah,ayah,page,word_count\) "
    r"VALUES\('hafs-kfqc:v1\.1\.1',([0-9]+),([0-9]+),([0-9]+),([0-9]+)\);$"
)


def d1_read_only(database_id, statement):
    """Query only our explicitly identified staging UUID, never a supplied DB name."""
    if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", database_id):
        raise RuntimeError("Invalid staging D1 UUID")
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{database_id}/query"
    body = json.dumps({"sql": statement}).encode()
    request = urllib.request.Request(url, data=body, headers={
        "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json",
        "Accept": "application/json", "User-Agent": "NoorStagingCanonicalChecker/1.0",
    }, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=90) as reply:
            result = json.load(reply)
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        # Do not log HTTP response payloads or authorization headers.
        raise RuntimeError("Cloudflare staging D1 read-only query failed") from None
    if not result.get("success") or len(result.get("result", [])) != 1:
        raise RuntimeError("Cloudflare staging D1 query not acknowledged")
    block = result["result"][0]
    if block.get("success") is not True or not isinstance(block.get("results"), list):
        raise RuntimeError("Cloudflare staging D1 result was invalid")
    return block["results"]


def canonical_quran_staging(config, database_id, temporary):
    """Import only to dedicated noor-core-staging, only when empty and fully verified."""
    source = NOOR / "scripts/noor_quran_anchor_import.py"
    if not source.is_file() or DATABASE_NAME != "noor-core-staging":
        raise RuntimeError("No verified Noor-only Quran import source or staging DB")
    destination = temporary / "canonical-hafs"
    result = subprocess.run([
        "python3", str(source), "--output-dir", str(destination),
        "--expected-manifest-sha256", NOOR_MANIFEST_SHA,
    ], cwd=NOOR, capture_output=True, text=True, check=False, timeout=240)
    if result.returncode:
        raise RuntimeError("Pinned Quran metadata verification refused; staging untouched")
    details = json.loads((destination / "verified-quran-anchors-evidence.json").read_text())
    if (details.get("edition") != NOOR_EDITION or
        details.get("manifest_sha256") != NOOR_MANIFEST_SHA or
        details.get("word_source_sha256") != NOOR_HAFS_TEXT_SHA or
        details.get("ayah_count") != 6236 or details.get("word_total") != 77432 or
        details.get("page_count") != 604):
        raise RuntimeError("Quran source hashes/counts differ; refusing staging write")
    sql_file = destination / "verified-quran-anchors.sql"
    lines = sql_file.read_text().splitlines()
    expected = []
    for line in lines:
        match = NOOR_AYAH_INSERT.fullmatch(line)
        if match:
            expected.append(tuple(int(value) for value in match.groups()))
        elif line.startswith("INSERT INTO quran_ayah_anchors"):
            raise RuntimeError("Unexpected generated Quran SQL")
    if len(expected) != 6236 or len(set(row[:2] for row in expected)) != 6236:
        raise RuntimeError("Generated Quran SQL incomplete")
    expected.sort()
    edition_rows = d1_read_only(database_id,
        "SELECT id,manifest_sha256,page_count FROM quran_editions WHERE id='hafs-kfqc:v1.1.1'")
    existing_rows = d1_read_only(database_id,
        "SELECT surah,ayah,page,word_count FROM quran_ayah_anchors "
        "WHERE edition_id='hafs-kfqc:v1.1.1' ORDER BY surah,ayah")
    def as_tuples(rows):
        return sorted((row["surah"], row["ayah"], row["page"], row["word_count"])
                      for row in rows)
    if edition_rows or existing_rows:
        # Fully idempotent only when EVERY row agrees, not just total counts.
        if (len(edition_rows) != 1 or
            edition_rows[0].get("manifest_sha256") != NOOR_MANIFEST_SHA or
            edition_rows[0].get("page_count") != 604 or
            as_tuples(existing_rows) != expected):
            raise RuntimeError("Refusing existing partial or mismatched Quran staging data")
        print("PASS: all existing 6236 staging Hafs anchors match audited source; no write")
        return
    # Only here may a remote D1 mutation take place, and only for one named
    # isolated Noor staging DB; never Santo / Noor production.
    wrangler("d1", "execute", DATABASE_NAME, "--config", str(config), "--remote",
             "--file", str(sql_file))
    edition_after = d1_read_only(database_id,
        "SELECT id,manifest_sha256,page_count FROM quran_editions WHERE id='hafs-kfqc:v1.1.1'")
    actual = d1_read_only(database_id,
        "SELECT surah,ayah,page,word_count FROM quran_ayah_anchors "
        "WHERE edition_id='hafs-kfqc:v1.1.1' ORDER BY surah,ayah")
    if (len(edition_after) != 1 or
        edition_after[0].get("manifest_sha256") != NOOR_MANIFEST_SHA or
        as_tuples(actual) != expected):
        raise RuntimeError("D1 import did not verify completely; do not enable Quran UI")
    print("PASS: dedicated Noor staging D1 now has 6236 verified Hafs anchors; Quran UI feature OFF")



def main():
    if not re.fullmatch(r"[0-9a-f]{40}", NOOR_SHA):
        raise RuntimeError("Exact validated Noor commit required")
    if not (NOOR / "apps/web/out/index.html").is_file():
        raise RuntimeError("Account UI static build is missing")
    subdomain = cloudflare_subdomain()
    origin = f"https://{WORKER_NAME}.{subdomain}.workers.dev"
    database_id = staging_database()
    with tempfile.TemporaryDirectory(prefix="noor-staging-", dir=os.environ.get("RUNNER_TEMP", "/tmp")) as dirname:
        temp = Path(dirname)
        config, secure = write_config(temp, database_id, origin, secrets.token_hex(32), secrets.token_hex(32))
        # Preserve the deployed AUTH_SECRET and other Dev secrets on every
        # code refresh; rotating it would invalidate existing test sessions.
        # Wrangler metadata lists NAMES only; values are never retrieved.
        existing_names = names_of_deployed_staging_secrets(config)
        candidates = json.loads(secure.read_text())
        missing_secrets = select_missing_staging_secrets(candidates, existing_names)
        secure.write_text(json.dumps(missing_secrets))
        secure.chmod(0o600)
        wrangler("d1", "migrations", "apply", DATABASE_NAME, "--config", str(config), "--remote")
        canonical_quran_staging(config, database_id, temp)
        # Wrangler 4.45 does not support 'deploy --secrets-file'. First deploy
        # the fail-closed Worker (no access secret means every path returns 503),
        # then upload BOTH secrets atomically using the pinned 'secret bulk' command.
        wrangler("deploy", "--config", str(config))
        # With the public flag, pages may already return 200 while API routes
        # remain credential-gated. Older deployments may briefly serve a 401
        # or 403 during propagation; subsequent smoke checks enforce 200/401.
        initial_status, _, _ = http(origin, "/")
        if initial_status not in (200, 401, 403, 503):
            raise RuntimeError(f"Unexpected staging transition status HTTP {initial_status}")
        if missing_secrets:
            wrangler("secret", "bulk", str(secure), "--config", str(config))
        else:
            print("PASS: existing Noor Dev secret names preserved, no value changed")
        # Never print generated credentials; even a successful smoke does not
        # authorize real child data, production traffic or OTP delivery.
        # With NOOR_DEV_OPEN the HTTP tests use app authorization rather
        # than staging Basic. The temporary candidate is never deployed
        # when the corresponding secret already exists.
        smoke(origin, candidates["STAGING_ACCESS_PASSWORD"], database_id, config)
        if os.environ.get("NOOR_STAGING_BROWSER_QA")=="true":
            # Native Chrome verifies the freshly deployed account UI (5 viewports),
            # plus real D1 rename/archive/refresh and owner isolation.
            browser_env = dict(os.environ, NOOR_STAGING_ORIGIN=origin + "/")
            browser = subprocess.run(["node", "scripts/noor_staging_profile_browser.mjs"],
                                     cwd=ROOT, env=browser_env, capture_output=True, text=True)
            if browser.returncode != 0:
                raise RuntimeError("Noor staging Chrome connected-profile acceptance failed; check screenshot artifact")
            print(browser.stdout.strip())

        # One ordinary development site only. Do not create a second QA worker.
        # The development build exposes account-backed personal Quran saves.
        # Account-level Better Auth and per-learner D1 authorization still apply.
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as report:
            report.write(f"## Noor development staging\n- Noor SHA: `{NOOR_SHA}`\n"
                         f"- Development site (no staging password): `{origin}`\n"
                         "- D1: `noor-core-staging` (independent of production)\n"
                         "- Pages and assets: HTTP 200; app session/learner APIs: HTTP 401 without login\n"
                         "- Remote private synthetic acceptance: PASS\n- OTP and messages: OFF\n")
    print("PASS: open Noor development site and authenticated application APIs remotely verified; no production resources used")
    print("NOOR_ADMIN_DEV_PREVIEW_URL="+origin+"/admin/")


if __name__ == "__main__":
    main()
