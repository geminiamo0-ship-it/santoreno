#!/usr/bin/env python3
"""Read-only gate: publish Santo gallery only when 3293 good + 2 known AI timeouts."""
import os
import requests

INSTANCE="santo-medical-images"
EXPECTED_ERROR_KEYS={"img_000412.json","img_000416.json"}
BASE=(f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}"
      "/ai-search/namespaces/default")
HEADERS={"Authorization":"Bearer "+os.environ["CLOUDFLARE_API_TOKEN"]}

def call(method,path,body=None):
    response=requests.request(method,BASE+path,headers=HEADERS,json=body,timeout=45)
    payload=response.json()
    if not response.ok or payload.get("success") is False:
        raise RuntimeError("Gallery Cloudflare API status "+str(response.status_code))
    return payload.get("result")

stats=call("GET",f"/instances/{INSTANCE}/stats")
assert isinstance(stats,dict),"Missing index stats"
states={s:stats.get(s,0) for s in ("completed","queued","running","error","skipped")}
print("Isolated image index stats:",states,flush=True)
if (stats.get("completed",0)<3293 or stats.get("completed",0)+stats.get("error",0)!=3295 or
        stats.get("error",0)>2 or any(stats.get(x,0)!=0 for x in ("queued","running","skipped"))):
    raise RuntimeError("Gallery is not at approved 3293+2 terminal state")
issues=call("GET",f"/instances/{INSTANCE}/items?status=error&page=1&per_page=50")
if not isinstance(issues,list):
    raise RuntimeError("Cannot verify ignored image identities")
failed={item.get("key") for item in issues}
if not failed.issubset(EXPECTED_ERROR_KEYS) or len(issues)!=stats.get("error",0) or any(item.get("error")!="workers_ai_timeout_error" for item in issues):
    raise RuntimeError("Unexpected indexing failures, refusing manifest publication")
print("Ignoring at most two known transient embedding failures", sorted(failed),flush=True)
for query in ("Tetrahydrobiopterin BH4 phenylketonuria","hyperkalemia ECG peaked T waves","Cushing syndrome"):
    found=call("POST","/search",{
        "messages":[{"role":"user","content":query}],
        "ai_search_options":{"instance_ids":[INSTANCE],"query_rewrite":{"enabled":False},"retrieval":{"max_num_results":8}}
    })
    chunks=(found or {}).get("chunks",[])
    matches=[row for row in chunks if row.get("instance_id")==INSTANCE
             and str(row.get("item",{}).get("key","")).startswith("img_")
             and isinstance(row.get("score"),(int,float))]
    if not matches:
        raise RuntimeError("No real image results for gallery search test")
    print("Gallery query passed:",query, "results",len(matches),flush=True)
print("GALLERY_GATE_PASSED: 3293+ indexed and only known transient failures, existing five indexes untouched",flush=True)
