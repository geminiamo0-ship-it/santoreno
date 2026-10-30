#!/usr/bin/env python3
"""Isolated Noor Dev owner demo: three fictional identities, two user logins,
one genuine scheduled lesson; encrypt all credentials to a public recipient cert.
Never logs secrets, writes production or uses a privileged browser bypass.
"""
import base64
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from uuid import uuid4

ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
DATABASE_NAME = "noor-core-staging"
WORKER_NAME = "noor-site-staging"
ROOT = Path.cwd()
OUTPUT = ROOT / "artifacts/noor-owner-demo/demo.cms"
CERT = ROOT / "scripts/noor_owner_demo_recipient.crt"
UUID = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
if not ACCOUNT or not TOKEN or not CERT.is_file():
    raise SystemExit("Noor isolated Dev prerequisites are missing")

def cf(method, path, data=None):
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/" + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={"Authorization":"Bearer " + TOKEN, "Content-Type":"application/json",
                 "User-Agent":"NoorOwnerDemoQA/1.0"},
        method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except (urllib.error.HTTPError, urllib.error.URLError):
        raise RuntimeError("Isolated Cloudflare Dev request unavailable") from None

def scope():
    sub = cf("GET", "accounts/" + ACCOUNT + "/workers/subdomain")
    name = sub.get("result", {}).get("subdomain")
    if not sub.get("success") or not isinstance(name,str) or not re.fullmatch(r"[a-z0-9-]+",name):
        raise RuntimeError("Cloudflare Dev origin unavailable")
    url = "https://" + WORKER_NAME + "." + name + ".workers.dev"
    data = cf("GET","accounts/" + ACCOUNT + "/d1/database")
    databases=data.get("result",[])
    if isinstance(databases,dict): databases=databases.get("databases",[])
    match=[x for x in databases if x.get("name")==DATABASE_NAME]
    if len(match)!=1: raise RuntimeError("Dedicated Noor staging D1 missing")
    db=match[0].get("uuid") or match[0].get("id")
    if not isinstance(db,str) or not re.fullmatch(r"[0-9a-fA-F-]{32,36}",db):
        raise RuntimeError("Unexpected staging D1 identifier")
    return url,db

def d1(db,sql):
    if not re.fullmatch(r"[0-9a-fA-F-]{32,36}",db):
        raise RuntimeError("Untrusted D1 scope")
    result=cf("POST","accounts/"+ACCOUNT+"/d1/database/"+db+"/query",{"sql":sql})
    blocks=result.get("result",[])
    if not result.get("success") or len(blocks)!=1 or blocks[0].get("success") is not True:
        raise RuntimeError("Synthetic-only staging D1 write was refused")
    return blocks[0].get("results",[])

def http(origin,path,method="GET",body=None,opener=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(origin+path,method=method,data=data,headers={
      "Accept":"application/json","Content-Type":"application/json",
      "User-Agent":"Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0.0.0 Safari/537.36",
      **({"Origin":origin} if body is not None else {})})
    client=opener or urllib.request.build_opener()
    try:
        with client.open(req,timeout=25) as response:
            return response.status,json.load(response)
    except urllib.error.HTTPError as error:
        try: detail=json.load(error)
        except (ValueError,UnicodeError): detail={}
        return error.code,detail

def required(origin,path,expected,method="GET",body=None,opener=None):
    status,payload=http(origin,path,method,body,opener)
    if status!=expected:
        raise RuntimeError("Dev demo operation failed at "+path.split("?")[0]+": HTTP "+str(status))
    return payload

def new_account(origin,label,used_phones):
    # +1 202 555 0100..0199 is reserved fictional NANP range.
    candidates=[f"+120255501{i:02d}" for i in range(100)]
    secrets.SystemRandom().shuffle(candidates)
    for phone in candidates:
        if phone in used_phones: continue
        jar=CookieJar()
        browser=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        password=secrets.token_urlsafe(20)+"Aa1!"
        status,payload=http(origin,"/api/auth/register","POST",
            {"name":label,"phoneNumber":phone,"password":password},browser)
        if status in (400,409):continue
        if status!=200:raise RuntimeError("Dev synthetic signup failed HTTP "+str(status))
        uid=payload.get("user",{}).get("id")
        if not isinstance(uid,str) or not UUID.fullmatch(uid):
            raise RuntimeError("Synthetic signup returned invalid auth subject")
        session=required(origin,"/api/auth/session",200,opener=browser)
        if session.get("user",{}).get("id")!=uid:
            raise RuntimeError("Synthetic Better Auth session mismatch")
        used_phones.add(phone)
        return {"phone":phone,"password":password,"subject":uid,"browser":browser}
    raise RuntimeError("No available reserved fictional demo phone numbers")

def post(origin,path,body,browser,expected):
    return required(origin,path,expected,"POST",body,browser)

def grant_sql(ids):
    if not all(isinstance(v,str) and UUID.fullmatch(v) for v in ids):
        raise RuntimeError("Unsafe synthetic identity ID")
    return "','".join(ids)

def main():
    origin,db=scope()
    ready=required(origin,"/ready",200)
    if ready.get("authentication")!="configured" or ready.get("database")!="ready":
        raise RuntimeError("Staging not in a usable authenticated state")
    people=set()
    student=new_account(origin,"Noor Demo Learner Owner",people)
    teacher=new_account(origin,"Noor Demo Sheikh",people)
    staff=new_account(origin,"Noor Demo Temporary Setup",people)
    subjects=grant_sql([staff["subject"],teacher["subject"]])
    roles_granted=False
    try:
        # D1-only test bootstrap, never an HTTP privilege-granting endpoint.
        d1(db,"UPDATE auth_users SET phone_number_verified=1 WHERE id IN ('"+subjects+"')")
        d1(db,"INSERT INTO staff_grants(auth_subject,permission,revoked_at_ms) "
              "VALUES('"+staff["subject"]+"','roles.manage',NULL)")
        roles_granted=True
        def teacher_action(action):
            return post(origin,"/v1/staff/teacher-actions",{
               "action":action,"targetUserId":teacher["subject"],
               "reason":"Temporary owner demo on isolated Cloudflare Dev",
               "operationId":str(uuid4())},staff["browser"],
               201 if action=="provision" else 200)
        teacher_id=teacher_action("provision").get("teacherId")
        if not isinstance(teacher_id,str) or not UUID.fullmatch(teacher_id):
            raise RuntimeError("Teacher provisioning did not yield verified role ID")
        teacher_action("qualify")
        teacher_action("activate")
        learner=post(origin,"/v1/me/learners",
          {"name":"Demo Learner - Test Only","learnerType":"adult"},student["browser"],201)
        learner_id=learner.get("learner",{}).get("id")
        if not isinstance(learner_id,str) or not UUID.fullmatch(learner_id):
            raise RuntimeError("Learner profile was not created")
        now=int(time.time()*1000)
        assigned=post(origin,"/v1/staff/schedule-actions",{
          "action":"assign","operationId":str(uuid4()),
          "reason":"Temporary synthetic Quran lesson hands-on QA",
          "learnerId":learner_id,"teacherId":teacher_id,
          "startsAtMs":now+60000,"endsAtMs":now+3*3600000,
        },staff["browser"],201)
        if not UUID.fullmatch(str(assigned.get("resourceId",""))):
            raise RuntimeError("Teacher assignment not persisted")
        lesson=post(origin,"/v1/staff/schedule-actions",{
          "action":"book","operationId":str(uuid4()),
          "reason":"Temporary synthetic owner hands-on classroom test",
          "learnerId":learner_id,"teacherId":teacher_id,
          "startsAtMs":now+3*60000,"kind":"standard",
        },staff["browser"],201)
        lesson_id=lesson.get("resourceId")
        if not isinstance(lesson_id,str) or not UUID.fullmatch(lesson_id):
            raise RuntimeError("Scheduled lesson not persisted")
        required(origin,"/v1/teacher/lessons/"+lesson_id+"/presence",200,
                 opener=teacher["browser"])
        required(origin,"/v1/me/learners/"+learner_id+"/lessons/"+lesson_id+"/presence",200,
                 opener=student["browser"])
        # Prove the actual credentials, not just the original registration cookie.
        for person in (student,teacher):
            jar=CookieJar()
            fresh=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            post(origin,"/api/auth/login",{"phoneNumber":person["phone"],
                 "password":person["password"]},fresh,200)
            signed=required(origin,"/api/auth/session",200,opener=fresh)
            if signed.get("user",{}).get("id")!=person["subject"]:
                raise RuntimeError("Demo password login did not restore expected role")
        data={
          "environment":"isolated Noor Dev only",
          "origin":origin,
          "login_url":origin+"/student/",
          "sheikh":{"phone":teacher["phone"],"password":teacher["password"],
            "lesson_url":origin+"/classroom/live/?role=teacher&lessonId="+lesson_id},
          "student":{"phone":student["phone"],"password":student["password"],
            "lesson_url":origin+"/classroom/live/?role=learner&lessonId="+lesson_id+
               "&learnerId="+learner_id},
          "lesson_id":lesson_id,"learner_id":learner_id,
          "reserved_from_utc_ms":now+3*60000,
          "reserved_until_utc_ms":now+43*60000,
          "note":"40-minute booked synthetic lesson; rebook if expired. No real contact or child data."
        }
        OUTPUT.parent.mkdir(parents=True,exist_ok=True)
        plaintext=OUTPUT.with_suffix(".json")
        try:
            plaintext.write_text(json.dumps(data,ensure_ascii=False))
            plaintext.chmod(0o600)
            run=subprocess.run(["openssl","cms","-encrypt","-aes-256-cbc","-binary",
                "-outform","DER","-in",str(plaintext),"-out",str(OUTPUT),str(CERT)],
                text=True,capture_output=True,check=False)
            if run.returncode:raise RuntimeError("Demo credentials envelope encryption failed")
            OUTPUT.chmod(0o600)
        finally:
            plaintext.unlink(missing_ok=True)
        print("PASS: two independent synthetic logins and one staff-approved scheduled lesson; encrypted owner handoff ready")
    finally:
        # Staff setup grant is NEVER left active, even if a later proof fails.
        if roles_granted:
            d1(db,"UPDATE staff_grants SET revoked_at_ms="+str(int(time.time()*1000))+
                  " WHERE auth_subject='"+staff["subject"]+"' AND permission='roles.manage' AND revoked_at_ms IS NULL")
        d1(db,"UPDATE auth_users SET phone_number_verified=0 WHERE id='"+staff["subject"]+"'")

if __name__=="__main__":
    try:main()
    except Exception:
        print("ERROR: safe synthetic owner demo provisioning failed; credentials were not published",file=sys.stderr)
        raise SystemExit(1)
