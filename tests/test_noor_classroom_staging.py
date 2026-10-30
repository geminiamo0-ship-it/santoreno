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
