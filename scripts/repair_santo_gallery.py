#!/usr/bin/env python3
"""Repair ONLY transient gallery item embedding timeouts; verify sixth instance."""
import argparse
import json
import os
import time
from urllib.parse import quote
import requests

INSTANCE="santo-medical-images"
EXPECTED=3295
MAX_RETRY=2
BASE=f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/ai-search/namespaces/default"
HEADERS={"Authorization":"Bearer "+os.environ["CLOUDFLARE_API_TOKEN"]}

def api(method,path,body=None):
    r=requests.request(method,BASE+path,headers=HEADERS,json=body,timeout=50)
    try: p=r.json()
    except ValueError: p={}
    if not r.ok or p.get("success") is False:
        raise RuntimeError("Cloudflare API "+str(r.status_code)+" error codes "+str([e.get("code") for e in p.get("errors",[]) if isinstance(e,dict)]))
    return p.get("result")

def list_errors():
    items=api("GET",f"/instances/{INSTANCE}/items?status=error&page=1&per_page=50")
    if not isinstance(items,list): raise RuntimeError("Unable to list gallery errors")
    return items

def stats():
    s=api("GET",f"/instances/{INSTANCE}/stats")
    if not isinstance(s,dict): raise RuntimeError("Gallery stats unavailable")
    return s

def retry(items):
    if len(items)>2: raise RuntimeError("More than 2 failed items; stop for manual review")
    allowed={"img_000412.json","img_000416.json"}
    for item in items:
        if item.get("key") not in allowed or item.get("error")!="workers_ai_timeout_error":
            raise RuntimeError("Non-transient or unexpected gallery error; refusing automatic reindex")
        item_id=item.get("id")
        if not isinstance(item_id,str) or len(item_id)<20: raise RuntimeError("Missing failed item ID")
        r=api("PATCH",f"/instances/{INSTANCE}/items/{quote(item_id,safe='')}",{"next_action":"INDEX"})
        print("Retried transient timeout for",item["key"],"status",r.get("status") if isinstance(r,dict) else "unknown",flush=True)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--execute",action="store_true")
    args=p.parse_args()
    before=stats()
    print("Before", {k:before.get(k) for k in ("completed","error","queued","running","skipped")},flush=True)
    if before.get("completed",0)>=EXPECTED and before.get("error",0)==0 and before.get("queued",0)==0 and before.get("running",0)==0:
        print("Already fully indexed; no repair writes")
    else:
        issues=list_errors()
        if not args.execute: raise RuntimeError("Execute flag required to reindex specific errored items")
        retry(issues)
        reattempted=1 if issues else 0
        deadline=time.monotonic()+1200
        while time.monotonic()<deadline:
            time.sleep(25)
            now=stats()
            counts={k:now.get(k) for k in ("completed","error","queued","running","skipped")}
            print("Gallery status",counts,flush=True)
            if now.get("completed",0)>=EXPECTED and not any(now.get(k,0) for k in ("error","queued","running","skipped")):
                break
            if now.get("error",0):
                if reattempted>=MAX_RETRY: raise RuntimeError("Gallery image timeout persisted after scoped reindex")
                retry(list_errors())
                reattempted+=1
        else:
            raise RuntimeError("Image index did not finish on bounded retry")
    final=stats()
    assert final.get("completed")==EXPECTED and all(final.get(x,0)==0 for x in ("queued","running","error","skipped")),final
    for query in ("Tetrahydrobiopterin BH4 phenylketonuria","hyperkalemia ECG peaked T waves"):
        result=api("POST","/search",{
            "messages":[{"role":"user","content":query}],
            "ai_search_options":{"instance_ids":[INSTANCE],"query_rewrite":{"enabled":False},"retrieval":{"max_num_results":8}}
        })
        chunks=(result or {}).get("chunks",[])
        assert any(c.get("instance_id")==INSTANCE and c.get("item",{}).get("key","").startswith("img_") for c in chunks),query
        print("Gallery search confirmed",query,"results",len(chunks))
    print("ALL 3295 MEDICAL GALLERY IMAGES INDEXED; evidence ready for staging manifest",flush=True)

if __name__=="__main__":
    main()
