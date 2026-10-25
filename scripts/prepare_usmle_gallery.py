#!/usr/bin/env python3
"""Prepare owner-supplied USMLE image records for staged Santo Gallery ingestion.

No Cloudflare writes. Do not commit the source JSONL or generated patient/media
metadata to public Git. Rights-locked/quality-flagged figures never emit index items.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

IMAGE_ID = re.compile(r"usmle_[LUB][0-9]{1,9}\Z")
IMAGE_PATH = re.compile(r"/offline_media/[LUB][0-9]{1,9}\.(?:png|jpe?g|webp|gif)\Z", re.I)
IMAGE_HOST = "pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev"

# Figures independently identified in the owner's previously shared screenshots.
# These six corrections are exceptions, not fabricated visual validation for others.
OWNER_REVIEWED_TITLES = {
    "usmle_L93791": "Nonbullous impetigo",
    "usmle_L34244": "Pemphigus vulgaris — skin erosions",
    "usmle_L89834": "Pemphigus vulgaris — intraepithelial cleavage",
    "usmle_L136562": "Port-wine stain (capillary malformation)",
    "usmle_L57542": "Mitral stenosis — hemodynamic consequences",
    "usmle_L10619": "Erythema marginatum",
}

def compact(value: object, limit: int = 1000) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", value)).strip()[:limit]

def safe_image_url(url: object, image_id: str) -> bool:
    if not isinstance(url, str):
        return False
    try:
        p = urlsplit(url)
        return (
            p.scheme == "https" and p.hostname == IMAGE_HOST
            and p.port is None and not p.username and not p.password
            and not p.query and not p.fragment and IMAGE_PATH.fullmatch(p.path) is not None
            and Path(p.path).stem == image_id[len("usmle_"):]
        )
    except ValueError:
        return False

def normalize(row: dict, *, owner_rights_attested: bool = False) -> tuple[dict, list[str]]:
    errors = []
    image_id = row.get("image_id")
    if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
        return {}, ["invalid_image_id"]
    if not safe_image_url(row.get("image_url"), image_id):
        errors.append("invalid_or_mismatched_url")
    if not isinstance(row.get("sources"), list) or not row["sources"]:
        errors.append("missing_source_links")

    caption = compact(OWNER_REVIEWED_TITLES.get(image_id) or row.get("generated_caption"), 140)
    context = compact(row.get("associated_text"), 850)
    if len(caption) < 8 or len(caption.split()) < 2:
        errors.append("weak_caption")
    if len(context) < 24:
        errors.append("weak_image_specific_context")
    modality = compact(row.get("image_modality"), 80)
    if not modality:
        modality = "unknown"
    parts = ["IMAGE: " + caption]
    if context:
        parts.append("FIGURE-ASSOCIATED CONTEXT: " + context)
    if modality != "unknown":
        parts.append("TYPE: " + modality)
    # Deliberately exclude parent article/section from indexed text. A
    # differential-diagnosis figure must not rank as the parent's disease.
    # Explicit 2026-10-25 rights attestation by the owner applies to this
    # submitted USMLE dataset; original Gemini rights flags remain in raw source.
    # Manual-only approval is opt-in, never inferred from a caption or URL.
    rights_ok = owner_rights_attested or row.get("rights_status") in (
        "approved", "licensed", "rights_cleared"
    )
    display_ok = owner_rights_attested or row.get("display_ready") is True
    if row.get("association_confidence") == "low" or row.get("caption_provenance") == "section_heading_fallback":
        errors.append("weak_image_specific_association")
    qa_flags = errors + ([] if rights_ok else ["rights_not_confirmed"]) + (
        [] if display_ok else ["source_display_locked"]
    )
    return {
        "image_id": image_id,
        "image_url": row.get("image_url"),
        "title": caption,
        "description": context,
        "search_text": "\n".join(parts),
        "image_modality": modality,
        "primary_system": compact(row.get("medical_system"), 140),
        "source_name": "USMLE Step 1 Medical Library",
        "sources": row.get("sources") if isinstance(row.get("sources"), list) else [],
        "caption_provenance": "owner_sample_review" if image_id in OWNER_REVIEWED_TITLES else row.get("caption_provenance"),
        "association_confidence": row.get("association_confidence", "unknown"),
        "visually_verified": False,
        # A URL fingerprint is never misrepresented as a content-byte hash.
        "url_fingerprint_sha256": hashlib.sha256(str(row.get("image_url", "")).encode()).hexdigest(),
        "rights_status": "approved" if rights_ok else row.get("rights_status", "unknown"),
        "rights_attestation": "owner_asserted_2026-10-25" if owner_rights_attested else None,
        "display_ready": display_ok,
        "eligible_for_publish": rights_ok and display_ok and not errors,
        "qa_flags": qa_flags,
    }, errors

def prepare(input_file: Path, output_dir: Path, *, expected_count: int | None = None, owner_rights_attested: bool = False) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    items_dir = output_dir / "approved_items"
    items_dir.mkdir(exist_ok=True)
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    flags: Counter[str] = Counter()
    modalities: Counter[str] = Counter()
    count = 0
    indexed = 0
    references = 0
    manifest = {}
    with input_file.open(encoding="utf-8") as f, (
        output_dir / "private_review.jsonl"
    ).open("w", encoding="utf-8") as review:
        for line_number, line in enumerate(f, 1):
            if not line.strip():
                continue
            raw = json.loads(line)
            record, errors = normalize(raw, owner_rights_attested=owner_rights_attested)
            image_id = record.get("image_id")
            if not image_id or image_id in seen_ids or record["image_url"] in seen_urls:
                raise ValueError(f"Duplicate or invalid image on line {line_number}")
            seen_ids.add(image_id)
            seen_urls.add(record["image_url"])
            count += 1
            references += len(record["sources"])
            flags.update(record["qa_flags"])
            modalities.update([record["image_modality"]])
            review.write(json.dumps(record, ensure_ascii=False) + "\n")
            if not record["eligible_for_publish"]:
                continue
            indexed += 1
            name = image_id + ".json"
            (items_dir / name).write_text(json.dumps({
                "image_id": image_id, "title": record["title"],
                "search_text": record["search_text"],
            }, ensure_ascii=False), encoding="utf-8")
            manifest[image_id] = {
                "image_url": record["image_url"],
                "title": record["title"],
                "visual_caption": record["description"][:500],
                "primary_system": record["primary_system"],
                "source_name": record["source_name"],
                "rights_status": "approved",
                "display_ready": True,
            }
    if expected_count is not None and count != expected_count:
        raise ValueError(f"Expected {expected_count}, found {count}; do not publish")
    (output_dir / "usmle_image_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    summary = {
        "total_records": count, "unique_urls": len(seen_urls),
        "source_references": references, "approved_for_index": indexed,
        "blocked_for_index": count - indexed,
        "qa_flags": dict(flags), "modalities": dict(modalities),
        "cloudflare_mutations": 0,
        "rights_attestation": "owner_asserted_2026-10-25" if owner_rights_attested else None,
    }
    (output_dir / "qa_summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return summary

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--expected-count", type=int, default=4525)
    p.add_argument("--owner-rights-attested", action="store_true",
                   help="Explicit user attestation for the exact USMLE ZIP only")
    a = p.parse_args()
    print(json.dumps(prepare(a.input, a.output, expected_count=a.expected_count,
                             owner_rights_attested=a.owner_rights_attested), indent=2))
