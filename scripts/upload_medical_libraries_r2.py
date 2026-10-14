#!/usr/bin/env python3
"""GitHub Actions/operator-safe uploader for validated PRIVATE Santo Staging R2 data.

Never accepts an arbitrary bucket. Archives and book text never enter Git source.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path

ALLOWED_ROOTS = ("medical-articles/v1/", "medical-search/v1/",
                 "medical-library-catalog/v1/")
COUNTS = {"medical-articles": 7049, "medical-search": 67524,
          "medical-library-catalog": 6}
STAGING_BUCKET = "santo-content-staging"
LIBRARIES = {"amboss", "usmle", "passmedicine", "pastest", "one-examination"}


def objects(root):
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        key = path.relative_to(root).as_posix()
        if key.startswith(ALLOWED_ROOTS) and path.suffix.lower() in (".md", ".json"):
            yield key, path


def metadata_for(key):
    parts = key.split("/")
    if len(parts) >= 5 and parts[0] == "medical-search":
        library, article, section = parts[2], parts[3], parts[4].removesuffix(".md")
        if library not in LIBRARIES:
            raise ValueError("Unexpected library ID in search key")
        return {"library_id": library, "article_id": article, "section_id": section}
    return {}


def upload(client, key, path):
    kind = ("text/markdown; charset=utf-8"
            if key.endswith(".md") else "application/json; charset=utf-8")
    client.put_object(
        Bucket=STAGING_BUCKET, Key=key, Body=path.read_bytes(), ContentType=kind,
        CacheControl="private, no-store", Metadata=metadata_for(key),
    )


def count_remote(client):
    counts = Counter()
    for root in ALLOWED_ROOTS:
        token = None
        while True:
            args = {"Bucket": STAGING_BUCKET, "Prefix": root, "MaxKeys": 1000}
            if token:
                args["ContinuationToken"] = token
            result = client.list_objects_v2(**args)
            counts[root.split("/")[0]] += len(result.get("Contents", []))
            if not result.get("IsTruncated"):
                break
            token = result.get("NextContinuationToken")
            if not token:
                raise ValueError("Remote R2 object listing pagination failed")
    return dict(counts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--workers", type=int, default=20)
    parser.add_argument("--checkpoint", default="r2-uploaded-objects.jsonl")
    args = parser.parse_args()
    if not 1 <= args.workers <= 32:
        raise ValueError("Workers must be between 1 and 32")
    root = Path(args.dir).resolve()
    if not root.is_dir():
        raise ValueError("Export directory does not exist")
    files = list(objects(root))
    local_counts = Counter(k.split("/")[0] for k, _ in files)
    if dict(local_counts) != COUNTS:
        raise ValueError(f"Incorrect local object counts: {dict(local_counts)}")
    print(json.dumps({"counts": dict(local_counts),
                      "sizeMiB": round(sum(p.stat().st_size for _, p in files) / 1048576, 2),
                      "privateBucket": STAGING_BUCKET, "execute": args.execute,
                      "verifyOnly": args.verify_only}))
    if not (args.execute or args.verify_only):
        return

    import boto3
    from botocore.config import Config

    client = boto3.client(
        "s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto",
        config=Config(retries={"max_attempts": 6, "mode": "adaptive"},
                      max_pool_connections=args.workers + 4),
    )
    if args.execute:
        checkpoint = Path(args.checkpoint).resolve()
        if checkpoint.is_relative_to(root):
            raise ValueError("Checkpoint must stay outside the licensed export tree")
        done = set(checkpoint.read_text().splitlines()) if checkpoint.exists() else set()
        remaining = [(k, p) for k, p in files if k not in done]
        print(f"Upload batch size: {len(remaining)}; local checkpoint entries: {len(done)}")
        failures = []
        with ThreadPoolExecutor(max_workers=args.workers) as pool, checkpoint.open("a") as log:
            futures = {pool.submit(upload, client, key, path): key for key, path in remaining}
            for i, job in enumerate(as_completed(futures), 1):
                key = futures[job]
                try:
                    job.result()
                    log.write(key + "\n")
                    if i % 100 == 0:
                        log.flush()
                        print(f"Uploaded {i}/{len(remaining)} objects")
                except Exception as exc:
                    failures.append(key)
                    print(f"Failed object {key}: {type(exc).__name__}")
            log.flush()
        if failures:
            raise ValueError(f"R2 upload failed for {len(failures)} objects; do not index")

    remote = count_remote(client)
    if remote != COUNTS:
        raise ValueError(f"Remote private R2 listing mismatch: {remote}; expected {COUNTS}")
    # Validate materialized objects and search metadata (list alone is insufficient).
    samples = [files[0], files[len(files) // 2], files[-1]]
    samples += [next((k, p) for k, p in files if k.startswith(
        f"medical-search/v1/{lib}/")) for lib in sorted(LIBRARIES)]
    for key, path in samples:
        response = client.head_object(Bucket=STAGING_BUCKET, Key=key)
        if response["ContentLength"] != path.stat().st_size:
            raise ValueError("Private R2 file size mismatch")
        for name, value in metadata_for(key).items():
            if response.get("Metadata", {}).get(name) != value:
                raise ValueError("Private R2 search metadata mismatch")
    print(json.dumps({"remoteObjectCount": sum(remote.values()),
                      "remoteCounts": remote, "sampleHeadVerification": "passed"}))


if __name__ == "__main__":
    main()
