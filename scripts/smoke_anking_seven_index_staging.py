#!/usr/bin/env python3
"""Staging-only read-only seven-instance namespace search.
Checks that exam-memory hits never replace the five medically sourced evidence libraries.
"""
from collections import Counter
import os
import requests

IDS = (
    "amboss", "usmle", "passmedicine", "pastest",
    "one-examination-isolated", "santo-medical-images", "santo-anking-cardiology"
)
endpoint = (
    f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}"
    "/ai-search/namespaces/default/search"
)
headers = {"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]}
queries = [
    "aortic stenosis systolic murmur radiates to carotids",
    "ventricular septal defect holosystolic murmur left lower sternal border",
]
for query in queries:
    request = {
        "query": query,
        "ai_search_options": {
            "instance_ids": list(IDS),
            "retrieval": {
                "retrieval_type": "hybrid", "match_threshold": 0.4,
                "max_num_results": 60, "return_on_failure": True, "fusion_method": "rrf",
            },
            "reranking": {"enabled": True, "model": "@cf/baai/bge-reranker-base"},
            "query_rewrite": {"enabled": False},
        },
    }
    response = requests.post(endpoint, json=request, headers=headers, timeout=90)
    data = response.json()
    if not response.ok or data.get("success") is False:
        raise RuntimeError(
            f"Seven-instance Cloudflare search failed: HTTP {response.status_code} codes " +
            str([x.get("code") for x in data.get("errors", []) if isinstance(x, dict)])
        )
    result = data.get("result")
    if not isinstance(result, dict) or result.get("errors") or not isinstance(result.get("chunks"), list):
        raise RuntimeError("Invalid or partially failed multi-instance result")
    instances = Counter(item.get("instance_id") for item in result["chunks"])
    if any(x not in IDS for x in instances):
        raise RuntimeError("Returned unauthorized foreign instances")
    clinical = sum(instances.get(name, 0) for name in IDS[:5])
    anking = instances.get("santo-anking-cardiology", 0)
    print(f"Query: {query} — clinical={clinical}, AnKing={anking}, gallery={instances.get('santo-medical-images',0)}", flush=True)
    if clinical < 1 or anking < 1:
        raise RuntimeError("Missing necessary clinical or AnKing result: tune recall before deployment")
print("SEVEN_INDEX_ONE_CALL_STAGING_SMOKE_PASSED", flush=True)
