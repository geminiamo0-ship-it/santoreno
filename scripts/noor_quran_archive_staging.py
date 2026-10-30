"""08B1 Noor Quran archive: only read and privacy DENIAL on isolated Dev.

The genuine Classroom DO snapshot exporter isn't implemented. This smoke must
NEVER insert fake archive marks or fabricate source SHA-256 in remote D1.
"""
import re
def verify_archive_readonly(origin,database_id,owner,foreign,learner,other_learner,
                            lesson_id,http,d1_read_only,require_status,json_body):
    for value in (learner,other_learner,lesson_id):
        if not isinstance(value,str) or not re.fullmatch(r"[0-9a-fA-F-]{36}",value):
            raise RuntimeError("Archive synthetic lesson identity invalid")
    if not isinstance(database_id,str) or not re.fullmatch(r"[0-9a-fA-F-]{32,36}",database_id):
        raise RuntimeError("Archive D1 staging UUID absent")
    v=d1_read_only(database_id,
      "SELECT version FROM noor_schema_meta WHERE component='lesson_quran_archive'")
    if len(v)!=1 or v[0].get("version")!=1:
        raise RuntimeError("Archive 0015 schema unavailable")
    existing=d1_read_only(database_id,
     "SELECT COUNT(*) AS n FROM lesson_quran_archives WHERE lesson_id='"+lesson_id+"'")
    if len(existing)!=1 or existing[0].get("n")!=0:
        raise RuntimeError("Unexpected archive producer or synthetic seal in Dev")
    path="/v1/me/learners/"+learner+"/lessons/"+lesson_id+"/quran-archive"
    code,raw,headers=http(origin,path,opener=owner)
    require_status(code,200,"Quran archive owner no source")
    data=json_body(raw)
    if data.get("archive","absent") is not None or data.get("code")!="ARCHIVE_NOT_SEALED":
        raise RuntimeError("Unsealed archive must never be returned as teacher data")
    if headers.get("Cache-Control")!="no-store":
        raise RuntimeError("Quran archive response must be no-store")
    for account,expected in ((foreign,404),(None,401)):
        code,_,_=http(origin,path,opener=account)
        require_status(code,expected,"Quran archive cross-owner and anonymous isolation")
    code,_,_=http(origin,
      "/v1/me/learners/"+other_learner+"/lessons/"+lesson_id+"/quran-archive",
      opener=owner)
    require_status(code,404,"Quran archive sibling/lesson mismatch")
    code,_,_=http(origin,path,method="POST",opener=owner,body={})
    require_status(code,405,"No owner archive writer exposed")
    print("PASS: Noor Phase 08B1 remote Dev sealed Quran archive unavailable without source, "
      "owner 200/null, foreign 404, anonymous 401, POST 405, no fake marks")
