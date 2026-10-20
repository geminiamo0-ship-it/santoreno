#!/usr/bin/env python3
"""Read-only real Cloudflare verification: five clinical, gallery, full AnKing v12 in ONE call."""
import os
import requests

CLINICAL = ("amboss", "usmle", "passmedicine", "pastest", "one-examination-isolated")
GALLERY = "santo-medical-images"
ANKING = "santo-anking-step-v12"
IDS = (*CLINICAL, GALLERY, ANKING)
BASE = (
    f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}"
    "/ai-search/namespaces/default"
)
HEADERS = {"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]}


def result(response):
    payload = response.json()
    if not response.ok or payload.get("success") is False:
        raise RuntimeError(f"Cloudflare HTTP {response.status_code}, codes="
                           + str([v.get("code") for v in payload.get("errors", [])
                                  if isinstance(v, dict)]))
    return payload.get("result")


# Indexing is confirmed complete by the owner; do not block activation on
# embedding count, stats shape, queued/running counters or index-readiness probes.
# This smoke checks the real seven-index query response only.

for query in (
    "aortic stenosis systolic murmur radiates to carotid arteries",
    "ventricular septal defect holosystolic murmur left lower sternal border",
):
    body = {
        "query": query,
        "ai_search_options": {
            "instance_ids": list(IDS),
            "retrieval": {
                "retrieval_type": "hybrid",
                "match_threshold": 0.4,
                "max_num_results": 50,
                "return_on_failure": True,
                "fusion_method": "rrf",
            },
            "reranking": {"enabled": True, "model": "@cf/baai/bge-reranker-base"},
            "query_rewrite": {"enabled": False},
        },
    }
    raw = result(requests.post(f"{BASE}/search", json=body, headers=HEADERS, timeout=90))
    if not isinstance(raw, dict) or raw.get("errors") or not isinstance(raw.get("chunks"), list):
        raise RuntimeError("Partial/error search response; do not deploy")
    clinical, anking = 0, 0
    for chunk in raw["chunks"]:
        instance = chunk.get("instance_id")
        if instance not in IDS:
            raise RuntimeError("Foreign index supplied in search result")
        if instance in CLINICAL:
            clinical += 1
        elif instance == ANKING:
            anking += 1
    print("ONE_CALL_SEARCH", {"query": query, "medical": clinical, "anking": anking,
                               "total": len(raw["chunks"])}, flush=True)
    if clinical == 0 or anking == 0:
        raise RuntimeError("Medical or AnKing v12 evidence absent from ranked top-50; do not deploy")
print("ANKING_FULL_V12_SEVEN_INDEX_ONE_CALL_STAGING_PASSED", flush=True)
