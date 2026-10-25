#!/usr/bin/env python3
"""Final staging-only release gate for owner-approved USMLE Gallery metadata.

Allow either an entirely successful 7,534-item combined Gallery index, or
exactly one known transient failure (usmle_L116818.json). In the latter case
remove that image from the NEW USMLE manifest ONLY, leaving the failed index
item and all existing R2/image/search sources untouched.

No delete, re-index, item upload, or other Cloudflare mutation occurs here.
"""
import argparse
import json
import os
from pathlib import Path
import re

LEGACY_COUNT = 3295
USMLE_APPROVED_COUNT = 4239
TOTAL_COUNT = LEGACY_COUNT + USMLE_APPROVED_COUNT
KNOWN_ERROR_FILENAME = "usmle_L116818.json"
KNOWN_ERROR_ID = "usmle_L116818"
KNOWN_ERROR_CAUSE = "workers_ai_timeout_error"
FIELDS = ("completed", "queued", "running", "error", "skipped", "degraded")
IMG_ID = re.compile(r"usmle_[LUB]\d{1,9}\Z")


def validate_status(raw: dict, failed: list[dict]) -> str | None:
    """Return allowed excluded image ID, or None when all 7,534 succeed."""
    if not isinstance(raw, dict):
        raise RuntimeError("Gallery stats absent")
    if any(type(raw.get(field)) is not int or raw[field] < 0 for field in FIELDS):
        raise RuntimeError("Missing/non-integer Gallery stats")
    counts = {key: raw[key] for key in FIELDS}
    if (counts["completed"] + counts["queued"] + counts["running"]
            + counts["error"] + counts["skipped"]) != TOTAL_COUNT:
        raise RuntimeError(f"Unexpected Gallery total: {counts}")
    if counts["queued"] or counts["running"] or counts["skipped"] or counts["degraded"]:
        raise RuntimeError(f"Gallery not settled: {counts}")
    if counts["completed"] == TOTAL_COUNT and counts["error"] == 0:
        if failed:
            raise RuntimeError("Failed item list inconsistent with clean counters")
        return None
    if counts["completed"] != TOTAL_COUNT - 1 or counts["error"] != 1:
        raise RuntimeError(f"Only one known error may be waived: {counts}")
    if len(failed) != 1:
        raise RuntimeError("Exactly one failed index item must be attributable")
    item = failed[0]
    if not isinstance(item, dict):
        raise RuntimeError("Malformed failed item")
    if (item.get("key") != KNOWN_ERROR_FILENAME
            or item.get("source_id") != "builtin"
            or item.get("status") != "error"
            or item.get("error") != KNOWN_ERROR_CAUSE):
        raise RuntimeError("Error belongs to an unknown or non-transient item")
    if not isinstance(item.get("id"), str) or not re.fullmatch(r"[0-9a-f]{32}", item["id"]):
        raise RuntimeError("Failed item identity is malformed")
    return KNOWN_ERROR_ID


def filter_manifest(manifest: dict, excluded: str | None) -> dict:
    if not isinstance(manifest, dict) or len(manifest) != USMLE_APPROVED_COUNT:
        raise RuntimeError("Owner-approved USMLE manifest must contain 4,239 items")
    if not all(isinstance(key, str) and IMG_ID.fullmatch(key) for key in manifest):
        raise RuntimeError("Unexpected USMLE image IDs in manifest")
    if not all(isinstance(value, dict) and value.get("rights_status") == "approved"
               and value.get("display_ready") is True
               for value in manifest.values()):
        raise RuntimeError("Unapproved entry detected in USMLE manifest")
    if excluded:
        if excluded not in manifest:
            raise RuntimeError("Known error item missing from USMLE manifest")
        manifest = {key: value for key, value in manifest.items() if key != excluded}
    expected = USMLE_APPROVED_COUNT - int(bool(excluded))
    if len(manifest) != expected:
        raise RuntimeError("Manifest population mismatch")
    return manifest


def verify_and_prepare(manifest_path: Path) -> None:
    # No Cloudflare write operations, only GET and read-only medical search.
    from ingest_santo_medical_gallery import Cloudflare, INSTANCE, EMBED
    from ingest_usmle_gallery import counters, search_smoke

    if os.environ.get("SANTO_USMLE_OWNER_APPROVED_20261025") != "true":
        raise RuntimeError("Owner image-use attestation missing")
    cf = Cloudflare()
    instance = cf.call("GET", f"/instances/{INSTANCE}")
    if not isinstance(instance, dict) or instance.get("id") != INSTANCE:
        raise RuntimeError("Unexpected Gallery instance identity")
    if instance.get("embedding_model") != EMBED or instance.get("source") or instance.get("type") == "r2":
        raise RuntimeError("Gallery instance model/source mismatch")

    stats = {key: int(value or 0) for key, value in counters(cf).items()}
    errors = []
    if stats.get("error"):
        errors = cf.call("GET", f"/instances/{INSTANCE}/items?status=error&per_page=50&source=builtin")
        if not isinstance(errors, list):
            raise RuntimeError("Failed item listing unavailable")
    excluded = validate_status(stats, errors)
    original = json.loads(manifest_path.read_text(encoding="utf-8"))
    selected = filter_manifest(original, excluded)
    print("USMLE_GALLERY_RELEASE_COUNTERS", stats, flush=True)
    print("USMLE_EXCLUDED_KNOWN_TIMEOUT", excluded or "none", flush=True)
    print("USMLE_ALLOWED_MANIFEST_SIZE", len(selected), flush=True)
    # Search smoke before writing the approved output manifest.
    search_smoke(cf)
    tmp = manifest_path.with_suffix(".approved.tmp")
    tmp.write_text(json.dumps(selected, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, manifest_path)
    print("USMLE_SEARCH_SMOKE_AND_MANIFEST_GATE_PASS", len(selected), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    verify_and_prepare(args.manifest)
