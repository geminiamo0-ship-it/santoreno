#!/usr/bin/env python3
"""Targeted repair for transient indexing errors after accepted USMLE Gallery import.

Never creates, deletes, or rewrites an AI Search instance, item content, source
bucket, or original 3,295 Gallery images. Retries only owner-cleared USMLE
items that are already in explicit "error" state. Fail closed on bad counts.
"""
import argparse
import os
import re
import time
from urllib.parse import quote

from ingest_santo_medical_gallery import Cloudflare, INSTANCE, EMBED
from ingest_usmle_gallery import TARGET_COMPLETED, counters, search_smoke

USMLE_ITEM = re.compile(r"usmle_[LUB]\d{1,9}\.json\Z")
TRANSIENT_ERRORS = frozenset({
    "workers_ai_timeout_error", "workers_ai_out_of_capacity_error",
    "unknown_error", "vectorize_rate_limit_error", "internal_error",
})
MAX_FAILED = 30
MAX_RETRIES = 2

def get_errors(cf: Cloudflare, expected: int):
    rows = cf.call("GET", f"/instances/{INSTANCE}/items?status=error&per_page=50&source=builtin")
    if not isinstance(rows, list):
        raise RuntimeError("Cloudflare failed item response malformed")
    if len(rows) != expected:
        raise RuntimeError(f"Error count changed or pagination incomplete ({len(rows)} vs {expected})")
    if not rows or len(rows) > MAX_FAILED:
        raise RuntimeError("Unexpected number of error items")
    for item in rows:
        if not isinstance(item, dict):
            raise RuntimeError("Malformed failed item")
        key = item.get("key")
        identity = item.get("id")
        status = item.get("status")
        reason = str(item.get("error") or "").lower().strip()
        if (not isinstance(key, str) or not USMLE_ITEM.fullmatch(key)
                or not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f-]{32,40}", identity)
                or status != "error" or item.get("source_id") != "builtin"):
            raise RuntimeError("Non-USMLE item error present; refusing targeted repair")
        if reason not in TRANSIENT_ERRORS:
            raise RuntimeError(f"Non-transient indexing error for {key}: {reason[:80]}")
    return rows

def index_status(cf: Cloudflare):
    stats = counters(cf)
    clean = {k: int(stats.get(k) or 0) for k in
             ("completed","queued","running","error","skipped","degraded")}
    if clean["completed"] + clean["queued"] + clean["running"] + clean["error"] + clean["skipped"] != TARGET_COMPLETED:
        raise RuntimeError(f"Unexpected Gallery total; abort {clean}")
    if clean["skipped"] or clean["degraded"]:
        raise RuntimeError(f"Gallery skipped/degraded, abort {clean}")
    return clean

def repair(cf: Cloudflare):
    if os.environ.get("SANTO_USMLE_OWNER_APPROVED_20261025") != "true":
        raise RuntimeError("Owner's explicit rights attestation not present")
    instance = cf.call("GET", f"/instances/{INSTANCE}")
    if (not isinstance(instance, dict) or instance.get("id") != INSTANCE
            or instance.get("embedding_model") != EMBED or instance.get("source")
            or instance.get("type") == "r2"):
        raise RuntimeError("Gallery identity/configuration unexpectedly changed")
    stats = index_status(cf)
    print("RECOVERY_START_STATS", stats, flush=True)
    if stats["error"] > MAX_FAILED:
        raise RuntimeError("Too many failures for isolated recovery")
    cycles = 0
    deadline = time.monotonic() + 45 * 60
    last = None
    last_retry = 0.0
    while time.monotonic() < deadline:
        stats = index_status(cf)
        marker = tuple(stats.values())
        if marker != last:
            print("RECOVERY_INDEX_STATS", stats, flush=True)
            last = marker
        if stats["completed"] == TARGET_COMPLETED and not any(
            stats[k] for k in ("queued", "running", "error", "skipped", "degraded")
        ):
            print("TARGET_GALLERY_COMPLETED", TARGET_COMPLETED, flush=True)
            search_smoke(cf)
            return
        if stats["error"] and not stats["queued"] and not stats["running"]:
            if cycles == MAX_RETRIES:
                raise RuntimeError(f"Transient errors persist after {MAX_RETRIES} targeted retries")
            if time.monotonic() < last_retry + 90:
                time.sleep(15)
                continue
            failures = get_errors(cf, stats["error"])
            print("TRANSIENT_ITEMS_TO_RETRY", [(x["key"],x["error"]) for x in failures], flush=True)
            for item in failures:
                identity = quote(item["id"],safe="")
                result = cf.call("PATCH", f"/instances/{INSTANCE}/items/{identity}",
                                 json_body={"next_action":"INDEX"}, timeout=40)
                if not isinstance(result, dict) or result.get("id") != item["id"]:
                    raise RuntimeError("Targeted sync did not confirm expected item")
                print("REQUEUED_FAILED_USMLE_ITEM", item["key"], flush=True)
                time.sleep(0.5)
            cycles += 1
            last_retry = time.monotonic()
            print("RECOVERY_ROUND", cycles, "items", len(failures), flush=True)
        time.sleep(20)
    raise RuntimeError("Recovery bounded deadline exceeded; manifest/deploy blocked")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute",action="store_true")
    a = parser.parse_args()
    if not a.execute:
        raise SystemExit("Requires explicit --execute; this script never uploads files")
    repair(Cloudflare())
