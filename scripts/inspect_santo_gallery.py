#!/usr/bin/env python3
"""Read-only gallery index diagnostics; never prints secrets or medical content."""
import json, os, requests
from urllib.parse import quote
account=os.environ["CLOUDFLARE_ACCOUNT_ID"]
token=os.environ["CLOUDFLARE_API_TOKEN"]
base=f"https://api.cloudflare.com/client/v4/accounts/{account}/ai-search/namespaces/default"
headers={"Authorization":f"Bearer {token}"}
def call(path, method="GET", body=None):
    response=requests.request(method,base+path,headers=headers,json=body,timeout=35)
    try: payload=response.json()
    except ValueError: payload={}
    if not response.ok or payload.get("success") is False:
        print("HTTP error",response.status_code,[i.get("code") for i in payload.get("errors",[]) if isinstance(i,dict)])
        return None,None
    return payload.get("result"), payload.get("result_info")
stats,_=call("/instances/santo-medical-images/stats")
print("Index stats",json.dumps(stats,sort_keys=True)[:3000])
for state in ("error","skipped","completed"):
    result,info=call(f"/instances/santo-medical-images/items?status={state}&page=1&per_page=50")
    items=result if isinstance(result,list) else (result or {}).get("items",[])
    print("status",state,"items_on_first_page",len(items),"pagination",info)
    if state!="completed":
        for item in items[:10]:
            item_id=item.get("id");print("Index item error",json.dumps({k:item.get(k) for k in ("id","key","status","error","source_id")},ensure_ascii=False))
            if item_id:
                logs,_=call(f"/instances/santo-medical-images/items/{quote(str(item_id),safe='')}/logs")
                print("Index failure log:",json.dumps(logs,ensure_ascii=False)[:1800])
for q in ("Tetrahydrobiopterin BH4 phenylketonuria","hyperkalemia ECG peaked T waves"):
    result,_=call("/search",method="POST",body={
      "messages":[{"role":"user","content":q}],
      "ai_search_options":{"instance_ids":["santo-medical-images"],"query_rewrite":{"enabled":False},"retrieval":{"max_num_results":5}}
    })
    if result:
        print("Search test",q,"found",[{"key":x.get("item",{}).get("key"),"score":x.get("score"),"instance_id":x.get("instance_id")} for x in result.get("chunks",[])[:5]])
