#!/usr/bin/env python3
"""Read-only timing comparison for Santo's ONE Cloudflare namespace search.
Never log secrets, medical user data, individual source text, or alter indexes.
"""
import json
import os
import statistics
import time
import urllib.request
import urllib.error

BASE = ("https://api.cloudflare.com/client/v4/accounts/"
        + os.environ["CLOUDFLARE_ACCOUNT_ID"]
        + "/ai-search/namespaces/default")
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
CLINICAL = {"amboss", "usmle", "passmedicine", "pastest", "one-examination-isolated"}
IMAGE = "santo-medical-images"
ANKING = "santo-anking-step-v12"
IDS = sorted(CLINICAL) + [IMAGE, ANKING]
CASES = (
    ("baseline_50_rerank", 50, True),
    ("reduced_30_rerank", 30, True),
    ("reduced_30_no_rerank", 30, False),
    ("reduced_24_rerank", 24, True),
)
QUERIES = (
    "aortic stenosis systolic murmur radiates to carotid arteries",
    "ventricular septal defect holosystolic murmur left lower sternal border",
)
TIMEOUT = 33

def call(path, request_body=None):
    body = None if request_body is None else json.dumps(request_body).encode()
    request = urllib.request.Request(
        BASE + path, data=body,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST" if body else "GET",
    )
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            payload = json.load(response)
    except (urllib.error.URLError, TimeoutError) as error:
        elapsed = (time.perf_counter() - start) * 1000
        print("BENCH_ERROR", {"endpoint": path, "ms": round(elapsed),
                              "type": type(error).__name__}, flush=True)
        return None, elapsed
    elapsed = (time.perf_counter() - start) * 1000
    if not isinstance(payload, dict) or payload.get("success") is False:
        codes = [x.get("code") for x in payload.get("errors", []) if isinstance(x, dict)]
        print("BENCH_ERROR", {"endpoint": path, "ms": round(elapsed),
                              "codes": codes}, flush=True)
        return None, elapsed
    return payload.get("result"), elapsed

def main():
    raw, elapsed = call("/instances")
    print("BENCH_CATALOG", {"ms": round(elapsed), "valid": isinstance(raw, list)}, flush=True)
    for label, n, rerank in CASES:
        observations = []
        for query in QUERIES:
            opts = {
                "instance_ids": IDS,
                "retrieval": {
                    "retrieval_type": "hybrid",
                    "match_threshold": 0.4,
                    "max_num_results": n,
                    "return_on_failure": True,
                    "fusion_method": "rrf",
                },
                "reranking": {
                    "enabled": rerank,
                    **({"model": "@cf/baai/bge-reranker-base"} if rerank else {}),
                },
                "query_rewrite": {"enabled": False},
            }
            data, took = call("/search", {"query": query, "ai_search_options": opts})
            chunks = data.get("chunks") if isinstance(data, dict) else None
            errors = data.get("errors") if isinstance(data, dict) else None
            if not isinstance(chunks, list) or errors:
                print("BENCH_SAMPLE", {"case": label, "ms": round(took),
                     "failed": True, "partial": bool(errors)}, flush=True)
                continue
            counts = {x: 0 for x in IDS}
            for chunk in chunks:
                instance = chunk.get("instance_id") if isinstance(chunk, dict) else None
                if instance in counts:
                    counts[instance] += 1
            medical = sum(counts[x] for x in CLINICAL)
            hits = counts[ANKING]
            observations.append((took, medical, hits, counts[IMAGE]))
            print("BENCH_SAMPLE", {
                "case": label, "ms": round(took), "medical": medical,
                "anking": hits, "images": counts[IMAGE], "total": len(chunks),
                "clinical_indexes_represented": sum(counts[x] > 0 for x in CLINICAL),
            }, flush=True)
        if observations:
            times = [v[0] for v in observations]
            print("BENCH_SUMMARY", {
                "case": label, "samples": len(times),
                "min_ms": round(min(times)), "max_ms": round(max(times)),
                "median_ms": round(statistics.median(times)),
                "both_sources": all(v[1] > 0 and v[2] > 0 for v in observations),
            }, flush=True)

if __name__ == "__main__":
    main()
