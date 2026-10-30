"""Phase 08A Noor private notebook Dev smoke (#258), synthetic signed accounts only."""
import re
from uuid import uuid4

def verify_notebook_flow(origin,database_id,owner,foreign,learner_id,other_learner,
                         lesson_id,http,post,d1_read_only,require_status,json_body):
    # IDs come from authenticated synthetic staging setup; never a user-supplied
    # arbitrary D1 database or lesson. Verify all before first request.
    ids=(learner_id,other_learner,lesson_id)
    if not all(isinstance(v,str) and re.fullmatch(r"[0-9a-fA-F-]{36}",v) for v in ids):
        raise RuntimeError("Notebook staging synthetic identity invalid")
    if not isinstance(database_id,str) or not re.fullmatch(r"[0-9a-fA-F-]{32,36}",database_id):
        raise RuntimeError("Notebook staging D1 UUID missing")
    version=d1_read_only(database_id,
      "SELECT version FROM noor_schema_meta WHERE component='notebook_notes'")
    if len(version)!=1 or version[0].get("version")!=1:
        raise RuntimeError("Noor 0014 notebook schema not ready")
    path="/v1/me/learners/"+learner_id+"/lessons/"+lesson_id+"/notebook-notes"
    code,raw,headers=http(origin,path,opener=owner)
    require_status(code,200,"Notebook owner empty notes")
    if json_body(raw).get("notes")!=[] or headers.get("Cache-Control")!="no-store":
        raise RuntimeError("Private notes must be empty and noncacheable")
    for who,expected in ((foreign,404),(None,401)):
        code,_,_=http(origin,path,opener=who)
        require_status(code,expected,"Notebook authenticated owner isolation")
    code,_,_=http(origin,
      "/v1/me/learners/"+other_learner+"/lessons/"+lesson_id+"/notebook-notes",
      opener=owner)
    require_status(code,404,"Notebook sibling or archived lesson denied")

    note_id=str(uuid4())
    first={"action":"put","operationId":str(uuid4()),"noteId":note_id,
           "expectedVersion":0,"body":"Synthetic lesson private journal"}
    saved=post(path,first,owner,201)
    if saved.get("code")!="NOTEBOOK_NOTE_SAVED" or saved.get("version")!=1:
        raise RuntimeError("Noor notebook owner create ACK invalid")
    if post(path,first,owner,200).get("code")!="NOTEBOOK_ALREADY_APPLIED":
        raise RuntimeError("Noor notebook idempotent replay failed")
    post(path,{**first,"body":"Changed same UUID"},owner,409)
    post(path,{**first,"operationId":str(uuid4())},owner,409)
    post(path,first,foreign,404)
    code,raw,_=http(origin,path,opener=owner)
    require_status(code,200,"Notebook owner read after save")
    notes=json_body(raw).get("notes")
    if len(notes)!=1 or notes[0].get("body")!=first["body"] or notes[0].get("version")!=1:
        raise RuntimeError("Noor notebook owner note missing after reload")

    edited={"action":"put","operationId":str(uuid4()),"noteId":note_id,
            "expectedVersion":1,"body":"Synthetic corrected private note"}
    post(path,edited,owner,200)
    code,raw,_=http(origin,path,opener=owner)
    require_status(code,200,"Notebook corrected owner note")
    notes=json_body(raw).get("notes")
    if len(notes)!=1 or notes[0].get("body")!=edited["body"] or notes[0].get("version")!=2:
        raise RuntimeError("Noor notebook edit revision did not persist")

    hide={"action":"hide","operationId":str(uuid4()),"noteId":note_id,
          "expectedVersion":2,"body":""}
    if post(path,hide,owner,200).get("code")!="NOTEBOOK_NOTE_HIDDEN":
        raise RuntimeError("Noor notebook hide not acknowledged")
    if post(path,hide,owner,200).get("code")!="NOTEBOOK_ALREADY_APPLIED":
        raise RuntimeError("Noor notebook hide idempotency failed")
    code,raw,_=http(origin,path,opener=owner)
    require_status(code,200,"Notebook hidden note not displayed")
    if json_body(raw).get("notes")!=[]:
        raise RuntimeError("Noor hidden private note leaked")
    historic=d1_read_only(database_id,
      "SELECT COUNT(*) AS n FROM notebook_note_events WHERE lesson_id='"+lesson_id+"'")
    if len(historic)!=1 or historic[0].get("n")!=3:
        raise RuntimeError("Noor notebook event history not immutable/preserved")
    print("PASS: Noor Phase 08A remote Dev private notes owner 201, replay 200, conflict 409, edit/hide and reload, sibling 404")
