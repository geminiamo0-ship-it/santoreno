#!/usr/bin/env python3
"""Read-only real-provider check of exact four clinical scopes + shared gallery.
No student tokens, model generation, quota, R2 writes or deployment.
"""
import json
import os
import time
import urllib.request

account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
token = os.environ["CLOUDFLARE_API_TOKEN"]
url = "https://api.cloudflare.com/client/v4/accounts/" + account + "/ai-search/namespaces/default/search"
gallery = "santo-medical-images"
modes = {
    "amboss": ["amboss"],
    "usmle": ["usmle"],
    "mrcp": ["passmedicine", "pastest", "one-examination-isolated"],
    "anking": ["santo-anking-step-v12"],
}
for mode, selected in modes.items():
    instance_ids = selected + [gallery]
    payload = {
        "query": "aortic stenosis diagnosis clinical presentation management",
        "ai_search_options": {
            "instance_ids": instance_ids,
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
    }
    request = urllib.request.Request(url, data=json.dumps(payload).encode(),
        headers={"authorization": "Bearer " + token, "content-type": "application/json"},
        method="POST")
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=35) as response:
        data = json.load(response)
    root = data.get("result", {})
    chunks = root.get("chunks", [])
    if not data.get("success") or not isinstance(chunks, list) or root.get("errors"):
        raise SystemExit("SCOPED_PROVIDER_FAILED " + mode)
    if len(chunks) > 50:
        raise SystemExit("PROVIDER_OVER_LIMIT " + mode)
    illegal = [c.get("instance_id") for c in chunks
               if not isinstance(c, dict) or c.get("instance_id") not in instance_ids]
    if illegal:
        raise SystemExit("FOREIGN_INSTANCE_FOUND " + mode)
    clinical = [c for c in chunks if c.get("instance_id") in selected]
    if not clinical:
        raise SystemExit("NO_SELECTED_CLINICAL_EVIDENCE " + mode)
    print("EXCLUSIVE_MODE_PROVIDER_OK", {
        "mode": mode, "selectedIndexes": len(selected),
        "totalHits": len(chunks), "clinical": len(clinical),
        "galleryHits": len(chunks)-len(clinical),
        "elapsedMs": round((time.monotonic()-started)*1000),
    }, flush=True)
print("ALL_FOUR_EXCLUSIVE_MODE_PROVIDER_SCOPES_PASSED")
