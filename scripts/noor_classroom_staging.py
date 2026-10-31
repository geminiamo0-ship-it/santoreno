"""CR-01 Noor isolated Dev: live Durable Object leases, not actual attendance.

Only synthetic teacher + household owner authenticated through existing Better Auth
on the dedicated staging Worker. No LiveKit, no recording, no Start/End commands.
"""
import re
import time

def verify_classroom_room(origin,database_id,owner,teacher,learner_id,other_learner,
                          lesson_id,post,http,d1_read_only,require_status,json_body):
    if any(not isinstance(x,str) or not re.fullmatch(r"[0-9a-fA-F-]{36}",x)
           for x in (database_id,learner_id,other_learner,lesson_id)):
        raise RuntimeError("CR-01 denied non-synthetic DB/lesson ID")
    if learner_id==other_learner:
        raise RuntimeError("CR-01 refused identical sibling IDs")
    if not re.fullmatch(r"https://noor-site-staging\.[a-z0-9-]+\.workers\.dev",origin):
        raise RuntimeError("CR-01 refused non-isolated Noor Dev origin")

    base="/v1/me/learners/"+learner_id+"/lessons/"+lesson_id
    teacher_base="/v1/teacher/lessons/"+lesson_id
    student_read=base+"/presence"
    student_action=base+"/presence-actions"
    teacher_read=teacher_base+"/presence"
    teacher_action=teacher_base+"/presence-actions"
    for path,principal in ((student_read,owner),(teacher_read,teacher)):
        code,raw,headers=http(origin,path,opener=principal)
        require_status(code,200,"CR-01 initial signed room")
        p=json_body(raw).get("presence",{})
        if (p.get("teacherPresent") is not False or
            p.get("learnerPresent") is not False or
            p.get("bothPresent") is not False or
            p.get("canStart") is not False or
            p.get("mediaReady") is not False or
            headers.get("Cache-Control")!="no-store"):
            raise RuntimeError("CR-01 room fabricated presence/media/Start")

    for path,principal,expected in (
        (student_read,teacher,404),(teacher_read,owner,404),
        (student_read,None,401),(teacher_read,None,401),
        ("/v1/me/learners/"+other_learner+"/lessons/"+lesson_id+"/presence",owner,404)):
        code,_,_=http(origin,path,opener=principal)
        require_status(code,expected,"CR-01 distinct role and household isolation")
    code,_,_=http(origin,student_action,method="GET",opener=owner)
    require_status(code,405,"CR-01 wrong method")

    post(teacher_action,{"action":"join","role":"teacher"},teacher,400)
    post(student_action,{"action":"join","actorSubject":"forged"},owner,400)
    post(student_action,{"action":"heartbeat"},owner,404)
    # CR-02B2 private DO media-intent exists ONLY behind Worker token issuer;
    # authenticated web clients cannot assert media state or bypass revocation.
    post(student_action,{"action":"media-intent"},owner,400)
    post(teacher_action,{"action":"media-intent"},teacher,400)

    joined=post(teacher_action,{"action":"join"},teacher,200)
    p=joined.get("presence",{})
    if p.get("teacherPresent") is not True or p.get("learnerPresent") is not False:
        raise RuntimeError("CR-01 teacher join not persisted")
    both=post(student_action,{"action":"join"},owner,200)
    p=both.get("presence",{})
    if (p.get("teacherPresent") is not True or p.get("learnerPresent") is not True
            or p.get("bothPresent") is not True or p.get("canStart") is not False
            or p.get("mediaReady") is not False):
        raise RuntimeError("CR-01 both signed principals not persisted")
    heartbeat=post(teacher_action,{"action":"heartbeat"},teacher,200)
    if heartbeat.get("code")!="ROOM_HEARTBEAT":
        raise RuntimeError("CR-01 heartbeat ACK missing")
    code,raw,_=http(origin,student_read,opener=owner)
    require_status(code,200,"CR-01 second participant GET")
    if json_body(raw).get("presence",{}).get("bothPresent") is not True:
        raise RuntimeError("CR-01 lost live teacher/student DO leases")

    # Signed synthetic actors: accept only symmetric disabled 503 or strict
    # short, least-privilege 200 tickets; never print a JWT or publish media.
    from noor_livekit_staging import verify_livekit_gateway
    verify_livekit_gateway(origin,owner,teacher,learner_id,other_learner,
                               lesson_id,post,http,require_status,json_body)

    left=post(student_action,{"action":"leave"},owner,200)
    if left.get("presence",{}).get("bothPresent") is not False:
        raise RuntimeError("CR-01 learner leave did not clear two-party room")
    post(student_action,{"action":"leave"},owner,404)
    post(teacher_action,{"action":"leave"},teacher,200)

    # Presence must not mutate lesson status or create a START/END audit.
    rows=d1_read_only(database_id,
        "SELECT COUNT(*) AS n FROM lesson_lifecycle_events WHERE lesson_id='"+lesson_id+"'")
    if rows!=[{"n":0}]:
        raise RuntimeError("CR-01 waiting room falsely recorded formal attendance")

    # Real remote storage timeout check (one wait, not a headless Chrome suite).
    post(teacher_action,{"action":"join"},teacher,200)
    time.sleep(26)
    code,raw,_=http(origin,teacher_read,opener=teacher)
    require_status(code,200,"CR-01 remote 25s lease expiry")
    if json_body(raw).get("presence",{}).get("teacherPresent") is not False:
        raise RuntimeError("CR-01 expired participant falsely remains present")
    post(teacher_action,{"action":"heartbeat"},teacher,404)
    post(teacher_action,{"action":"join"},teacher,200)
    post(teacher_action,{"action":"leave"},teacher,200)
    print("PASS: CR-01 remote Dev DO two signed roles, forged 400, foreign 404, "
          "anonymous 401, no Start/AV, leave/rejoin and 25s TTL expiry")


def verify_signed_lesson_lifecycle(origin, database_id, owner, teacher,
                                   learner_id, lesson_id, post, http,
                                   d1_read_only, require_status, json_body):
    """Single final Dev-only synthetic Start -> Ayah -> correction -> End proof.

    Must execute after the existing two-browser media check and CR-01 lease check,
    but before the Phase 07 report test. No production, fabricated attendance,
    real child audio, raw credentials, or provider identity logging.
    """
    from uuid import uuid4
    if not re.fullmatch(r"https://noor-site-staging\.[a-z0-9-]+\.workers\.dev", origin):
        raise RuntimeError("Noor lifecycle QA requires isolated Dev Worker")
    if not all(re.fullmatch(r"[0-9a-fA-F-]{36}", v) for v in
               (database_id, learner_id, lesson_id)):
        raise RuntimeError("Noor lifecycle QA requires verified synthetic UUIDs")

    teacher_base = "/v1/teacher/lessons/" + lesson_id
    student_base = "/v1/me/learners/" + learner_id + "/lessons/" + lesson_id
    teacher_action = teacher_base + "/presence-actions"
    student_action = student_base + "/presence-actions"
    action = teacher_base + "/lifecycle-actions"
    def status(path, principal, expected_phase):
        code, raw, headers = http(origin, path, opener=principal)
        require_status(code, 200, "signed Noor lifecycle GET")
        state = json_body(raw).get("lifecycle", {})
        if state.get("phase") != expected_phase or headers.get("Cache-Control") != "no-store":
            raise RuntimeError("Signed Noor lifecycle state mismatch or cache")
        return state
    status(teacher_base + "/lifecycle", teacher, "scheduled")
    status(student_base + "/lifecycle", owner, "scheduled")
    for principal, expected in ((owner,404),(None,401)):
        code,_,_ = http(origin, action, method="POST",
                        body={"action":"start","operationId":str(uuid4())},
                        opener=principal)
        require_status(code,expected,"non-teacher cannot Start")
    for payload in ({"action":"automatic","operationId":str(uuid4())},
                    {"action":"start","operationId":str(uuid4()),"role":"teacher"},
                    {"action":"start","operationId":"not-uuid"}):
        post(action,payload,teacher,400)
    before = post(action, {"action":"start","operationId":str(uuid4())},teacher,409)
    if before.get("code") != "WAITING_FOR_PARTICIPANTS":
        raise RuntimeError("Start without two live DO leases was not denied")

    # CR-01 has already left and exercised lease expiry. Fresh joins here
    # establish real verified presence for formal Start.
    post(teacher_action,{"action":"join"},teacher,200)
    post(student_action,{"action":"join"},owner,200)
    operation = {"action":"start","operationId":str(uuid4())}
    started = post(action,operation,teacher,200)
    if started.get("code")!="LESSON_STARTED" or started.get("lifecycle",{}).get("phase")!="live":
        raise RuntimeError("Signed Sheikh Start did not commit live transition")
    if post(action,operation,teacher,200).get("code")!="LESSON_ALREADY_STARTED":
        raise RuntimeError("Repeat Start changed state")
    status(teacher_base+"/lifecycle",teacher,"live")
    status(student_base+"/lifecycle",owner,"live")
    audit=d1_read_only(database_id,"SELECT action FROM lesson_lifecycle_events WHERE lesson_id='"+
                       lesson_id+"' ORDER BY at_ms")
    if [x.get("action") for x in audit]!=["start"]:
        raise RuntimeError("Start did not append exact single D1 lifecycle audit")

    # Precise KFQC polygon (not calculated page offset) must be verified by
    # Worker before a signed teacher selection is stored. Learner cannot write.
    teacher_page=teacher_base+"/quran-page"
    student_page=student_base+"/quran-page"
    code,raw,_=http(origin,teacher_page,opener=teacher)
    require_status(code,200,"canonical shared Quran state")
    old=json_body(raw).get("quran",{})
    verse={"surah":1,"ayah":1}
    change={"action":"set","page":1,"verse":verse,
            "expectedRevision":old.get("revision"),"requestId":"qa-final-verse-0001"}
    anchors=d1_read_only(database_id,
        "SELECT page FROM quran_ayah_anchors WHERE edition_id='hafs-kfqc:v1.1.1' "+
        "AND surah=1 AND ayah=1 LIMIT 1")
    if anchors!=[{"page":1}]:
        raise RuntimeError("Staging canonical D1 Ayah anchor 1:1/page1 missing")
    wrong=post(teacher_page,{**change,"page":2,"requestId":"qa-wrong-page-0001"},
               teacher,400)
    if wrong.get("code")!="QURAN_VERSE_PAGE_MISMATCH":
        raise RuntimeError("Quran metadata accepted forged page 2 for Al-Fatiha 1:1")
    changed=post(teacher_page,change,teacher,200)
    if changed.get("quran",{}).get("verse")!=verse:
        raise RuntimeError("Teacher Ayah not acknowledged by signed LessonDO")
    code,raw,_=http(origin,student_page,opener=owner)
    require_status(code,200,"learner signed shared Ayah")
    if json_body(raw).get("quran",{}).get("verse")!=verse:
        raise RuntimeError("Learner did not receive identical selected Ayah")
    code,_,_=http(origin,student_page,method="POST",body=change,opener=owner)
    require_status(code,405,"learner cannot mutate shared Quran")
    post(teacher_page,{**change,"role":"teacher"},teacher,400)
    if post(teacher_page,change,teacher,200).get("code")!="QURAN_PAGE_REPLAY":
        raise RuntimeError("Ayah operation replay was not idempotent")
    print("PASS: Noor Dev signed Sheikh Start + exact KFQC Surah/Ayah -> learner sync")

    # Dev rollout acceptance: this proof must exercise real live classroom
    # pen + marker WRITE, not just source/tests or personal Quran Reader ink.
    teacher_ink=teacher_base+"/quran-ink"
    student_ink=student_base+"/quran-ink"
    for url,opener in ((teacher_ink,teacher),(student_ink,owner)):
        code,raw,_=http(origin,url+"?page=1",opener=opener)
        require_status(code,200,"signed live Quran ink read")
        view=json_body(raw)
        if view.get("canWrite") is not True or view.get("ink",{}).get("page")!=1:
            raise RuntimeError("SIGNED_LIVE_INK_NOT_ENABLED")
    pen_id="qa-pen-"+uuid4().hex
    mark_id="qa-marker-"+uuid4().hex
    def write_mark(url,opener,kind,stroke_id,revision):
        payload={"action":"add","page":1,"expectedRevision":revision,
                 "requestId":str(uuid4()),"stroke":{
                   "id":stroke_id,"page":1,"color":"#397ca7",
                   "width":3 if kind=="pen" else 16,"kind":kind,
                   "points":[{"x":110,"y":230},{"x":175,"y":250}]}}
        code,raw,_=http(origin,url,method="POST",body=payload,opener=opener)
        if code not in (200,202):
            raise RuntimeError("SIGNED_LIVE_INK_WRITE_FAILED_HTTP_"+str(code))
        value=json_body(raw)
        if value.get("code") not in ("INK_APPLIED","INK_PENDING_PERSISTENCE") or (
           value.get("ink",{}).get("revision")!=revision+1):
            raise RuntimeError("SIGNED_LIVE_INK_WRITE_NOT_ACKNOWLEDGED")
        # Explicitly distinguish pending D1 from globally saved.
        if code==202 and value.get("persistence")!="pending":
            raise RuntimeError("SIGNED_LIVE_INK_PENDING_FALSLY_SAVED")
        return revision+1
    teacher_view=json_body(http(origin,teacher_ink+"?page=1",opener=teacher)[1])
    rev=write_mark(teacher_ink,teacher,"pen",pen_id,teacher_view["ink"]["revision"])
    rev=write_mark(student_ink,owner,"marker",mark_id,rev)
    code,raw,_=http(origin,student_ink+"?page=1",opener=owner)
    require_status(code,200,"learner sees teacher and own pen")
    student_view=json_body(raw).get("ink",{})
    if student_view.get("revision")!=rev or not {pen_id,mark_id}.issubset(
       {x.get("id") for x in student_view.get("strokes",[])}):
        raise RuntimeError("SIGNED_LIVE_INK_MISSING_CROSS_ROLE_STROKES")
    # A Durable Object write is not global persistence until real D1 ledger
    # readback confirms both synthetic events; alarms may retry pending rows.
    import time
    count=0
    for _ in range(12):
        rows=d1_read_only(database_id,
          "SELECT COUNT(*) AS n FROM learner_quran_events WHERE learner_id='"+
          learner_id+"' AND origin_type='lesson' AND origin_id='"+lesson_id+"'")
        count=rows[0].get("n",0) if len(rows)==1 else 0
        if count>=2:break
        time.sleep(2)
    if count<2:raise RuntimeError("SIGNED_LIVE_INK_D1_OUTBOX_NOT_DURABLE")
    # The written QA strokes are synthetic-only, isolated to the QA learner.
    print("PASS: Signed Dev live Sheikh pen + learner marker WRITE, cross-role sync, D1 durable ledger readback")

    # Private educational correction is DO-backed and never visible to owner.
    correction=teacher_base+"/corrections"
    payload={"action":"add","operationId":str(uuid4()),"page":1,
             "surah":1,"ayah":1,"kind":"tajweed",
             "text":"Synthetic tajweed practice note - not real child data"}
    first=post(correction,payload,teacher,200)
    if first.get("code")!="CORRECTION_SAVED" or len(first.get("corrections",{}).get("items",[]))!=1:
        raise RuntimeError("Private Sheikh correction was not persisted")
    if post(correction,payload,teacher,200).get("code")!="CORRECTION_REPLAY":
        raise RuntimeError("Duplicate correction not idempotent")
    code,raw,_=http(origin,correction,opener=teacher)
    require_status(code,200,"Sheikh correction read")
    if len(json_body(raw).get("corrections",{}).get("items",[]))!=1:
        raise RuntimeError("Private correction disappeared after read")
    for principal,expected in ((owner,404),(None,401)):
        code,_,_=http(origin,correction,opener=principal)
        require_status(code,expected,"private correction cannot be read by student")
    code,raw,_=http(origin,"/v1/me/learners/"+learner_id+"/reports",opener=owner)
    require_status(code,200,"student reports still private")
    if json_body(raw).get("reports")!=[]:
        raise RuntimeError("Draft correction leaked before approved publication")

    ended=post(action,{"action":"end","operationId":str(uuid4())},teacher,200)
    if ended.get("code")!="LESSON_ENDED" or ended.get("lifecycle",{}).get("phase")!="completed":
        raise RuntimeError("Explicit Sheikh End did not commit completed state")
    if ended.get("reportDraft")!="created":
        raise RuntimeError("Private report draft was not seeded from Sheikh corrections")
    if ended.get("mediaRevocation") not in ("requested","retry_pending"):
        raise RuntimeError("End claimed unverified provider ACK")
    status(teacher_base+"/lifecycle",teacher,"completed")
    status(student_base+"/lifecycle",owner,"completed")
    if post(action,{"action":"end","operationId":str(uuid4())},teacher,200).get("code")!="LESSON_ALREADY_ENDED":
        raise RuntimeError("Duplicate End was not idempotent")
    audit=d1_read_only(database_id,"SELECT action FROM lesson_lifecycle_events WHERE lesson_id='"+
                       lesson_id+"' ORDER BY at_ms")
    if [x.get("action") for x in audit]!=["start","end"]:
        raise RuntimeError("Start/End must produce exactly two immutable D1 events")
    code,raw,_=http(origin,teacher_base+"/report",opener=teacher)
    require_status(code,200,"private draft seeded from signed End")
    draft=json_body(raw).get("report")
    if not isinstance(draft,dict) or draft.get("revision")!=1 or        "Synthetic tajweed practice note" not in draft.get("corrections",""):
        raise RuntimeError("Signed End did not prefill private teacher report draft")
    print("PASS: Noor Dev exact Start/End D1 audit, private Sheikh correction -> seeded report")
    return True


def verify_browser_lesson_completion(origin, database_id, owner, teacher,
                                     learner_id, lesson_id, http, d1_read_only,
                                     require_status, json_body):
    """Fail closed on two-browser UI Start/End; only authoritative D1 counts.

    Called after separately signed synthetic teacher and learner Chrome have
    exercised optional LiveKit media. Never turns UI text into a lifecycle ACK.
    """
    if not re.fullmatch(r"https://noor-site-staging\.[a-z0-9-]+\.workers\.dev", origin):
        raise RuntimeError("Browser lifecycle requires isolated Noor Dev Worker")
    if not all(isinstance(v,str) and re.fullmatch(r"[0-9a-fA-F-]{36}",v) for v in
               (database_id,learner_id,lesson_id)):
        raise RuntimeError("Browser lifecycle requires synthetic UUIDs")
    teacher_base="/v1/teacher/lessons/"+lesson_id
    owner_base="/v1/me/learners/"+learner_id+"/lessons/"+lesson_id
    states=[]
    for principal,path in ((teacher,teacher_base),(owner,owner_base)):
        status,raw,headers=http(origin,path+"/lifecycle",opener=principal)
        require_status(status,200,"Signed browser lesson completed GET")
        value=json_body(raw).get("lifecycle",{})
        if (headers.get("Cache-Control")!="no-store" or
            value.get("phase")!="completed" or
            not isinstance(value.get("startedAtMs"),int) or
            not isinstance(value.get("endedAtMs"),int) or
            value["startedAtMs"]>value["endedAtMs"]):
            raise RuntimeError("Signed browser End is not in authoritative D1")
        states.append((value["startedAtMs"],value["endedAtMs"]))
    if states[0]!=states[1]:
        raise RuntimeError("Teacher and learner disagree on D1 Start/End")
    actions=d1_read_only(database_id,
        "SELECT action FROM lesson_lifecycle_events WHERE lesson_id='"+lesson_id+
        "' ORDER BY at_ms")
    if [row.get("action") for row in actions]!=["start","end"]:
        raise RuntimeError("Browser Start/End must append exactly two D1 audit entries")
    status,raw,_=http(origin,teacher_base+"/report",opener=teacher)
    require_status(status,200,"Signed browser private report draft")
    draft=json_body(raw).get("report")
    if (not isinstance(draft,dict) or draft.get("status")!="draft" or
        draft.get("revision")!=1):
        raise RuntimeError("Browser End did not seed private Sheikh report draft")
    # Student can only read an explicitly published report later.
    status,raw,_=http(origin,
        "/v1/me/learners/"+learner_id+"/reports",opener=owner)
    require_status(status,200,"Signed learner approved reports after Browser End")
    if json_body(raw).get("reports")!=[]:
        raise RuntimeError("Unapproved browser End report leaked to student")
    print("PASS: signed teacher and learner UI End verified in D1, audit and private report")
    return True
