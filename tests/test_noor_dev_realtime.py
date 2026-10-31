"""Dev-only rollout gates for Noor signed live classroom ink and WebSocket."""
from pathlib import Path
from unittest import TestCase
import ast

ROOT=Path(__file__).resolve().parents[1]
class NoorDevRealtimeRolloutTests(TestCase):
 def test_dev_only_worker_flags_are_separate_from_production(self):
  content=(ROOT/"scripts/noor_private_staging.py").read_text()
  self.assertIn('if WORKER_NAME != "noor-site-staging" or DATABASE_NAME != "noor-core-staging"',content)
  tree=ast.parse(content)
  fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=="write_config")
  literals=[n.value for n in ast.walk(fn) if isinstance(n,ast.Constant) and isinstance(n.value,str)]
  for name in ("NOOR_REALTIME_HINTS_ENABLED","NOOR_CUMULATIVE_INK_ENABLED"):
   self.assertIn(name,literals)
  self.assertIn('"NOOR_REALTIME_HINTS_ENABLED": "true"',content)
  self.assertIn('"NOOR_CUMULATIVE_INK_ENABLED": "true"',content)
 def test_flags_are_embedded_only_in_isolated_dev_build(self):
  workflow=(ROOT/".github/workflows/noor-private-staging.yml").read_text()
  self.assertIn('NEXT_PUBLIC_NOOR_REALTIME_HINTS_ENABLED=true',workflow)
  self.assertIn('NEXT_PUBLIC_NOOR_REALTIME_PREVIEW_ENABLED=true',workflow)
  self.assertIn('python3 scripts/noor_source_gate.py',workflow)
  self.assertIn('repository: geminiamo0-ship-it/nour-elquran',workflow)
  self.assertNotIn('production deploy',workflow.lower())
