"""#244 0025 remote acceptance: offline identity and source guards, no Cloudflare."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from unittest import TestCase, main
from unittest.mock import patch

os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID","synthetic-account")
os.environ.setdefault("CLOUDFLARE_API_TOKEN","synthetic-token")
os.environ.setdefault("NOOR_SHA","a"*40)
spec=importlib.util.spec_from_file_location(
 "noor_private_staging",Path(__file__).resolve().parents[1]/"scripts/noor_private_staging.py")
stage=importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
SLOTS=[f"c{i}45a6fa-1d94-4994-91e7-5819692ba3b6" for i in (1,2,3)]
OLD="d145a6fa-1d94-4994-91e7-5819692ba3b6"
OTHER="d245a6fa-1d94-4994-91e7-5819692ba3b6"
NEW="d345a6fa-1d94-4994-91e7-5819692ba3b6"

class SignedTrialReplacementStageTests(TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name)
  (self.root/"workers/api/migrations").mkdir(parents=True)
  patcher=patch.object(stage,"NOOR",self.root)
  patcher.start()
  self.addCleanup(patcher.stop)
 def source(self):
  (self.root/"workers/api/migrations/0025_trial_owner_reschedule.sql").write_text(
   "-- source existence only")
 def run_stage(self):
  return stage.verify_dev_trial_atomic_reschedule("https://dev.invalid",
    "a145a6fa-1d94-4994-91e7-5819692ba3b6","staff","guardian",
    "other","child-1","synthetic-sheikh")
 def test_old_noor_main_skips_without_0025_or_remote_writes(self):
  with patch.object(stage,"http") as http,patch.object(stage,"d1_read_only") as db:
   self.assertIs(self.run_stage(),False)
   http.assert_not_called();db.assert_not_called()
 def test_source_requires_matching_actual_dev_d1_migration(self):
  self.source()
  with patch.object(stage,"http") as http,patch.object(stage,"d1_read_only",return_value=[]) as db:
   with self.assertRaisesRegex(RuntimeError,"Dev D1 reschedule schema is missing"):
    self.run_stage()
   db.assert_called_once()
   http.assert_not_called()
 def test_rejects_non_staging_even_when_source_exists(self):
  self.source()
  with patch.object(stage,"DATABASE_NAME","noor-core-prod"),\
       patch.object(stage,"http") as http,patch.object(stage,"d1_read_only") as db:
   with self.assertRaisesRegex(RuntimeError,"isolated Noor Dev"):
    self.run_stage()
   db.assert_not_called();http.assert_not_called()
 def test_two_signed_households_prove_atomic_reschedule_and_cleanup(self):
  self.source()
  seen=[]
  def fake_http(origin,path,secret=None,method="GET",body=None,opener=None,max_bytes=131072):
   seen.append((path,method,opener,body))
   def ok(status,payload):
    return status,json.dumps(payload).encode(),{}
   if path=="/v1/staff/trial-slots":
    self.assertEqual((method,opener),("POST","staff"))
    return ok(201,{"slotId":SLOTS[len([v for v in seen if v[0]==path])-1]})
   if path=="/v1/me/learners" and opener=="other" and method=="POST":
    return ok(201,{"learner":{"id":"synthetic-other-child"}})
   if path=="/v1/me/learners/child-1/trial-bookings":
    self.assertEqual(opener,"guardian")
    return ok(201,{"lessonId":OLD})
   if path=="/v1/me/learners/synthetic-other-child/trial-bookings":
    self.assertEqual(opener,"other")
    return ok(201,{"lessonId":OTHER})
   if path=="/v1/me/learners/child-1/trial-reschedule-slots?lessonId="+OLD:
    if opener=="other":
     return ok(404,{"code":"NOT_FOUND"})
    return ok(200,{"code":"TRIAL_RESCHEDULE_SLOTS","slots":[{"slotId":SLOTS[2]}]})
   if path=="/v1/me/learners/child-1/trial-reschedules":
    if opener=="other":
     return ok(404,{"code":"NOT_FOUND"})
    if body["slotId"]==SLOTS[1]:
     return ok(409,{"code":"TRIAL_RESCHEDULE_UNAVAILABLE"})
    if body["slotId"]==SLOTS[0]:
     return ok(409,{"code":"TRIAL_OPERATION_CONFLICT"})
    n=sum(1 for v in seen if v[0]==path and v[2]=="guardian" and v[3]["slotId"]==SLOTS[2])
    return ok(201 if n==1 else 200,
              {"code":"TRIAL_RESCHEDULED" if n==1 else "TRIAL_RESCHEDULE_REPLAY",
               "lessonId":NEW})
   if path.endswith("/trial-cancellations") and method=="POST":
    self.assertIn(opener,("guardian","other"))
    return ok(201,{"code":"TRIAL_CANCELLED"})
   raise AssertionError("unexpected request "+str((path,method,opener)))
  rows=[
   [{"version":1}],
   [{"old_status":"scheduled","other_status":"scheduled","replacements":0}],
   [{"old_status":"cancelled","new_status":"scheduled","other_status":"scheduled",
     "replacements":1,"revoked":1,"active":1}],
  ]
  with patch.object(stage,"d1_read_only",side_effect=rows) as db,\
       patch.object(stage,"http",side_effect=fake_http):
   self.assertTrue(self.run_stage())
   self.assertEqual(db.call_count,3)
  self.assertEqual(len([x for x in seen if x[0].endswith("trial-cancellations")]),2)
  self.assertEqual(len([x for x in seen if x[0].endswith("trial-reschedules")]),5)
  self.assertTrue(all(x[2]=="guardian" for x in seen
    if x[0].endswith("trial-cancellations") and "child-1/" in x[0]))
  self.assertTrue(any(x[2]=="other" and x[0].endswith("trial-cancellations")
    for x in seen))
  # No secret, token, email or real child supplied from the test.
  self.assertFalse(any("cookie" in json.dumps(x).lower() for x in seen))

if __name__=="__main__": main()
