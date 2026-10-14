"""CI-only negative tests for the private GitHub-release medical archive gate."""
import hashlib
import tempfile
from pathlib import Path
from zipfile import ZipFile
import unittest

from verify_medical_library_bundle import verify_and_extract
from upload_medical_libraries_r2 import metadata_for
from upload_medical_libraries_wrangler import collect


class MedicalCorpusImportTests(unittest.TestCase):
    def make_zip(self, parent, key):
        path = parent / "bundle.zip"
        with ZipFile(path, "w") as archive:
            archive.writestr(key, "marker")
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_correct_search_metadata(self):
        self.assertEqual(
            metadata_for("medical-search/v1/amboss/unnamed-99/s-0002.md"),
            {"library_id": "amboss", "article_id": "unnamed-99", "section_id": "s-0002"},
        )
        self.assertEqual(metadata_for("medical-articles/v1/amboss/unnamed-99.json"), {})

    def test_wrangler_uploader_selects_only_expected_private_prefixes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / "medical-search/v1/amboss/item/s-0001.md"
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("Licensed sample excerpt")
            unauthorized = root / "licensed-original.sqlite"
            unauthorized.write_bytes(b"private")
            self.assertEqual([key for key, _ in collect(root)],
                             ["medical-search/v1/amboss/item/s-0001.md"])

    def test_rejects_unverified_bundle_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path, _ = self.make_zip(root, "medical-search/v1/amboss/article/s-0001.md")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                verify_and_extract(path, root / "out", "a" * 64)

    def test_rejects_traversal_even_with_valid_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path, digest = self.make_zip(root, "../private-secret.txt")
            with self.assertRaisesRegex(ValueError, "Unsafe ZIP path"):
                verify_and_extract(path, root / "out", digest)
            self.assertFalse((root / "private-secret.txt").exists())

    def test_rejects_unexpected_content_even_when_hash_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path, digest = self.make_zip(root, "anything.sqlite")
            with self.assertRaisesRegex(ValueError, "Unexpected bundle object key"):
                verify_and_extract(path, root / "out", digest)

    def test_rejects_partial_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path, digest = self.make_zip(root, "medical-search/v1/amboss/abc/s-0001.md")
            with self.assertRaisesRegex(ValueError, "Incorrect bundle object counts"):
                verify_and_extract(path, root / "out", digest)


if __name__ == "__main__":
    unittest.main()
