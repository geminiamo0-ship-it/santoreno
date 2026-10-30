"""No-network fail-closed smoke gates for Noor Phase 07A (#256)."""
import importlib.util
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock

source=Path(__file__).resolve().parents[1]/"scripts/noor_report_staging.py"
spec=importlib.util.spec_from_file_location("noor_report_staging",source)
report=importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)
ID_A="10000000-0000-4000-8000-000000000001"
ID_B="10000000-0000-4000-8000-000000000002"
ID_T="10000000-0000-4000-8000-000000000003"
DB="10000000-0000-4000-8000-000000000004"
class ReportStagingGate(TestCase):
 def kwargs(self):
  return dict(origin="https://noor-dev.invalid",database_id=DB,owner=object(),foreign=object(),
   learner_id=ID_A,other_learner=ID_B,teacher_id=ID_T,
   post=Mock(),http=Mock(),qa_write=Mock(),d1_read_only=Mock(return_value=[]),
   require_status=Mock(),json_body=Mock())
 def test_refuses_invalid_synthetic_identity_before_network(self):
  for field,value in [("learner_id","student?id=1"),("other_learner","other"),
                      ("teacher_id","012"),("database_id","production")]:
   args=self.kwargs()
   args[field]=value
   with self.assertRaisesRegex(RuntimeError,"refused|staging UUID"):
    report.verify_report_flow(**args)
   args["d1_read_only"].assert_not_called()
   args["qa_write"].assert_not_called()
   args["post"].assert_not_called()
 def test_refuses_missing_report_migration_without_mutation_or_http(self):
  args=self.kwargs()
  with self.assertRaisesRegex(RuntimeError,"migration 0013 absent"):
   report.verify_report_flow(**args)
  args["d1_read_only"].assert_called_once_with(
   DB,"SELECT version FROM noor_schema_meta WHERE component='lesson_reports'")
  args["http"].assert_not_called()
  args["qa_write"].assert_not_called()
  args["post"].assert_not_called()
