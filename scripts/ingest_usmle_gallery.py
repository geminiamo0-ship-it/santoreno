#!/usr/bin/env python3
"""Append owner-cleared USMLE image metadata to Santo's EXISTING Gallery instance.

Only item uploads. No instance creation, updates or deletion; no source media,
five clinical indexes, or legacy 3,295 gallery items are changed.
Safe to call from a short-lived GitHub Actions runner after a pinned-source gate.
"""
import argparse
import json
import os
from pathlib import Path
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from ingest_santo_medical_gallery import Cloudflare, INSTANCE, EMBED

LEGACY_COMPLETED = 3295
EXPECTED_USMLE = 4239
TARGET_COMPLETED = LEGACY_COMPLETED + EXPECTED_USMLE
IMAGE_KEY = re.compile(r"usmle_[LUB]\d{1,9}\.json\Z")

def counters(cf: Cloudflare) -> dict:
    stats = cf.call("GET", f"/instances/{INSTANCE}/stats")
    if not isinstance(stats, dict):
        raise RuntimeError("Missing Gallery index stats")
    return {key: stats.get(key, 0) for key in (
        "completed", "queued", "running", "error", "skipped", "degraded"
    )}

def require_original_gallery(cf: Cloudflare) -> dict:
    info = cf.call("GET", f"/instances/{INSTANCE}")
    if not isinstance(info, dict) or info.get("id") != INSTANCE:
        raise RuntimeError("Expected Gallery instance does not exist")
    if info.get("embedding_model") != EMBED:
        raise RuntimeError("Unexpected embedding model; STOP")
    if info.get("source") or info.get("type") == "r2":
        raise RuntimeError("Unexpected external data source; STOP")
    stats = counters(cf)
    if stats != {
        "completed": LEGACY_COMPLETED, "queued": 0, "running": 0,
        "error": 0, "skipped": 0, "degraded": 0,
    }:
        raise RuntimeError(f"Gallery not in exact validated legacy baseline; STOP: {stats}")
    print("ORIGINAL_GALLERY_VERIFIED", INSTANCE, stats, flush=True)
    return stats

def load_documents(folder: Path):
    paths = sorted(folder.glob("usmle_*.json"))
    if len(paths) != EXPECTED_USMLE:
        raise RuntimeError(f"Expected {EXPECTED_USMLE} licensed quality-cleared files, got {len(paths)}")
    documents = []
    for path in paths:
        if not IMAGE_KEY.fullmatch(path.name):
            raise RuntimeError("Unsafe image item filename")
        raw = path.read_bytes()
        record = json.loads(raw)
        if record.get("image_id") + ".json" != path.name:
            raise RuntimeError("Image document ID and name do not match")
        text = record.get("search_text")
        if not isinstance(text, str) or len(text) < 25:
            raise RuntimeError("Insufficient image-specific retrieval context")
        if len(raw) > 7000:
            raise RuntimeError("Oversized input document")
        documents.append((path.name, raw))
    return documents

def upload(cf: Cloudflare, docs, max_workers: int):
    failures = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        tasks = [pool.submit(cf.upload, item) for item in docs]
        for count, future in enumerate(as_completed(tasks), 1):
            name, error = future.result()
            if error:
                failures.append((name, error))
            if count % 250 == 0 or count == len(docs):
                print("USMLE_ITEMS_SUBMITTED", count, "of", len(docs), "failures", len(failures), flush=True)
    if failures:
        print("USMLE_UPLOAD_FAILING_IDS", [row[0] for row in failures[:15]], flush=True)
        raise RuntimeError(f"{len(failures)} uploads failed; USMLE Gallery flag remains OFF")
    print("USMLE_ITEMS_UPLOAD_ACCEPTED", len(docs), flush=True)

def wait_ready(cf: Cloudflare, minutes: int):
    end = time.monotonic() + minutes * 60
    last = None
    while time.monotonic() < end:
        try:
            stats = counters(cf)
        except Exception as exc:
            print("STATS_TEMPORARILY_UNAVAILABLE", type(exc).__name__, flush=True)
            time.sleep(25)
            continue
        current = tuple(stats.values())
        if current != last:
            print("USMLE_GALLERY_INDEXING", stats, flush=True)
            last = current
        if stats["error"] or stats["skipped"] or stats["degraded"]:
            raise RuntimeError("Gallery indexing contains errors/skips/degraded; do not publish")
        if (stats["completed"] == TARGET_COMPLETED
            and stats["queued"] == 0 and stats["running"] == 0):
            print("USMLE_GALLERY_FULLY_INDEXED", TARGET_COMPLETED, flush=True)
            return
        if stats["completed"] > TARGET_COMPLETED:
            raise RuntimeError("Unexpected extra gallery items/index changed during import")
        time.sleep(25)
    raise RuntimeError("Indexing incomplete at bounded deadline; leave staging feature disabled")

def search_smoke(cf: Cloudflare):
    tests = [
        "Impetigo nonbullous skin lesions honey crust",
        "Pemphigus vulgaris flaccid bullae erosions",
        "Port wine stain capillary vascular malformation",
        "Mitral stenosis hemodynamic consequences",
        "Erythema marginatum rheumatic fever skin rash",
    ]
    passed = 0
    for query in tests:
        response = cf.call("POST", f"/instances/{INSTANCE}/search", json_body={
            "messages": [{"role": "user", "content": query}],
            "ai_search_options": {
                "retrieval": {"max_num_results": 25, "retrieval_type": "hybrid"},
                "query_rewrite": {"enabled": False},
            },
        }, timeout=65)
        chunks = response.get("chunks") if isinstance(response, dict) else None
        if not isinstance(chunks, list):
            raise RuntimeError("Invalid Gallery search response")
        rank = next((i+1 for i, part in enumerate(chunks)
            if re.search(r"usmle_[LUB]\d{1,9}\.json$", str(
                (part.get("item") or {}).get("key", "")
            ))), None)
        print("SMOKE_USMLE_RELEVANT_RESULT", query[:38], "rank", rank, flush=True)
        if rank is not None:
            passed += 1
    if passed < 4:
        raise RuntimeError(f"Only {passed}/5 image-specific Gallery search queries matched; do not publish")
    print("USMLE_GALLERY_SEARCH_SMOKE_PASS", passed, "/ 5", flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--items-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--max-workers", type=int, default=3)
    parser.add_argument("--wait-minutes", type=int, default=45)
    args = parser.parse_args()
    if args.max_workers not in (1, 2, 3) or not 2 <= args.wait_minutes <= 90:
        parser.error("Refusing unexpected worker count or wait duration")
    documents = load_documents(args.items_dir)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if len(manifest) != EXPECTED_USMLE or set(manifest) != {
        doc[0][:-5] for doc in documents
    }:
        raise RuntimeError("Manifest and search items do not agree")
    for item in manifest.values():
        if item.get("rights_status") != "approved" or item.get("display_ready") is not True:
            raise RuntimeError("Unapproved image in candidate manifest")
    print("USMLE_IMAGE_BUNDLE_VALIDATED", len(documents), flush=True)
    if not args.execute:
        print("DRY_RUN_ONLY_NO_WRITES", flush=True)
        return
    if os.environ.get("SANTO_USMLE_OWNER_APPROVED_20261025") != "true":
        raise RuntimeError("Missing explicit owner rights attestation gate")
    cf = Cloudflare()
    require_original_gallery(cf)
    upload(cf, documents, args.max_workers)
    wait_ready(cf, args.wait_minutes)
    search_smoke(cf)
    print("READY_FOR_R2_MANIFEST_AND_STAGING_ONLY_FLAG", flush=True)

if __name__ == "__main__":
    main()
