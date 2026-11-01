"""#244: offline signed-owner 0026 Dev acceptance contract, never actual Cloudflare."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from unittest import TestCase, main
from unittest.mock import patch

os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID","synthetic-cloudflare-account")
os.environ.setdefault("CLOUDFLARE_API_TOKEN","synthetic-api-token")
os.environ.setdefault("NOOR_SHA","a"*40)
spec=importlib.util.spec_from_file_location(
 "noor_private_staging", Path(__file__).resolve().parents[1]/"scripts/noor_private_staging.py")
stage=importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)

class SubscriptionLedgerDevAcceptanceTests(TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory()
  self.addCleanup(self.tmp.cleanup)
  root=Path(self.tmp.name)
  (root/"workers/api/migrations").mkdir(parents=True)
  self.migration=root/"workers/api/migrations/0026_subscription_ledger_foundation.sql"
  m=patch.object(stage,"NOOR",root)
  m.start()
  self.addCleanup(m.stop)
 def run_stage(self):
  return stage.verify_dev_subscription_ledger_read(
   "https://staging.invalid","a145a6fa-1d94-4994-91e7-5819692ba3b6",
   "signed-owner","signed-foreign","test-child","archived-child")
 def test_pre_0026_main_explicit_skip_with_zero_remote_access(self):
  with patch.object(stage,"http") as http,patch.object(stage,"d1_read_only") as db:
   self.assertFalse(self.run_stage())
   http.assert_not_called()
   db.assert_not_called()
 def test_source_present_requires_remote_schema_and_never_reports_skip(self):
  self.migration.write_text("-- test fixture only")
  with patch.object(stage,"http") as http,patch.object(stage,"d1_read_only",return_value=[]) as db:
   with self.assertRaisesRegex(RuntimeError,"remote Dev D1 ledger schema is missing"):
    self.run_stage()
   http.assert_not_called()
   db.assert_called_once()
 def test_prod_target_denied_before_sql_or_http(self):
  self.migration.write_text("-- test fixture only")
  with patch.object(stage,"DATABASE_NAME","noor-core-production"),\
       patch.object(stage,"http") as http,patch.object(stage,"d1_read_only") as db:
   with self.assertRaisesRegex(RuntimeError,"isolated Noor Dev"):
    self.run_stage()
   http.assert_not_called()
   db.assert_not_called()
 def test_signed_no_monetization_credit_read_and_role_denials(self):
  self.migration.write_text("-- test fixture only")
  reads=[
    [{"version":1}],
    [{"cycles":0,"grants":0,"spends":0}],
  ]
  calls=[]
  def fake_http(origin,path,secret=None,method="GET",body=None,opener=None,max_bytes=131072):
   calls.append((path,method,opener,body))
   if method=="POST":
    return 405,b'{"code":"METHOD_NOT_ALLOWED"}',{}
   if opener=="signed-foreign":
    return 404,b'{"code":"NOT_FOUND"}',{}
   if opener is None:
    return 401,b'{"code":"UNAUTHORIZED"}',{}
   if path.endswith("/archived-child/subscription-ledger"):
    return 404,b'{"code":"NOT_FOUND"}',{}
   if opener=="signed-owner" and path.endswith("/test-child/subscription-ledger"):
    return 200,json.dumps({
     "code":"SUBSCRIPTION_LEDGER",
     "bookingEnabled":False,
     "latestCycle":None,
     "compensationUnspentSessions":0,
     "compensationGrantCount":0,
    }).encode(),{}
   raise AssertionError("Unrecognized signed owner route")
  with patch.object(stage,"d1_read_only",side_effect=reads) as db,\
       patch.object(stage,"http",side_effect=fake_http):
   self.assertTrue(self.run_stage())
   self.assertEqual(db.call_count,2)
   self.assertTrue(all("SELECT " in call.args[1] for call in db.call_args_list))
  self.assertEqual(len(calls),5)
  self.assertTrue(all(x[1]=="GET" for x in calls[:4]))
  self.assertEqual(calls[-1][1],"POST")
  self.assertEqual(calls[-1][2],"signed-owner")
  self.assertFalse(any("payment" in json.dumps(x) for x in calls))
 def test_fabricated_bookable_balance_is_a_hard_failure(self):
  self.migration.write_text("-- test fixture only")
  reads=[[{"version":1}],[{"cycles":0,"grants":0,"spends":0}]]
  with patch.object(stage,"d1_read_only",side_effect=reads),\
       patch.object(stage,"http",return_value=(200,json.dumps({
          "code":"SUBSCRIPTION_LEDGER","bookingEnabled":True,
          "latestCycle":None,"compensationUnspentSessions":0,
          "compensationGrantCount":0}).encode(),{})):
   with self.assertRaisesRegex(RuntimeError,"fabricated a paid balance"):
    self.run_stage()
 def test_unexpected_existing_synthetic_credit_row_fails(self):
  self.migration.write_text("-- test fixture only")
  with patch.object(stage,"d1_read_only",side_effect=[
     [{"version":1}],[{"cycles":1,"grants":0,"spends":0}]]),\
       patch.object(stage,"http") as http:
   with self.assertRaisesRegex(RuntimeError,"unexpectedly has entitlement rows"):
    self.run_stage()
   http.assert_not_called()

if __name__=="__main__":main()
