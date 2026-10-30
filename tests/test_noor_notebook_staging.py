"""Only synthetic/no-network safety guards for Noor private notes staging (#258)."""
import importlib.util
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock

file=Path(__file__).resolve().parents[1]/"scripts/noor_notebook_staging.py"
spec=importlib.util.spec_from_file_location("noor_notebook_staging",file)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
uid=lambda n:f"10000000-0000-4000-8000-{n:012d}"
class NotebookDevGuards(TestCase):
 def values(self):
  return dict(origin="https://dev.invalid",database_id=uid(4),owner=object(),
   foreign=object(),learner_id=uid(1),other_learner=uid(2),lesson_id=uid(3),
   http=Mock(),post=Mock(),d1_read_only=Mock(return_value=[]),
   require_status=Mock(),json_body=Mock())
 def test_id_and_database_guards_before_any_read_or_mutation(self):
  for key,bad in (("learner_id","fake"),("other_learner","array"),
                  ("lesson_id","else"),("database_id","production")):
   kw=self.values();kw[key]=bad
   with self.assertRaisesRegex(RuntimeError,"invalid|missing"):
    module.verify_notebook_flow(**kw)
   kw["d1_read_only"].assert_not_called()
   kw["http"].assert_not_called()
   kw["post"].assert_not_called()
 def test_requires_0014_schema_before_any_account_request(self):
  kw=self.values()
  with self.assertRaisesRegex(RuntimeError,"schema not ready"):
   module.verify_notebook_flow(**kw)
  kw["d1_read_only"].assert_called_once_with(
   uid(4),"SELECT version FROM noor_schema_meta WHERE component='notebook_notes'")
  kw["http"].assert_not_called();kw["post"].assert_not_called()
