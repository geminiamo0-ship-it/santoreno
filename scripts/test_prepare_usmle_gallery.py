"""Unit tests for the fail-closed USMLE image preparation pipeline."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_usmle_gallery import normalize, prepare

BASE_URL = "https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/"

def source():
    return {
        "image_id": "usmle_L10619",
        "image_url": BASE_URL + "L10619.png",
        "generated_caption": "Rheumatic fever — IE and include erythema marginatum",
        "associated_text": "Skin findings include erythema marginatum and subcutaneous nodules",
        "image_modality": "Clinical Photograph",
        "medical_system": "Cardiology",
        "sources": [{"article_id": "142"}, {"article_id": "62"}],
        "rights_status": "unverified_rights_locked",
        "display_ready": False,
    }

class IndexPreparationTests(unittest.TestCase):
    def test_known_caption_correction_and_article_provenance(self):
        record, issues = normalize(source())
        self.assertEqual(record["title"], "Erythema marginatum")
        self.assertEqual(len(record["sources"]), 2)
        self.assertNotIn("endocarditis", record["search_text"].lower())
        self.assertFalse(record["visually_verified"])
        self.assertFalse(record["eligible_for_publish"])
        self.assertEqual(issues, [])

    def test_bogus_remote_host_and_mismatched_filename(self):
        invalid = source()
        invalid["image_url"] = "https://attacker.invalid/offline_media/L10619.png"
        record, issues = normalize(invalid)
        self.assertFalse(record["eligible_for_publish"])
        self.assertIn("invalid_or_mismatched_url", issues)
        invalid["image_url"] = BASE_URL + "L9999.png"
        _, issues = normalize(invalid)
        self.assertIn("invalid_or_mismatched_url", issues)

    def test_requires_rights_and_display_readiness(self):
        row = source()
        row["display_ready"] = True
        record, _ = normalize(row)
        self.assertFalse(record["eligible_for_publish"])
        row["rights_status"] = "approved"
        record, _ = normalize(row)
        self.assertTrue(record["eligible_for_publish"])

    def test_no_upload_items_for_unapproved_source(self):
        with tempfile.TemporaryDirectory() as td:
            inp = Path(td) / "input.jsonl"
            inp.write_text(json.dumps(source()) + "\n", encoding="utf-8")
            output = Path(td) / "output"
            report = prepare(inp, output, expected_count=1)
            self.assertEqual(report["approved_for_index"], 0)
            self.assertEqual(list((output / "approved_items").iterdir()), [])

    def test_only_approved_is_emitted_as_index_document(self):
        with tempfile.TemporaryDirectory() as td:
            inp = Path(td) / "input.jsonl"
            row = source()
            row.update(rights_status="approved", display_ready=True)
            inp.write_text(json.dumps(row) + "\n", encoding="utf-8")
            output = Path(td) / "output"
            report = prepare(inp, output, expected_count=1)
            self.assertEqual(report["approved_for_index"], 1)
            manifest = json.loads((output / "usmle_image_manifest.json").read_text())
            self.assertEqual(manifest["usmle_L10619"]["rights_status"], "approved")
            doc = json.loads((output / "approved_items/usmle_L10619.json").read_text())
            self.assertEqual(doc["title"], "Erythema marginatum")

    def test_owner_rights_attestation_for_this_dataset_only(self):
        row = source()
        normalized, issues = normalize(row, owner_rights_attested=True)
        self.assertEqual(issues, [])
        self.assertTrue(normalized["eligible_for_publish"])
        self.assertEqual(normalized["rights_status"], "approved")
        self.assertEqual(normalized["rights_attestation"], "owner_asserted_2026-10-25")
        self.assertFalse(normalized["visually_verified"])

    def test_low_confidence_never_published_even_with_rights(self):
        row = source()
        row["association_confidence"] = "low"
        normalized, issues = normalize(row, owner_rights_attested=True)
        self.assertFalse(normalized["eligible_for_publish"])
        self.assertIn("weak_image_specific_association", issues)

    def test_duplicate_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            inp = Path(td) / "input.jsonl"
            inp.write_text(json.dumps(source()) + "\n" + json.dumps(source()) + "\n")
            with self.assertRaises(ValueError):
                prepare(inp, Path(td) / "output", expected_count=2)

    def test_all_original_image_prefix_families(self):
        for prefix in ("L", "U", "B"):
            row = source()
            row["image_id"] = "usmle_" + prefix + "1234"
            row["image_url"] = BASE_URL + prefix + "1234.JPG"
            normalized, errors = normalize(row)
            self.assertNotIn("invalid_or_mismatched_url", errors)
            self.assertEqual(normalized["image_id"], row["image_id"])

if __name__ == "__main__":
    unittest.main()
