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
    module.verify_livekit_gateway(**a)
   a["http"].assert_not_called();a["post"].assert_not_called()
 def test_wrong_origin_never_executes(self):
  for origin in ("https://noor-site-staging.evil.com",
                 "https://noor-public.workers.dev",
                 "http://noor-site-staging.geminiamo0.workers.dev"):
   a=self.setup();a["origin"]=origin
   with self.assertRaisesRegex(RuntimeError,"non-isolated"):
    module.verify_livekit_gateway(**a)
   a["http"].assert_not_called()
 def test_identical_learners_denied(self):
  a=self.setup();a["other_learner"]=a["learner_id"]
  with self.assertRaisesRegex(RuntimeError,"duplicate learner"):
   module.verify_livekit_gateway(**a)

 def test_strict_token_checks_deny_unsafe_grants(self):
  import base64,json,time
  def token(video=None,offset=0):
   grants={"room":"nq-"+"a"*32,"roomJoin":True,"roomAdmin":False,"roomCreate":False,
     "roomList":False,"roomRecord":False,"canPublish":True,
     "canPublishSources":["camera","microphone"],"canPublishData":False,
     "canSubscribe":True,"canUpdateOwnMetadata":False}
   if video:grants.update(video)
   def enc(v):return base64.urlsafe_b64encode(json.dumps(v).encode()).decode().rstrip("=")
   now=int(time.time())
   return ".".join([enc({"alg":"HS256","typ":"JWT"}),
      enc({"iss":"syntheticissuer","sub":"nq-"+"b"*32,"iat":now,
           "nbf":now,"exp":now+120+offset,"jti":"synthetic-jti","video":grants}),
      "syntheticSignature"])
  self.assertEqual(module._jwt_claims(token())["room"],"nq-"+"a"*32)
  for unsafe in ({"roomAdmin":True},{"roomRecord":True},{"canPublishData":True},
                 {"canPublishSources":["screen_share"]},{"roomList":True}):
   with self.assertRaises(RuntimeError):
    module._jwt_claims(token(unsafe))
  with self.assertRaises(RuntimeError):module._jwt_claims(token(offset=100))
  with self.assertRaises(RuntimeError):module._jwt_claims("a.b.c")
 def test_server_url_is_cloud_only(self):
  self.assertTrue(module._valid_server_url("wss://example-123.livekit.cloud"))
  for url in ("https://example-123.livekit.cloud",
              "wss://example-123.livekit.cloud/path",
              "wss://example-123.livekit.cloud:7880",
              "wss://example-123.livekit.cloud.evil.com"):
   self.assertFalse(module._valid_server_url(url))
