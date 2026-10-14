#!/usr/bin/env python3
"""Private R2 object uploader. Requires credentials locally; defaults to dry-run.
Never upload the raw SQLite, ZIP, or licensed article bodies to GitHub/public media R2.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import mimetypes
import os
from pathlib import Path

ALLOWED_ROOTS = ("medical-articles/v1/", "medical-search/v1/", "medical-library-catalog/v1/")
STAGING_BUCKET = "santo-content-staging"

def objects(root):
    for path in sorted(root.rglob("*")):
        if not path.is_file():continue
        key=path.relative_to(root).as_posix()
        if key.startswith(ALLOWED_ROOTS) and path.suffix.lower() in (".md",".json"):
            yield key,path

def upload(client,key,path):
    kind="text/markdown; charset=utf-8" if key.endswith(".md") else "application/json; charset=utf-8"
    client.put_object(Bucket=STAGING_BUCKET,Key=key,Body=path.read_bytes(),
                      ContentType=kind,CacheControl="private, no-store")
    return key

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--dir",required=True)
    ap.add_argument("--execute",action="store_true",help="Actually upload to PRIVATE Santo staging R2")
    ap.add_argument("--workers",type=int,default=16)
    ap.add_argument("--checkpoint",default="r2-uploaded-objects.jsonl")
    args=ap.parse_args()
    root=Path(args.dir).resolve()
    files=list(objects(root))
    print(json.dumps({"count":len(files),"sizeMiB":round(sum(p.stat().st_size for _,p in files)/1048576,2),
                      "bucket":STAGING_BUCKET,"execute":args.execute}))
    if not args.execute:return
    if not 1<=args.workers<=32:raise ValueError("workers must be between 1 and 32")
    account=os.environ["R2_ACCOUNT_ID"]
    access=os.environ["R2_ACCESS_KEY_ID"]
    secret=os.environ["R2_SECRET_ACCESS_KEY"]
    import boto3
    from botocore.config import Config
    client=boto3.client("s3",endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=access,aws_secret_access_key=secret,region_name="auto",
        config=Config(retries={"max_attempts":5,"mode":"adaptive"},max_pool_connections=args.workers+4))
    checkpoint=Path(args.checkpoint).resolve()
    if checkpoint.is_relative_to(root):raise ValueError("Checkpoint must be outside export tree")
    done=set(checkpoint.read_text().splitlines()) if checkpoint.exists() else set()
    remaining=[(k,p) for k,p in files if k not in done]
    print(f"Uploading {len(remaining)} objects; already uploaded: {len(done)}")
    failed=[]
    with ThreadPoolExecutor(max_workers=args.workers) as pool,checkpoint.open("a",encoding="utf-8") as journal:
        future={pool.submit(upload,client,key,path):key for key,path in remaining}
        for job in as_completed(future):
            key=future[job]
            try:
                job.result()
                journal.write(key+"\n")
                journal.flush()
            except Exception as exc:
                failed.append(key)
                print("Upload failed for "+key+": "+type(exc).__name__)
    print(json.dumps({"completed":len(remaining)-len(failed),"failed":len(failed)}))
    if failed:raise SystemExit(1)

if __name__=="__main__":main()
