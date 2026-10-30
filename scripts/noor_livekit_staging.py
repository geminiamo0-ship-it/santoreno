"""CR-02A: real Dev LiveKit media token gateway denial, NO LiveKit credentials.

Only runs inside the synthetic signed scheduled Classroom DO fixture on
noor-site-staging. Never includes tokens or secrets in error messages/logs.
"""
import re

def verify_livekit_unconfigured(origin, owner, teacher, learner_id, other_learner,
                                lesson_id, post, http, require_status, json_body):
    if not re.fullmatch(r"https://noor-site-staging\.[a-z0-9-]+\.workers\.dev",origin):
        raise RuntimeError("CR-02A refused non-isolated origin")
    if any(not isinstance(v,str) or not re.fullmatch(r"[0-9a-fA-F-]{36}",v)
           for v in (learner_id,other_learner,lesson_id)):
        raise RuntimeError("CR-02A refused unverified synthetic identity")
    if learner_id==other_learner:
        raise RuntimeError("CR-02A refused duplicate learner IDs")
    student="/v1/me/learners/"+learner_id+"/lessons/"+lesson_id+"/media-token"
    teacher_path="/v1/teacher/lessons/"+lesson_id+"/media-token"
    # Authenticated participant with a valid DO lease still does not receive
    # any token while external provider secrets remain deliberately absent.
    for path,principal in ((student,owner),(teacher_path,teacher)):
        code,raw,headers=http(origin,path,method="POST",body={},opener=principal)
        require_status(code,503,"CR-02A LiveKit unconfigured fail-closed")
        value=json_body(raw)
        if (value.get("code")!="LIVEKIT_NOT_CONFIGURED" or
            "participantToken" in value or "serverUrl" in value or
            headers.get("Cache-Control")!="no-store"):
            raise RuntimeError("CR-02A token leaked while provider disabled")
        code,_,_=http(origin,path,method="GET",opener=principal)
        require_status(code,405,"CR-02A POST-only token endpoint")
        code,raw,_=http(origin,path,method="POST",
                         body={"role":"teacher","room":"forged","grants":["roomAdmin"]},
                         opener=principal)
        require_status(code,400,"CR-02A reject forged room/role/grants")

    for path,who,status in ((student,teacher,404),(teacher_path,owner,404),
                             (student,None,401),(teacher_path,None,401),
                             ("/v1/me/learners/"+other_learner+"/lessons/"+
                              lesson_id+"/media-token",owner,404)):
        code,_,_=http(origin,path,method="POST",body={},opener=who)
        require_status(code,status,"CR-02A owner/teacher isolation")
    print("PASS: CR-02A isolated Dev signed LiveKit gateway 503/no token without "
          "credentials; fake room/role 400, foreign 404, anonymous 401, GET 405")
