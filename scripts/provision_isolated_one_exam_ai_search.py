#!/usr/bin/env python3
"""Safely create a new isolated Santo One Examination test index.

Never touches, deletes or repoints any existing clinical knowledge index.
"""
import json
import os
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SOURCE = "santo-content-staging"
BUCKET = "santo-one-examination-search-staging"
BASE_ID = "one-examination"
PILOT = "one-examination-isolated"


def api(path, method="GET", body=None):
    root = ("https://api.cloudflare.com/client/v4/accounts/"
            + os.environ["CLOUDFLARE_ACCOUNT_ID"]
            + "/ai-search/namespaces/default")
    data = json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None)
    req = Request(root+path, data=data, method=method,
                  headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"],
                           "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urlopen(req, timeout=55) as res:
            payload = json.load(res)
            status = res.status
    except HTTPError as exc:
        if exc.code == 404:
            return 404, None
        print("Cloudflare HTTP", exc.code, "during", method, path.split("/")[-1], flush=True)
        raise
    if payload.get("success") is not True:
        raise RuntimeError("Cloudflare AI Search success=false")
    return status, payload.get("result")


def main():
    _, base = api("/instances/" + BASE_ID)
    if not isinstance(base, dict) or base.get("source") != SOURCE or base.get("type") != "r2":
        raise RuntimeError("Source AI Search instance changed unexpectedly")
    token = base.get("token_id")
    if not token:
        raise RuntimeError("Existing AI Search source token missing")

    _, instances = api("/instances")
    if not isinstance(instances, list):
        raise RuntimeError("Untrusted AI Search inventory response")
    existing = {x.get("id") for x in instances}
    status, obj = api("/instances/" + PILOT)
    if status == 404:
        if len(instances) >= 10:
            raise RuntimeError("No extra AI Search instance slot: preserving all existing indexes")
        status, obj = api("/instances", "POST",
                          {"id": PILOT, "type": "r2", "source": BUCKET, "token_id": token,
                           "source_params": {}, "sync_interval": 21600})
        print("CREATED_ISOLATED_INDEX", PILOT, flush=True)
    if (not isinstance(obj, dict) or obj.get("id") != PILOT or
        obj.get("source") != BUCKET or obj.get("type") != "r2" or
        obj.get("token_id") != token):
        raise RuntimeError("Pilot index security/source isolation mismatch")
    if (obj.get("source_params") or {}).get("include_items") or (obj.get("source_params") or {}).get("exclude_items"):
        raise RuntimeError("Unexpected redundant glob filters on clean pilot bucket")
    print("PILOT_BUCKET_EXACT_MATCH", BUCKET)
    print("PRODUCTION_INDEXES_UNMODIFIED", len(instances))

    _, jobs = api("/instances/" + PILOT + "/jobs")
    if not isinstance(jobs, list):
        raise RuntimeError("Unknown AI Search jobs API response")
    if not any(not j.get("ended_at") for j in jobs):
        try:
            _, job = api("/instances/" + PILOT + "/jobs", "POST")
            print("PILOT_SYNC_STARTED", job.get("id"), flush=True)
        except HTTPError as error:
            if error.code != 429:
                raise
            print("Cloudflare sync rate-limited; initial automatic or scheduled indexing may still run", flush=True)
    else:
        print("SYNC_ALREADY_ACTIVE", flush=True)

    for check in range(25):
        _, stat = api("/instances/" + PILOT + "/stats")
        if not isinstance(stat, dict):
            raise RuntimeError("Invalid stats API response")
        counts = {name: stat.get(name) for name in ("completed","queued","running","error","skipped")}
        print("PILOT_STATS", json.dumps(counts,sort_keys=True), flush=True)
        if (counts["error"] or 0)>0 or (counts["skipped"] or 0)>0:
            raise RuntimeError("Unexpected skipped/errors in physically isolated clean bucket")
        if (counts["completed"] or 0)>0:
            _, items = api("/instances/" + PILOT + "/items?per_page=20&page=1")
            if not isinstance(items, list):
                raise RuntimeError("Cannot verify indexed keys")
            unexpected = [x.get("key") for x in items
                          if not isinstance(x.get("key"),str) or not x["key"].startswith(
                              "medical-search/v1/one-examination/")]
            if unexpected:
                raise RuntimeError("Cross-library indexed item detected in isolated bucket")
            print("PILOT_INDEX_PROGRESS_CONFIRMED", counts["completed"], flush=True)
            return
        time.sleep(30)

    print("PILOT_STILL_INDEXING_ASYNCHRONOUSLY_NO_INDEXED_YET", flush=True)
    # Do not fail and trigger an unnecessary expensive rerun.
    print("NO_CLAIM_OF_SEARCH_READY")


if __name__ == "__main__":
    main()
