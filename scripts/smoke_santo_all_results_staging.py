#!/usr/bin/env python3
"""Read-only 50-result, seven-instance Cloudflare fast-path smoke before Staging deploy."""
import os
import time

import requests

CLINICAL = ("amboss", "usmle", "passmedicine", "pastest", "one-examination-isolated")
GALLERY = "santo-medical-images"
ANKING = "santo-anking-step-v12"
IDS = (*CLINICAL, GALLERY, ANKING)
URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}"
    "/ai-search/namespaces/default/search"
)
HEADERS = {"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]}

for query in (
    "aortic stenosis systolic murmur radiates to carotid arteries",
    "ventricular septal defect holosystolic murmur left lower sternal border",
):
    started = time.monotonic()
    response = requests.post(
        URL,
        json={
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
                "reranking": {"enabled": False},
                "query_rewrite": {"enabled": False},
            },
        },
        headers=HEADERS,
        timeout=30,
    )
    elapsed = time.monotonic() - started
    payload = response.json()
    if not response.ok or payload.get("success") is False:
        raise RuntimeError(
            f"Search HTTP {response.status_code}: "
            + str([e.get("code") for e in payload.get("errors", []) if isinstance(e, dict)])
        )
    result = payload.get("result")
    if not isinstance(result, dict) or result.get("errors"):
        raise RuntimeError("Partial search failure; do not deploy")
    chunks = result.get("chunks")
    if not isinstance(chunks, list) or len(chunks) > 50:
        raise RuntimeError("Invalid or over-limit merged search result")
    counts = {"medical": 0, "anking": 0, "gallery": 0}
    for chunk in chunks:
        instance = chunk.get("instance_id")
        if instance not in IDS:
            raise RuntimeError("Foreign search instance detected")
        if instance in CLINICAL:
            counts["medical"] += 1
        elif instance == ANKING:
            counts["anking"] += 1
        else:
            counts["gallery"] += 1
    print("ALL_RESULTS_SEARCH_SMOKE", {"elapsed_ms": int(elapsed * 1000),
                                      "total_hits": len(chunks), **counts}, flush=True)
    if counts["medical"] < 1 or counts["anking"] < 1:
        raise RuntimeError("Medical and AnKing evidence not both returned")
    if elapsed >= 12:
        raise RuntimeError("50-result RRF search exceeded 12s staging speed gate")

print("SANTO_ALL_RESULTS_ONE_CALL_STAGING_SMOKE_PASSED", flush=True)
