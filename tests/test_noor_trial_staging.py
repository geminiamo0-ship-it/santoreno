"""#244: offline tests for signed Dev 0024 trial-slot acceptance. No network."""
import importlib.util
import json
import os
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID","synthetic-cloudflare-account")
os.environ.setdefault("CLOUDFLARE_API_TOKEN","synthetic-token")
os.environ.setdefault("NOOR_SHA","a"*40)
spec=importlib.util.spec_from_file_location(
 "noor_private_staging",Path(__file__).resolve().parents[1]/"scripts/noor_private_staging.py")
stage=importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)

SLOT="a145a6fa-1d94-4994-91e7-5819692ba3b6"
LESSON="a245a6fa-1d94-4994-91e7-5819692ba3b6"

class TrialWithdrawalStageTests(TestCase):
 def test_signed_owner_booking_denied_withdrawal_then_cancel_and_close(self):
  calls=[]
  def get(origin,path,secret=None,method="GET",body=None,opener=None,max_bytes=131072):
   calls.append((path,method,opener,body))
   if path=="/v1/staff/trial-slots":
    self.assertEqual(method,"POST")
    self.assertEqual(opener,"staff")
    self.assertEqual(body["teacherId"],"sheikh-id")
    self.assertGreater(body["startsAtMs"],1700000000000)
    return 201,json.dumps({"slotId":SLOT}).encode(),{}
   if path=="/v1/me/learners/learner/trial-slots":
    if opener=="foreign":
     return 404,b'{"code":"NOT_FOUND"}',{}
    return 200,json.dumps({"eligible":True,"slots":[{"slotId":SLOT}]}).encode(),{}
   if path=="/v1/me/learners/learner/trial-bookings":
    if len([x for x in calls if x[0]==path])==1:
     return 201,json.dumps({"code":"TRIAL_BOOKED","lessonId":LESSON}).encode(),{}
    return 409,b'{"code":"TRIAL_SLOT_UNAVAILABLE"}',{}
   if path=="/v1/staff/trial-slots/"+SLOT+"/close":
    if len([x for x in calls if x[0]==path])==1:
     return 409,b'{"code":"TRIAL_SLOT_CLOSE_DENIED"}',{}
    return 200,b'{"code":"TRIAL_SLOT_CLOSED"}',{}
   if path=="/v1/me/learners/learner/trial-cancellations":
    self.assertEqual(opener,"owner")
    self.assertEqual(body["lessonId"],LESSON)
    return 201,b'{"code":"TRIAL_CANCELLED"}',{}
   raise AssertionError("Unexpected route "+path)
  reads=[
   [{"version":1}], [{"status":"scheduled","closures":0}],
   [{"status":"cancelled","closures":1}],
  ]
  with patch.object(stage,"d1_read_only",side_effect=reads) as db,\
       patch.object(stage,"http",side_effect=get):
   stage.verify_dev_trial_slot_withdrawal(
    "https://noor-dev.invalid","12345678-1234-1234-1234-123456789abc",
    "staff","owner","foreign","learner","sheikh-id")
   self.assertEqual(db.call_count,3)
   self.assertEqual([c[1] for c in calls].count("POST"),6)
   self.assertFalse(any("password" in json.dumps(c) for c in calls))

 def test_schema_must_be_0024_before_account_or_slot_requests(self):
  with patch.object(stage,"d1_read_only",return_value=[]) as db,\
       patch.object(stage,"http") as http:
   with self.assertRaisesRegex(RuntimeError,"0024 not applied"):
    stage.verify_dev_trial_slot_withdrawal(
     "https://noor-dev.invalid","12345678-1234-1234-1234-123456789abc",
     "staff","owner","foreign","learner","sheikh-id")
   db.assert_called_once()
   http.assert_not_called()

 def test_synthetic_dev_gate_refuses_other_target_before_reads(self):
  with patch.object(stage,"DATABASE_NAME","noor-core-production"),\
       patch.object(stage,"d1_read_only") as db:
   with self.assertRaisesRegex(RuntimeError,"isolated Noor Dev"):
    stage.verify_dev_trial_slot_withdrawal(
     "https://noor-prod.invalid","12345678-1234-1234-1234-123456789abc",
     "staff","owner","foreign","learner","sheikh-id")
   db.assert_not_called()

if __name__=="__main__":main()
