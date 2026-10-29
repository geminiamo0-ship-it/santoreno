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
 if __name__=="__main__":main()
