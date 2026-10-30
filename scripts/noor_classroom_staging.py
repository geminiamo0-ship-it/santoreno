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
