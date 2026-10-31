"""Synthetic, no-Cloudflare tests of the Noor-only staging import gate (#236)."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
from unittest import TestCase,main
from unittest.mock import patch
os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID","synthetic-account-id")
os.environ.setdefault("CLOUDFLARE_API_TOKEN","synthetic-test-token")
os.environ.setdefault("NOOR_SHA","a"*40)
path=Path(__file__).resolve().parents[1]/"scripts/noor_private_staging.py"
spec=importlib.util.spec_from_file_location("noor_private_staging",path)
stage=importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
class SafeCanonTests(TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name)
  (self.root/"scripts").mkdir()
  (self.root/"scripts/noor_quran_anchor_import.py").write_text("# verified source")
  self.p=patch.object(stage,"NOOR",self.root)
  self.p.start();self.addCleanup(self.p.stop)
  # Each synthetic ayah must be unique for exact-row verification. No real text.
  self.rows=[(s,a,1+(s+a)%604,1+(a%10))
    for s in range(1,115) for a in range(1,56)][:6236]
  assert len(self.rows)==6236 and len({x[:2] for x in self.rows})==6236
 def generate(self,invalid_sha=False):
  def fake_run(argv,**kwargs):
   d=Path(argv[argv.index("--output-dir")+1])
   d.mkdir()
   (d/"verified-quran-anchors-evidence.json").write_text(json.dumps({
     "edition":stage.NOOR_EDITION,"manifest_sha256":stage.NOOR_MANIFEST_SHA,
     "word_source_sha256":"0"*64 if invalid_sha else stage.NOOR_HAFS_TEXT_SHA,
     "ayah_count":6236,"word_total":77432,"page_count":604}))
   (d/"verified-quran-anchors.sql").write_text(
     "".join("INSERT INTO quran_ayah_anchors(edition_id,surah,ayah,page,word_count) "
             f"VALUES('hafs-kfqc:v1.1.1',{s},{a},{p},{w});\n"
             for s,a,p,w in self.rows))
   return types.SimpleNamespace(returncode=0)
  return fake_run
 def test_reject_wrong_source_without_cloudflare_query_or_mutation(self):
  with patch.object(stage.subprocess,"run",side_effect=self.generate(invalid_sha=True)),\
       patch.object(stage,"d1_read_only") as read,patch.object(stage,"wrangler") as write:
   with self.assertRaisesRegex(RuntimeError,"source hashes"):
    stage.canonical_quran_staging(self.root/"config.json","12345678-1234-1234-1234-123456789abc",self.root)
   read.assert_not_called();write.assert_not_called()
 def test_existing_complete_matching_anchors_never_write(self):
  row_data=[dict(surah=s,ayah=a,page=p,word_count=w) for s,a,p,w in self.rows]
  existing=[[{"id":stage.NOOR_EDITION,"manifest_sha256":stage.NOOR_MANIFEST_SHA,"page_count":604}],row_data]
  with patch.object(stage.subprocess,"run",side_effect=self.generate()),\
       patch.object(stage,"d1_read_only",side_effect=existing),patch.object(stage,"wrangler") as write:
   stage.canonical_quran_staging(self.root/"config.json","12345678-1234-1234-1234-123456789abc",self.root)
   write.assert_not_called()
 def test_refuse_existing_partial_dataset(self):
  row_data=[dict(surah=s,ayah=a,page=p,word_count=w) for s,a,p,w in self.rows[:6235]]
  existing=[[{"id":stage.NOOR_EDITION,"manifest_sha256":stage.NOOR_MANIFEST_SHA,"page_count":604}],row_data]
  with patch.object(stage.subprocess,"run",side_effect=self.generate()),\
       patch.object(stage,"d1_read_only",side_effect=existing),patch.object(stage,"wrangler") as write:
   with self.assertRaisesRegex(RuntimeError,"partial or mismatched"):
    stage.canonical_quran_staging(self.root/"config.json","12345678-1234-1234-1234-123456789abc",self.root)
   write.assert_not_called()
 def test_empty_staging_requires_exact_post_write_readback(self):
  row_data=[dict(surah=s,ayah=a,page=p,word_count=w) for s,a,p,w in self.rows]
  sequence=[[],[],[{"id":stage.NOOR_EDITION,"manifest_sha256":stage.NOOR_MANIFEST_SHA,"page_count":604}],row_data]
  with patch.object(stage.subprocess,"run",side_effect=self.generate()),\
       patch.object(stage,"d1_read_only",side_effect=sequence),patch.object(stage,"wrangler") as write:
   stage.canonical_quran_staging(self.root/"config.json","12345678-1234-1234-1234-123456789abc",self.root)
   write.assert_called_once()
   self.assertIn("noor-core-staging",write.call_args.args)

class PrivateRecitationStageTests(TestCase):
 def setUp(self):
  self.learners=["10000000-0000-4000-8000-000000000001",
                 "10000000-0000-4000-8000-000000000002"]
  self.db_rows=[[{"version":1}],
    [{"name":"recitation_audio_upload_locked"},{"name":"recitation_consent_grant_locked"}],
    [{"n":0}]]
 def test_locked_migration_and_every_identity_boundary(self):
  def request(origin,path,opener=None,method="GET",body=None):
   if method=="POST":return (405,b'{}',{})
   if opener is None:return (401,b'{}',{})
   if opener=="foreign":return (404,b'{}',{})
   return (200,json.dumps({"uploadEnabled":False,"consentStatus":"not_available",
      "storageStatus":"not_configured","code":"AUDIO_PRIVACY_APPROVAL_REQUIRED"}).encode(),
      {"Cache-Control":"no-store"})
  with patch.object(stage,"d1_read_only",side_effect=self.db_rows) as read,\
       patch.object(stage,"http",side_effect=request) as http:
   stage.verify_disabled_recitation_audio("https://noor-dev.invalid",
     "12345678-1234-1234-1234-123456789abc","owner","foreign",self.learners)
   self.assertEqual(read.call_count,3)
   self.assertEqual(http.call_count,8)
 def test_missing_db_lock_fails_before_any_http(self):
  with patch.object(stage,"d1_read_only",side_effect=self.db_rows[:1]+[[]]) as read,\
       patch.object(stage,"http") as http:
   with self.assertRaisesRegex(RuntimeError,"lock missing"):
    stage.verify_disabled_recitation_audio("https://noor-dev.invalid",
      "12345678-1234-1234-1234-123456789abc","owner","foreign",self.learners)
   self.assertEqual(read.call_count,2)
   http.assert_not_called()
 def test_enabled_or_cacheable_audio_policy_fails_closed(self):
  def request(origin,path,opener=None,method="GET",body=None):
   if opener=="owner":return (200,json.dumps({"uploadEnabled":True,
       "consentStatus":"not_available","storageStatus":"not_configured",
       "code":"AUDIO_PRIVACY_APPROVAL_REQUIRED"}).encode(),{"Cache-Control":"no-store"})
   return (404,b'{}',{})
  with patch.object(stage,"d1_read_only",side_effect=self.db_rows),\
       patch.object(stage,"http",side_effect=request):
   with self.assertRaisesRegex(RuntimeError,"non-disabled"):
    stage.verify_disabled_recitation_audio("https://noor-dev.invalid",
      "12345678-1234-1234-1234-123456789abc","owner","foreign",self.learners)

 if __name__=="__main__":main()


class StagingSecretPreservationTests(TestCase):
 def setUp(self):
  self.candidate={"AUTH_SECRET":"a"*64,
                  "STAGING_ACCESS_PASSWORD":"b"*64}
 def test_redeploy_with_existing_names_never_rotates_either_secret(self):
  self.assertEqual(stage.select_missing_staging_secrets(
   self.candidate,{"AUTH_SECRET","STAGING_ACCESS_PASSWORD"}),{})
 def test_first_setup_only_initializes_missing_secret(self):
  self.assertEqual(stage.select_missing_staging_secrets(self.candidate,set()),
                   self.candidate)
  self.assertEqual(stage.select_missing_staging_secrets(
   self.candidate,{"AUTH_SECRET"}),{"STAGING_ACCESS_PASSWORD":"b"*64})
 def test_reject_malformed_names_and_secret_payload(self):
  with self.assertRaises(RuntimeError):
   stage.select_missing_staging_secrets(
    {**self.candidate,"OTHER_APP_TOKEN":"x"*64},set())
  with self.assertRaises(RuntimeError):
   stage.select_missing_staging_secrets(self.candidate,{"AUTH_SECRET",None})
  with self.assertRaises(RuntimeError):
   stage.select_missing_staging_secrets(
    {"AUTH_SECRET":"x","STAGING_ACCESS_PASSWORD":"b"*64},set())
 def test_names_are_read_from_metadata_only_and_no_production_worker(self):
  example=json.dumps([{"name":"AUTH_SECRET","type":"secret_text"},
                      {"name":"STAGING_ACCESS_PASSWORD","type":"secret_text"}])
  with patch.object(stage,"wrangler",return_value=example) as cli:
   result=stage.names_of_deployed_staging_secrets(Path("/tmp/noor-safe.json"))
  self.assertEqual(result,{"AUTH_SECRET","STAGING_ACCESS_PASSWORD"})
  self.assertEqual(cli.call_args.args[:2],("secret","list"))
  with patch.object(stage,"wrangler",return_value=json.dumps({"tokens":["forbidden"]})):
   with self.assertRaisesRegex(RuntimeError,"metadata"):
    stage.names_of_deployed_staging_secrets(Path("/tmp/noor-safe.json"))
