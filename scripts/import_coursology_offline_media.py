#!/usr/bin/env python3
"""Copy the verified Coursology CDN mapping to the exact owner's R2 offline_media prefix.

Run from GitHub Actions with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
Transfers use temporary GitHub runner storage, never the user's computer.
Existing non-empty R2 objects are never overwritten.
"""
import argparse
import concurrent.futures
import csv
import json
import mimetypes
import os
import pathlib
import random
import re
import sys
import tempfile
import threading
import time
from urllib.parse import quote, urlparse

import requests

EXPECTED_PUBLIC_DOMAIN = "pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev"
SOURCE_HOST = "cdn.coursology-qbank.com"
API_ROOT = "https://api.cloudflare.com/client/v4"
MAX_BYTES = 300 * 1024 * 1024
TRANSIENT = {408, 425, 429, 500, 502, 503, 504}
LOCAL = threading.local()


def session():
    if not hasattr(LOCAL, "session"):
        LOCAL.session = requests.Session()
        LOCAL.session.headers.update({"User-Agent": "Santo-Coursology-R2-Importer/1.0"})
    return LOCAL.session


def cf_request(method, route, *, params=None, file=None, mime=None):
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    url = API_ROOT + "/accounts/" + quote(account, safe="") + route
    headers = {"Authorization": "Bearer " + token}
    if mime:
        headers["Content-Type"] = mime
    for attempt in range(5):
        if file is not None:
            file.seek(0)
        try:
            response = session().request(
                method, url, params=params, headers=headers,
                data=file, timeout=(20, 180 if file is not None else 45),
            )
        except requests.RequestException:
            if attempt == 4:
                raise
            time.sleep(min(2 ** attempt + random.random(), 20))
            continue
        if response.status_code in TRANSIENT and attempt != 4:
            retry_status = response.status_code
            response.close()
            time.sleep(15 + 15 * attempt if retry_status == 429 else min(2 ** attempt + random.random(), 20))
            continue
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError("Cloudflare response is not JSON (HTTP %d)" % response.status_code) from exc
        if response.status_code >= 400 or payload.get("success") is not True:
            codes = [str(e.get("code", "?")) for e in payload.get("errors", [])]
            raise RuntimeError("Cloudflare API HTTP %d (error codes %s)" % (response.status_code, ",".join(codes)))
        return payload
    raise RuntimeError("Cloudflare API request exhausted retries")


def load_manifest(path):
    entries = []
    seen = set()
    with open(path, newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream, delimiter="\t")
        if reader.fieldnames != ["filename", "source_url"]:
            raise ValueError("Manifest columns must be filename and source_url")
        for row in reader:
            name, url = row["filename"], row["source_url"]
            if not re.fullmatch(r"[A-Za-z0-9._-]+", name) or name in seen:
                raise ValueError("Unsafe or repeated filename: " + name)
            parsed = urlparse(url)
            if parsed.scheme != "https" or parsed.netloc != SOURCE_HOST or not parsed.path.startswith("/media/"):
                raise ValueError("Unexpected source URL: " + name)
            if not parsed.path.lower().endswith(pathlib.Path(name).suffix.lower()):
                raise ValueError("Extension mismatch: " + name)
            if pathlib.Path(name).suffix.lower() not in {".jpg", ".png", ".gif", ".mp3", ".mp4"}:
                raise ValueError("Unexpected media type: " + name)
            seen.add(name)
            entries.append((name, url))
    if len(entries) != 4617:
        raise ValueError("Expected exactly 4617 mapped files; got %d" % len(entries))
    return entries


def discover_bucket():
    """Fail closed unless the account's enabled R2 dev domain matches exactly."""
    cursor = None
    buckets = []
    seen = set()
    while True:
        params = {"per_page": 100}
        if cursor:
            params["cursor"] = cursor
        data = cf_request("GET", "/r2/buckets", params=params)
        result = data.get("result") or {}
        buckets.extend(result.get("buckets", []))
        nxt = (data.get("result_info") or {}).get("cursor")
        if not nxt or nxt in seen:
            break
        seen.add(nxt)
        cursor = nxt
    matches = []
    for bucket in buckets:
        name = bucket.get("name")
        if not name:
            continue
        try:
            domain_data = cf_request("GET", "/r2/buckets/" + quote(name, safe="") + "/domains/managed")
        except RuntimeError as exc:
            raise RuntimeError("Cannot inspect R2 managed domain for bucket %s: %s" % (name, exc)) from exc
        info = domain_data.get("result") or {}
        if str(info.get("domain", "")).lower() == EXPECTED_PUBLIC_DOMAIN and info.get("enabled") is True:
            matches.append(name)
    if len(matches) != 1:
        raise RuntimeError(
            "Exact enabled r2.dev bucket lookup returned %d matches, expected 1; "
            "check Cloudflare account credentials and bucket permissions" % len(matches)
        )
    return matches[0]


def list_existing(bucket):
    keys = set()
    cursor = None
    seen = set()
    endpoint = "/r2/buckets/" + quote(bucket, safe="") + "/objects"
    while True:
        params = {"prefix": "offline_media/", "per_page": 1000}
        if cursor:
            params["cursor"] = cursor
        data = cf_request("GET", endpoint, params=params)
        items = data.get("result") or []
        if isinstance(items, dict):
            items = items.get("objects", [])
        for item in items:
            if item.get("key") and int(item.get("size") or 0) > 0:
                keys.add(item["key"])
        info = data.get("result_info") or {}
        if not info.get("is_truncated"):
            break
        cursor = info.get("cursor")
        if not cursor or cursor in seen:
            raise RuntimeError("R2 listing pagination stopped unexpectedly")
        seen.add(cursor)
    return keys


def check_source(entries):
    # Confirm a small image from the mapped source, without fetching entire assets.
    name, url = next((name, url) for name, url in entries if name.lower().endswith(".jpg"))
    with session().get(url, stream=True, headers={"Range": "bytes=0-1023"}, timeout=(20, 35)) as response:
        response.raise_for_status()
        if response.status_code not in (200, 206):
            raise RuntimeError("Source preflight response HTTP %d" % response.status_code)
        if "text/html" in response.headers.get("Content-Type", "").lower():
            raise RuntimeError("Source returned an HTML page instead of media")
        data = next(response.iter_content(chunk_size=1024), b"")
        if not data:
            raise RuntimeError("Source returned empty media")
    print("Source media preflight passed:", name, flush=True)


def transfer(entry, bucket):
    name, url = entry
    key = "offline_media/" + name
    last_error = None
    for attempt in range(4):
        try:
            with session().get(url, stream=True, timeout=(20, 100)) as source:
                source.raise_for_status()
                if source.status_code != 200:
                    raise RuntimeError("Source response was not full HTTP 200")
                ctype = source.headers.get("Content-Type", "").lower()
                if "text/html" in ctype or "application/json" in ctype:
                    raise RuntimeError("Source returned non-media content type " + ctype)
                stated_length = int(source.headers.get("Content-Length", "0"))
                if stated_length > MAX_BYTES:
                    raise RuntimeError("Source exceeds R2 REST 300 MiB limit")
                with tempfile.TemporaryFile(mode="w+b") as temporary:
                    size = 0
                    for chunk in source.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            size += len(chunk)
                            if size > MAX_BYTES:
                                raise RuntimeError("Source exceeds R2 REST 300 MiB limit")
                            temporary.write(chunk)
                    if not size or (stated_length and stated_length != size):
                        raise RuntimeError("Downloaded size is missing or mismatched")
                    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
                    dest = "/r2/buckets/" + quote(bucket, safe="") + "/objects/" + key
                    response = cf_request("PUT", dest, file=temporary, mime=mime)
                    info = response.get("result") or {}
                    if info.get("key") != key or int(info.get("size", -1)) != size:
                        raise RuntimeError("Cloudflare R2 size/key verification failed")
                    return {"filename": name, "status": "uploaded", "bytes": size}
        except Exception as exc:
            last_error = str(exc)
            # Authentication or absent remote video: do not hammer protected source URLs.
            if isinstance(exc, requests.HTTPError) and exc.response is not None and exc.response.status_code in {401, 403, 404, 410}:
                break
            if attempt != 3:
                time.sleep(min(2 ** attempt + random.random(), 15))
    return {"filename": name, "status": "failed", "error": (last_error or "Unknown error")[:300]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default="data/coursology_media_urls.tsv")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--only-images", action="store_true", help="Repair remaining images, without retrying access-restricted videos")
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument("--shards", type=int, default=1)
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--report", default="coursology-result.jsonl")
    args = parser.parse_args()
    if args.shards < 1 or not 0 <= args.shard < args.shards:
        parser.error("shard must be in 0 .. shards-1")
    if not os.environ.get("CLOUDFLARE_API_TOKEN") or not os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        parser.error("Missing preconfigured Cloudflare GitHub Actions secrets")
    entries = load_manifest(args.manifest)
    if args.only_images:
        entries = [(name, url) for name, url in entries if pathlib.Path(name).suffix.lower() in {".jpg", ".png", ".gif"}]
    bucket = discover_bucket()
    print("Verified target R2 bucket:", bucket, flush=True)
    if args.preflight:
        check_source(entries)
        existing = list_existing(bucket)
        print("Preflight OK: %d mapped files, %d existing nonempty offline_media objects" %
              (len(entries), len(existing)), flush=True)
        return 0
    existing = list_existing(bucket)
    shard_items = [entry for index, entry in enumerate(entries) if index % args.shards == args.shard]
    pending = [entry for entry in shard_items if "offline_media/" + entry[0] not in existing]
    counts = {"uploaded": 0, "skipped": len(shard_items) - len(pending), "failed": 0}
    os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as out:
        for name, _ in shard_items:
            if "offline_media/" + name in existing:
                out.write(json.dumps({"filename": name, "status": "skipped"}, ensure_ascii=False) + "\n")
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 10))) as pool:
            futures = {pool.submit(transfer, entry, bucket): entry[0] for entry in pending}
            for future in concurrent.futures.as_completed(futures):
                try:
                    result = future.result()
                except Exception as exc:
                    result = {"filename": futures[future], "status": "failed", "error": str(exc)[:300]}
                counts[result["status"]] += 1
                out.write(json.dumps(result, ensure_ascii=False) + "\n")
                out.flush()
                processed = counts["uploaded"] + counts["failed"]
                if processed % 50 == 0 or processed == len(pending):
                    print("Shard %d/%d: %s" % (args.shard, args.shards, counts), flush=True)
    print("Final shard results:", json.dumps(counts), flush=True)
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as out:
            out.write("### Coursology R2 shard %d/%d\n" % (args.shard + 1, args.shards))
            out.write("Bucket matched by exact managed domain; existing objects left unchanged.\n")
            out.write("Uploaded: %d; skipped: %d; failed: %d.\n" %
                      (counts["uploaded"], counts["skipped"], counts["failed"]))
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
