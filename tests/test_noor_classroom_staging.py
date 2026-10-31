"""No-network failure gates for the Noor-only Cloudflare Classroom DO Dev test."""
import importlib.util
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock

file=Path(__file__).resolve().parents[1]/"scripts/noor_classroom_staging.py"
spec=importlib.util.spec_from_file_location("noor_classroom_staging",file)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
uid=lambda n:f"10000000-0000-4000-8000-{n:012d}"
class RoomDevGuards(TestCase):
 def values(self):
  return dict(origin="https://noor-site-staging.geminiamo0.workers.dev",
   database_id=uid(4),owner=object(),teacher=object(),learner_id=uid(1),
   other_learner=uid(2),lesson_id=uid(3),
   post=Mock(),http=Mock(),d1_read_only=Mock(),require_status=Mock(),json_body=Mock())
 def test_room_never_checks_remote_if_ids_forged(self):
  for key in ("database_id","learner_id","other_learner","lesson_id"):
   a=self.values();a[key]="forged-id"
   with self.assertRaisesRegex(RuntimeError,"non-synthetic"):
    module.verify_classroom_room(**a)
   a["post"].assert_not_called();a["http"].assert_not_called()
 def test_room_rejects_production_or_unrelated_origin(self):
  for origin in ("https://nour-elquran.example","http://noor-site-staging.example",
                 "https://noor-site-staging.evil.com"):
   a=self.values();a["origin"]=origin
   # The last case starts with the staging prefix; this test should ensure
   # URL suffix is a valid .workers.dev deployment instead of arbitrary host.
   with self.assertRaisesRegex(RuntimeError,"non-isolated"):
    module.verify_classroom_room(**a)
   a["http"].assert_not_called()
 def test_rejects_same_learner_and_sibling_identity(self):
  a=self.values();a["other_learner"]=a["learner_id"]
  with self.assertRaisesRegex(RuntimeError,"identical sibling"):
   module.verify_classroom_room(**a)
  a["post"].assert_not_called()


class BrowserDevEndGuards(TestCase):
 def values(self):
  import json
  owner,teacher=object(),object()
  def http(origin,path,opener=None):
   if path.endswith("/lifecycle"):
    return 200,json.dumps({"lifecycle":{"phase":"completed","startedAtMs":1000,
     "endedAtMs":2000}}).encode(),{"Cache-Control":"no-store"}
   if path.endswith("/report"):
    return 200,json.dumps({"report":{"status":"draft","revision":1}}).encode(),{}
   if path.endswith("/reports"):
    return 200,json.dumps({"reports":[]}).encode(),{}
   raise AssertionError("Unexpected remote path")
  def require_status(actual,expected,label):
   self.assertEqual(actual,expected,label)
  return dict(origin="https://noor-site-staging.geminiamo0.workers.dev",
   database_id=uid(4),owner=owner,teacher=teacher,learner_id=uid(1),
   lesson_id=uid(3),http=Mock(side_effect=http),
   d1_read_only=Mock(return_value=[{"action":"start"},{"action":"end"}]),
   require_status=require_status,json_body=lambda raw:json.loads(raw))
 def test_browser_completed_requires_isolated_hostname(self):
  a=self.values();a["origin"]="https://noor-site-staging.evil.com"
  with self.assertRaisesRegex(RuntimeError,"isolated"):
   module.verify_browser_lesson_completion(**a)
  a["http"].assert_not_called();a["d1_read_only"].assert_not_called()
 def test_browser_completed_denies_wrong_synthetic_identity(self):
  a=self.values();a["learner_id"]="not-a-uuid"
  with self.assertRaisesRegex(RuntimeError,"synthetic"):
   module.verify_browser_lesson_completion(**a)
  a["http"].assert_not_called()
 def test_browser_completed_requires_exact_d1_start_end_audit(self):
  a=self.values();a["d1_read_only"].return_value=[{"action":"start"}]
  with self.assertRaisesRegex(RuntimeError,"two D1 audit"):
   module.verify_browser_lesson_completion(**a)
 def test_browser_completed_requires_private_teacher_report_seed(self):
  import json
  a=self.values()
  original=a["http"].side_effect
  def no_seed(origin,path,opener=None):
   if path.endswith("/report"):
    return 200,json.dumps({"report":None}).encode(),{}
   return original(origin,path,opener=opener)
  a["http"].side_effect=no_seed
  with self.assertRaisesRegex(RuntimeError,"private Sheikh report"):
   module.verify_browser_lesson_completion(**a)
 def test_browser_signed_end_succeeds_only_with_d1_and_private_report(self):
  a=self.values()
  self.assertTrue(module.verify_browser_lesson_completion(**a))
  self.assertEqual(a["d1_read_only"].call_count,1)
