"""No-network security test: LiveKit staging refuses wrong target/IDs before HTTP."""
import importlib.util
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock

source=Path(__file__).resolve().parents[1]/"scripts/noor_livekit_staging.py"
spec=importlib.util.spec_from_file_location("noor_livekit_staging",source)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def uid(n):return f"10000000-0000-4000-8000-{n:012d}"
class MediaGatewayDeny(TestCase):
 def setup(self):
  return dict(origin="https://noor-site-staging.geminiamo0.workers.dev",
   owner=object(),teacher=object(),learner_id=uid(1),other_learner=uid(2),lesson_id=uid(3),
   post=Mock(),http=Mock(),require_status=Mock(),json_body=Mock())
 def test_bad_ids_prevent_http(self):
  for field in ("learner_id","other_learner","lesson_id"):
   a=self.setup();a[field]="untrusted/room"
   with self.assertRaisesRegex(RuntimeError,"synthetic identity"):
    module.verify_livekit_unconfigured(**a)
   a["http"].assert_not_called();a["post"].assert_not_called()
 def test_wrong_origin_never_executes(self):
  for origin in ("https://noor-site-staging.evil.com",
                 "https://noor-public.workers.dev",
                 "http://noor-site-staging.geminiamo0.workers.dev"):
   a=self.setup();a["origin"]=origin
   with self.assertRaisesRegex(RuntimeError,"non-isolated"):
    module.verify_livekit_unconfigured(**a)
   a["http"].assert_not_called()
 def test_identical_learners_denied(self):
  a=self.setup();a["other_learner"]=a["learner_id"]
  with self.assertRaisesRegex(RuntimeError,"duplicate learner"):
   module.verify_livekit_unconfigured(**a)
