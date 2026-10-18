#!/usr/bin/env python3
"""Read-only live smoke: ONE Cloudflare namespace call across six fixed instances."""
import os
import requests

ids=("amboss","usmle","passmedicine","pastest","one-examination-isolated","santo-medical-images")
url=(f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}"
     "/ai-search/namespaces/default/search")
headers={"Authorization":"Bearer "+os.environ["CLOUDFLARE_API_TOKEN"]}
payload={
    "query":"hyperkalemia ECG tall peaked T waves",
    "ai_search_options":{
        "instance_ids":list(ids),
        "retrieval":{"retrieval_type":"hybrid","match_threshold":0.4,
                     "max_num_results":45,"return_on_failure":True,"fusion_method":"rrf"},
        "reranking":{"enabled":True,"model":"@cf/baai/bge-reranker-base"},
        "query_rewrite":{"enabled":False}
    }
}
response=requests.post(url,json=payload,headers=headers,timeout=75)
data=response.json()
if not response.ok or data.get("success") is False:
    raise RuntimeError("Cloudflare six-instance search HTTP "+str(response.status_code)+" error codes "+
                       str([x.get("code") for x in data.get("errors",[]) if isinstance(x,dict)]))
result=data.get("result") or {}
if result.get("errors"): raise RuntimeError("Cloudflare partial index failure in six-instance search")
chunks=result.get("chunks")
if not isinstance(chunks,list): raise RuntimeError("Malformed merged six-instance response")
present={name:0 for name in ids}
for item in chunks:
    instance=item.get("instance_id")
    if instance in present: present[instance]+=1
    elif instance is not None: raise RuntimeError("Unknown tenant instance in response")
print("Six-index single request: total chunks",len(chunks),"instance_counts",present,flush=True)
if not any(count>0 for key,count in present.items() if key!="santo-medical-images"):
    raise RuntimeError("No clinical library evidence in combined search")
if present["santo-medical-images"]<1:
    raise RuntimeError("No image library chunks in combined search")
print("ONE_REQUEST_6_INDEXES_CONFIRMED; original five untouched",flush=True)
