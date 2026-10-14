"""CI-only negative tests for the private GitHub-release medical archive gate."""
import hashlib
import tempfile
from pathlib import Path
from zipfile import ZipFile
import unittest

from verify_medical_library_bundle import verify_and_extract
from medical_article_html import media_url, sanitize_medical_html
from upload_medical_libraries_r2 import metadata_for
from upload_medical_libraries_wrangler import collect


class MedicalCorpusImportTests(unittest.TestCase):
    def make_zip(self, parent, key):
        path = parent / "bundle.zip"
        with ZipFile(path, "w") as archive:
            archive.writestr(key, "marker")
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_original_html_keeps_medpark_amboss_structure_and_images(self):
        sample = ('<h2 id="arrhythmia">ECG</h2><div class="amboss-card">'
                  '<table><tr><th>Finding</th><td><img src="offline_media/L70427jpg.jpg" alt="ECG"></td></tr></table>'
                  '<span class="api" data-content="dGVzdA==">Flutter</span></div>')
        result = sanitize_medical_html(sample)
        self.assertIn('<h2 id="arrhythmia">ECG</h2>', result)
        self.assertIn('<table>', result)
        self.assertIn('class="api" data-content="dGVzdA=="', result)
        self.assertIn('src="https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/L70427jpg.jpg"', result)
        self.assertEqual(media_url("https://pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev/offline_media/L70427jpg.jpg"),
                         media_url("offline_media/L70427jpg.jpg"))

    def test_html_rejects_executable_markup_and_foreign_media(self):
        sample = ('<script>alert(1)</script><img src="https://evil.example/img.jpg">'
                  '<img src="javascript:alert(2)" onerror="alert(3)">'
                  '<img src="offline_media/ok.png" onload="evil()">'
                  '<a href="javascript:alert(3)" onclick="evil()">Safe</a>'
                  '<iframe src="https://evil.example">BAD</iframe>'
                  '<p style="color:#c00;background-image:url(javascript:evil())">Good</p>')
        result = sanitize_medical_html(sample)
        for forbidden in ["alert(", "<script", "<iframe", "onload", "onerror", "onclick", "https://evil.example",
                          "background-image", "javascript:", "BAD"]:
            self.assertNotIn(forbidden, result)
        self.assertIn("Good", result)
        self.assertIn('style="color:#c00"', result)
        self.assertIn(media_url("offline_media/ok.png"), result)
        self.assertIsNone(media_url("https://evil.example/offline_media/file.png"))
        self.assertIsNone(media_url("../offline_media/../secret.jpg"))

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
