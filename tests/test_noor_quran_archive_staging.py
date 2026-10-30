"""No-network guard for Noor archive staging; prohibits synthetic archive writes."""
import importlib.util
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock

file=Path(__file__).resolve().parents[1]/"scripts/noor_quran_archive_staging.py"
spec=importlib.util.spec_from_file_location("noor_quran_archive_staging",file)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def id(i):return f"10000000-0000-4000-8000-{i:012d}"
class ArchiveReadOnlyStaging(TestCase):
 def args(self):
  return dict(origin="https://synthetic-dev.invalid",database_id=id(4),
   owner=object(),foreign=object(),learner=id(1),other_learner=id(2),
   lesson_id=id(3),http=Mock(),d1_read_only=Mock(return_value=[]),
   require_status=Mock(),json_body=Mock())
 def test_invalid_source_ids_never_reach_db_or_http(self):
  for key in ("learner","other_learner","lesson_id","database_id"):
   a=self.args();a[key]="forged"
   with self.assertRaisesRegex(RuntimeError,"invalid|absent"):
    module.verify_archive_readonly(**a)
   a["d1_read_only"].assert_not_called()
   a["http"].assert_not_called()
 def test_missing_schema_or_unexpected_seal_refuses_remote_calls(self):
  a=self.args()
  with self.assertRaisesRegex(RuntimeError,"0015 schema unavailable"):
   module.verify_archive_readonly(**a)
  a["http"].assert_not_called()
  a=self.args();a["d1_read_only"].side_effect=[[{"version":1}],[{"n":1}]]
  with self.assertRaisesRegex(RuntimeError,"Unexpected archive producer"):
   module.verify_archive_readonly(**a)
  a["http"].assert_not_called()
