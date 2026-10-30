"""No-network guard for Noor-only Wrangler secret-name inventory."""
import importlib.util
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock,patch

src=Path(__file__).resolve().parents[1]/"scripts/noor_livekit_secret_presence.py"
spec=importlib.util.spec_from_file_location("noor_secret_presence",src)
target=importlib.util.module_from_spec(spec)
spec.loader.exec_module(target)

class SecretPresenceGuards(TestCase):
 def test_only_expected_metadata_names_and_types(self):
  self.assertEqual(target.secret_names([
   {"name":"LIVEKIT_URL","type":"secret_text"},
   {"name":"LIVEKIT_API_KEY","type":"secret_text"},
   {"name":"LIVEKIT_API_SECRET","type":"secret_text"},
   {"name":"NON_SECRET","type":"plain_text"}]),
   {"LIVEKIT_URL","LIVEKIT_API_KEY","LIVEKIT_API_SECRET"})
  for payload in ({},[{"name":"LIVEKIT_URL"}],[{"value":"sensitive","type":"secret_text"}]):
   with self.assertRaises(ValueError):
    target.secret_names(payload)
 def test_target_is_constant_and_only_secret_list(self):
  self.assertEqual(target.WORKER,"noor-site-staging")
  with patch.dict("os.environ",{
    "CLOUDFLARE_ACCOUNT_ID":"synthetic",
    "CLOUDFLARE_API_TOKEN":"synthetic",
  }),patch.object(target.subprocess,"run",return_value=Mock(
    returncode=0,stdout='[{"name":"LIVEKIT_URL","type":"secret_text"},'
    '{"name":"LIVEKIT_API_KEY","type":"secret_text"},'
    '{"name":"LIVEKIT_API_SECRET","type":"secret_text"}]',stderr=""
  )) as runner:
   self.assertTrue(target.probe())
   command=runner.call_args.args[0]
   self.assertEqual(command[0:5],["npx","--yes","wrangler@4.45.0","secret","list"])
   self.assertEqual(command[5:],["--name","noor-site-staging","--format","json"])
 def test_incomplete_metadata_is_failure(self):
  with patch.dict("os.environ",{
    "CLOUDFLARE_ACCOUNT_ID":"synthetic",
    "CLOUDFLARE_API_TOKEN":"synthetic",
  }),patch.object(target.subprocess,"run",return_value=Mock(
    returncode=0,stdout='[]',stderr=""
  )):
   self.assertFalse(target.probe())
