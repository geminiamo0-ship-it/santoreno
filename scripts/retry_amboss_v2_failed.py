#!/usr/bin/env python3
"""Retry ONLY AMBOSS V2 articles that failed in the initial isolated build.

Intentionally leaves all original R2 buckets and AI Search 'amboss' untouched.
No secrets in GitHub source. Reads only Santo's original article JSONs; writes
only to the isolated V2 R2 bucket. Idempotent partial document overwrites.
"""
import importlib
import json
import os
import sys
import threading
import time

import build_amboss_hierarchical_v2 as build

FAILED_IDS = (
    "unnamed-2129", "unnamed-2119", "unnamed-2138", "unnamed-2139",
    "unnamed-2210", "unnamed-2332", "unnamed-2344", "unnamed-2564",
    "unnamed-2621", "unnamed-2624", "unnamed-2629", "unnamed-2630",
    "unnamed-2635", "unnamed-2917", "unnamed-3008", "unnamed-3009",
    "unnamed-3077", "unnamed-3087", "unnamed-3131", "unnamed-3148",
    "unnamed-3212", "unnamed-3223", "unnamed-3327", "unnamed-3324",
)

# Rate-limit the requests globally, including reads, to avoid repeated HTTP 429.
_original_api = build.api
_lock = threading.Lock()
_next_call = 0.0


def paced_api(*args, **kwargs):
    global _next_call
    with _lock:
        now = time.monotonic()
        time.sleep(max(0.0, _next_call - now))
        _next_call = time.monotonic() + 1.25
    return _original_api(*args, **kwargs)


build.api = paced_api


def main():
    if len(FAILED_IDS) != 24 or len(set(FAILED_IDS)) != 24:
        raise RuntimeError("Expected exactly 24 distinct failed article IDs")
    if build.DEST != "santo-amboss-hierarchical-v2" or build.SOURCE != "santo-content-staging":
        raise RuntimeError("Refusing nonisolated R2 bucket")
    catalog = build.get_json(build.SOURCE, build.CATALOG)["articles"]
    lookup = {entry["id"]: entry for entry in catalog}
    if len(lookup) != 1481 or not set(FAILED_IDS).issubset(lookup):
        raise RuntimeError("Original catalog is inconsistent with failed articles")
    results = []
    failures = []
    for number, ident in enumerate(FAILED_IDS, 1):
        for attempt in range(1, 5):
            try:
                item = build.process_article(lookup[ident])
                results.append(item)
                print(f"REPAIRED {number}/24 {ident}: {item['documents']} files", flush=True)
                break
            except Exception as exc:
                print(f"RETRY {ident} attempt {attempt}: {exc}", flush=True)
                if attempt == 4:
                    failures.append({"id": ident, "message": str(exc)})
                else:
                    time.sleep(30 * attempt)
    outcome = {
        "batch": "amboss-v2-initial-failed-24",
        "expected": 24,
        "repaired": len(results),
        "failures": failures,
        "documents_reuploaded": sum(x["documents"] for x in results),
    }
    with open("amboss-v2-repair-report.json", "w") as f:
        json.dump(outcome, f, indent=2)
    print(json.dumps(outcome), flush=True)
    if failures:
        sys.exit("Incomplete V2 repair; refuse cutover or readiness claims")
    print("All 24 failed article writes repaired; six AI Search embedding timeouts remain to be retried/verified.", flush=True)


if __name__ == "__main__":
    main()
