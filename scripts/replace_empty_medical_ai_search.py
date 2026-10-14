#!/usr/bin/env python3
"""Guarded replacement of an empty Santo AI Search index on isolated R2.

Cloudflare error 7122 means source is immutable. Preserve index ID and policy
by replacing only an empty, inactive staging index, with rollback on errors.
"""
import argparse
import json
import os
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

COUNTS={"usmle":13499,"amboss":33724,"passmedicine":8580,"pastest":10704}
CANONICAL_SOURCE="santo-content-staging"

def cloud(path,method="GET",body=None):
    base=f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/ai-search/namespaces/default"
    data=json.dumps(body).encode() if body is not None else (b"" if method=="POST" else None)
    req=Request(base+path,data=data,method=method,headers={
        "Authorization":"Bearer "+os.environ["CLOUDFLARE_API_TOKEN"],
        "Content-Type":"application/json","Accept":"application/json"})
    try:
        with urlopen(req,timeout=65) as res:return res.status,json.load(res)
    except HTTPError as exc:
        try:return exc.code,json.loads(exc.read(4096))
        except (UnicodeError,ValueError):return exc.code,{}

def get(path):
    status,data=cloud(path)
    if status!=200 or data.get("success") is not True:
        raise RuntimeError(f"Cloudflare GET failed HTTP {status}")
    return data.get("result")

def create(payload):
    for n in range(12):
        status,result=cloud("/instances","POST",payload)
        if status in (200,201) and result.get("success") is True:
            return result.get("result")
        errors=result.get("errors",[])
        if status not in (409,429,500,502,503,504):
            print("CREATE_FAILED",status,json.dumps(errors)[:700],flush=True)
            raise RuntimeError(f"Permanent API create error {status}")
        time.sleep(min(12,n+3))
    raise RuntimeError("Creation failed after bounded retries")

def recreate_config(original,source,params):
    body={
        "id":original["id"],"type":"r2","source":source,
        "token_id":original["token_id"],"source_params":params
    }
    allowed=(
        "ai_gateway_id","ai_search_model","embedding_model",
        "chunk_size","chunk_overlap","index_method","indexing_options",
        "fusion_method","rewrite_query","rewrite_model",
        "score_threshold","sync_interval","cache","cache_ttl",
        "cache_threshold","reranking","reranking_model",
        "max_num_results","custom_metadata","keyword_match_mode"
    )
    for name in allowed:
        if original.get(name) is not None:
            body[name]=original[name]
    return body

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--library",required=True,choices=tuple(COUNTS))
    parser.add_argument("--verified-count",type=int,required=True)
    args=parser.parse_args()
    lib=args.library
    if args.verified_count!=COUNTS[lib]:raise RuntimeError("Unverified canonical document count")
    destination=f"santo-{lib}-search-staging"
    path=f"/instances/{lib}"
    original=get(path)
    if original.get("id")!=lib or original.get("type")!="r2" or not original.get("token_id"):
        raise RuntimeError("Unexpected AI Search identity or token")
    if original.get("source")==destination:
        print("ALREADY_ISOLATED",lib,flush=True)
        return
    if original.get("source")!=CANONICAL_SOURCE:
        raise RuntimeError("Unexpected legacy R2 source")
    stats=get(path+"/stats")
    jobs=get(path+"/jobs")
    if not isinstance(jobs,list) or any(not j.get("ended_at") for j in jobs):
        raise RuntimeError("Refusing to replace active AI Search index")
    if any(int(stats.get(name) or 0) for name in ("completed","queued","running","error")):
        raise RuntimeError("Refusing to replace index containing queued or indexed data")

    previous=recreate_config(original,CANONICAL_SOURCE,original.get("source_params") or {})
    replacement=recreate_config(original,destination,{})
    print("ZERO_INDEXED_DATA_VERIFIED",lib,flush=True)
    status,response=cloud(path,"DELETE")
    if status not in (200,202,204) or (response.get("success") is False):
        raise RuntimeError(f"Empty index was not deleted HTTP {status}")
    print("EMPTY_OLD_INDEX_DELETED",lib,flush=True)
    try:
        create(replacement)
    except Exception:
        print("ISOLATED_CREATION_FAILED_RESTORING_OLD_SOURCE",lib,flush=True)
        create(previous)
        raise
    final=get(path)
    if final.get("id")!=lib or final.get("source")!=destination or final.get("token_id")!=original.get("token_id"):
        raise RuntimeError("Recreated AI Search instance does not match original ID/token or new R2 bucket")
    source_params=final.get("source_params") or {}
    if source_params.get("include_items") or source_params.get("exclude_items"):
        raise RuntimeError("Stale filters in newly created physically isolated index")
    print("SAME_LIBRARY_ID_RECREATED",lib,"source",destination,flush=True)
    print("ASYNC_INDEXING_STILL_REQUIRES_QA",flush=True)

if __name__=="__main__":
    main()
