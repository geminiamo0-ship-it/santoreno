#!/usr/bin/env python3
"""Fail-closed read-only clinical/AnKing fast search acceptance in real Cloudflare staging."""
import json
import os
import time
import urllib.request

BASE = ("https://api.cloudflare.com/client/v4/accounts/" +
        os.environ["CLOUDFLARE_ACCOUNT_ID"] + "/ai-search/namespaces/default/search")
CLINICAL = ("amboss", "usmle", "passmedicine", "pastest", "one-examination-isolated")
ANKING = "santo-anking-step-v12"
IMAGE = "santo-medical-images"
IDS = (*CLINICAL, IMAGE, ANKING)
QUERIES = (
    "aortic stenosis systolic murmur radiates to carotid arteries",
    "ventricular septal defect holosystolic murmur left lower sternal border",
    "sarcoidosis diagnosis pulmonary manifestations treatment",
    "heart failure reduced ejection fraction guideline directed medication",
)
for query in QUERIES:
    body = {
        "query": query,
        "ai_search_options": {
            "instance_ids": list(IDS),
            "retrieval": {
                "retrieval_type": "hybrid",
                "match_threshold": 0.4,
                "max_num_results": 30,
                "return_on_failure": True,
                "fusion_method": "rrf",
            },
            "reranking": {"enabled": False},
            "query_rewrite": {"enabled": False},
        },
    }
    request = urllib.request.Request(BASE, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=18) as response:
        data = json.load(response)
    took = (time.perf_counter() - started) * 1000
    result = data.get("result") if data.get("success") else None
    if not isinstance(result, dict) or result.get("errors") or not isinstance(result.get("chunks"), list):
        raise RuntimeError("SANTO_FAST_SEARCH_PARTIAL_OR_INVALID")
    rows = result["chunks"]
    if len(rows) > 30:
        raise RuntimeError("SANTO_FAST_SEARCH_UNBOUNDED")
    counts = {name: 0 for name in IDS}
    for row in rows:
        instance = row.get("instance_id") if isinstance(row, dict) else None
        if instance not in counts:
            raise RuntimeError("SANTO_FAST_SEARCH_FOREIGN_LIBRARY")
        counts[instance] += 1
    medical = sum(counts[name] for name in CLINICAL)
    if medical == 0 or counts[ANKING] == 0 or took > 11500:
        raise RuntimeError(f"SANTO_FAST_SEARCH_GUARD_FAILED: ms={int(took)} medical={medical} anking={counts[ANKING]}")
    print("SANTO_FAST_ONE_CALL_PASSED",
          {"milliseconds": round(took), "medical": medical, "anking": counts[ANKING],
           "gallery": counts[IMAGE], "clinical_indexes": sum(counts[n] > 0 for n in CLINICAL)},
          flush=True)
print("SANTO_FAST_SEVEN_INDEX_PREDEPLOY_OK", flush=True)
