#!/usr/bin/env python3
"""Switch an empty Santo library search instance to its verified own R2 bucket.
No instance creation or deletion. Preserves existing stable Santo library IDs.
"""
import argparse
import json
import os
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

LIBS = {"amboss":33724,"usmle":13499,"passmedicine":8580,"pastest":10704}
OLD = "santo-content-staging"


def cloud(path, method="GET", data=None):
    base = "https://api.cloudflare.com/client/v4/accounts/" + os.environ["CLOUDFLARE_ACCOUNT_ID"] + "/ai-search/namespaces/default"
    payload = json.dumps(data).encode() if data is not None else (b"" if method == "POST" else None)
    req = Request(base + path, method=method, data=payload, headers={
        "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"],
        "Content-Type": "application/json", "Accept": "application/json"
    })
    try:
        with urlopen(req, timeout=80) as resp:
            obj = json.load(resp)
    except HTTPError as exc:
        if method=="POST" and exc.code==429:
            return {"rate_limited":True}
        raise RuntimeError(f"Cloudflare AI Search {method} HTTP {exc.code}") from exc
    if not isinstance(obj,dict) or obj.get("success") is not True:
        raise RuntimeError("Cloudflare AI Search returned failed response")
    return obj.get("result")


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--library",required=True,choices=tuple(LIBS))
    p.add_argument("--verify-copied",action="store_true",required=True,
                   help="Only invoke after exact R2 count and SHA-256 copy validation")
    args=p.parse_args()
    lib=args.library
    target=f"santo-{lib}-search-staging"
    prefix=f"medical-search/v1/{lib}/"
    path=f"/instances/{lib}"
    before=cloud(path)
    if not isinstance(before,dict) or before.get("type")!="r2" or not before.get("token_id"):
        raise RuntimeError("Source instance missing or wrong type/token")
    if before.get("source") not in (OLD,target):
        raise RuntimeError("Refusing unexpected source bucket")
    if before.get("source")==OLD:
        stat=cloud(path+"/stats")
        if not isinstance(stat,dict):
            raise RuntimeError("Unverifiable existing indexing state")
        if any(int(stat.get(k) or 0) != 0 for k in ("completed","running","queued","error")):
            raise RuntimeError("Refusing to repoint nonempty or actively indexing old instance")
        jobs=cloud(path+"/jobs")
        if not isinstance(jobs,list) or any(not j.get("ended_at") for j in jobs):
            raise RuntimeError("Refusing source change with active index job")
        print("SAFE_EMPTY_SOURCE",lib,flush=True)
        cloud(path,method="PUT",data={
            "source":target,
            "source_params":{"prefix":prefix,"include_items":[],"exclude_items":[]}
        })
    current=cloud(path)
    if not isinstance(current,dict) or current.get("id")!=lib or current.get("type")!="r2" or current.get("source")!=target or current.get("token_id")!=before.get("token_id"):
        raise RuntimeError("Retargeted instance ID/bucket/service token mismatch")
    params=current.get("source_params") or {}
    if params.get("prefix")!=prefix or params.get("include_items") or params.get("exclude_items"):
        raise RuntimeError("Retargeted index has unsafe or stale include/exclude filters")
    print("SAFE_STABLE_ID",lib,"source",target,"filter_only_prefix",prefix,flush=True)

    jobs=cloud(path+"/jobs")
    if not isinstance(jobs,list):
        raise RuntimeError("Unverifiable current job state")
    if not any(not j.get("ended_at") for j in jobs):
        try:
            result=cloud(path+"/jobs",method="POST")
            if isinstance(result,dict) and result.get("rate_limited"):
                print("INDEX_SYNC_RATE_LIMITED; automatic sync may already be scheduled",flush=True)
            elif not isinstance(result,dict) or not result.get("id"):
                raise RuntimeError("No index sync ID")
            else:
                print("INDEX_SYNC_STARTED",lib,result["id"],flush=True)
        except RuntimeError:
            raise
    else:
        print("AUTO_SYNC_ACTIVE",lib,flush=True)

    for i in range(10):
        stat=cloud(path+"/stats")
        if not isinstance(stat,dict):raise RuntimeError("Invalid stats")
        counts={k:stat.get(k) for k in ("queued","running","completed","error","skipped")}
        print("SYNC_COUNTS",lib,json.dumps(counts,sort_keys=True),flush=True)
        if int(counts.get("error") or 0)>0 or int(counts.get("skipped") or 0)>0:
            raise RuntimeError("Unexpected errors/skips in physically isolated library")
        if int(counts.get("completed") or 0)>0:
            items=cloud(path+"/items?per_page=20&page=1")
            if not isinstance(items,list):raise RuntimeError("No index keys to validate")
            if any(not isinstance(t.get("key"),str) or not t["key"].startswith(prefix) for t in items):
                raise RuntimeError("Cross-library indexed key detected")
            print("INDEXED_CORRECT_LIBRARY",lib,"count",counts["completed"],flush=True)
            return
        time.sleep(20)
    print("INDEX_SYNC_ASYNC_RUNNING",lib,"still awaiting completed>0",flush=True)


if __name__=="__main__":
    main()
