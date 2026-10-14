#!/usr/bin/env python3
"""One-time, scoped source R2 -> isolated R2 AI Search bucket migration.

Must be invoked by GitHub Actions using its generated, masked temporary token.
No user content is printed and no objects are removed or overwritten in original R2.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import random
import re
import subprocess
import time
from urllib.parse import quote

PREFIX = "medical-search/v1/one-examination/"
KEY = re.compile(r"medical-search/v1/one-examination/[a-z0-9-]{1,96}/s-[0-9]{4}\.md$")
EXPECTED = 1017


def request(url, path, token, body=None):
    """Use curl rather than urllib: Cloudflare rejects Python's default HTTP fingerprint."""
    data = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    cmd = ["curl", "--silent", "--show-error", "--max-time", "90",
           "--header", "authorization: Bearer " + token,
           "--header", "content-type: application/json",
           "--output", "-", "--write-out", "\\nHTTP_CODE:%{http_code}"]
    if data is not None:
        cmd += ["--request", "POST", "--data-binary", "@-"]
    cmd.append(url.rstrip("/") + path)
    completed = subprocess.run(cmd, input=data, capture_output=True, timeout=100,
                               check=False)
    if completed.returncode:
        raise OSError(f"Network transport failed (curl {completed.returncode})")
    raw = completed.stdout
    marker = b"\\nHTTP_CODE:"
    if marker not in raw:
        raise OSError("HTTP transport did not include status")
    payload, code = raw.rsplit(marker, 1)
    try:
        return int(code), json.loads(payload)
    except (ValueError, UnicodeError) as exc:
        raise RuntimeError("Bad isolated R2 API status or JSON") from exc


def retry(url, path, token, body=None):
    for attempt in range(7):
        try:
            status, result = request(url, path, token, body)
            if status in (200, 207):
                return status, result
            if status in (400, 401, 403, 404, 409, 413):
                raise RuntimeError(f"Permanent isolated R2 API HTTP {status}: {result.get('error')}")
            if status not in (429, 500, 502, 503, 504):
                raise RuntimeError(f"Unexpected HTTP {status}: {result.get('error')}")
        except (TimeoutError, OSError):
            pass
        if attempt < 6:
            time.sleep(min(15, 1.5 * (2 ** attempt)) + random.random())
    raise RuntimeError(f"Migration API retries exhausted for {path.split('?')[0]}")


def list_keys(url, token, bucket):
    cursor = None
    all_keys = []
    while True:
        args = f"/count?bucket={quote(bucket)}"
        if cursor:
            args += "&cursor=" + quote(cursor, safe="")
        status, value = retry(url, args, token)
        if status != 200:
            raise RuntimeError("Listing returned partial status")
        keys = value.get("keys")
        if not isinstance(keys, list) or any(not isinstance(k, str) or not KEY.fullmatch(k) for k in keys):
            raise RuntimeError("Unexpected non-library object in physical bucket")
        all_keys.extend(keys)
        cursor = value.get("cursor")
        if not cursor:
            break
        if len(all_keys) > 2000:
            raise RuntimeError("Unexpected source scan beyond 2000")
    if len(set(all_keys)) != len(all_keys):
        raise RuntimeError("Duplicate source key")
    return set(all_keys)


def copy_group(args):
    url, token, keys = args
    pending = keys
    copied = []
    for attempt in range(6):
        status, result = retry(url, "/copy", token, {"keys": pending})
        good = result.get("copied") if isinstance(result, dict) else None
        failed = result.get("failed") if isinstance(result, dict) else None
        if not isinstance(good, list) or not isinstance(failed, list):
            raise RuntimeError("Malformed Worker batch result")
        if set(good) & set(failed) or set(good) | set(failed) != set(pending):
            raise RuntimeError("Worker returned keys outside copy request")
        copied.extend(good)
        pending = failed
        if not pending:
            return copied
        time.sleep(min(12, 2 ** attempt))
    raise RuntimeError(f"Failed copying {len(pending)} keys after retries")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--execute", action="store_true")
    args = p.parse_args()
    token = os.environ.get("SANTO_ISOLATION_TOKEN", "")
    if not args.url.startswith("https://") or not re.fullmatch("[a-f0-9]{64}", token):
        raise ValueError("Missing temporary secure Worker connection")
    source = list_keys(args.url, token, "source")
    existing = list_keys(args.url, token, "destination")
    if len(source) != EXPECTED:
        raise RuntimeError(f"Canonical One Examination source expected {EXPECTED}, found {len(source)}")
    if existing - source:
        raise RuntimeError("Destination contains unapproved files; refusing copy")
    print(f"Source {len(source)} isolated section keys; destination already {len(existing)}", flush=True)
    if not args.execute:
        print("DRY_RUN_NO_WRITES")
        return
    missing = sorted(source - existing)
    batches = [missing[i:i+10] for i in range(0, len(missing), 10)]
    done = len(existing)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(copy_group, (args.url, token, chunk)) for chunk in batches]
        for f in as_completed(futures):
            done += len(f.result())
            if done % 100 < 10:
                print(f"Copied {done}/{EXPECTED} private search objects", flush=True)
    destination = list_keys(args.url, token, "destination")
    if destination != source:
        raise RuntimeError(f"Destination scope mismatch: expected {len(source)}, got {len(destination)}")
    samples = [sorted(source)[i] for i in (0, EXPECTED // 2, EXPECTED - 1)]
    for key in samples:
        status, r = retry(args.url, "/verify?key=" + quote(key, safe=""), token)
        if status != 200 or r.get("identical") is not True or not r.get("sha256"):
            raise RuntimeError("Source/destination SHA-256 verification failed")
    print(f"PASS: isolated bucket contains exactly {EXPECTED} expected medical search sections")
    print("PASS: 3 representative file SHA-256 comparisons")
    print("ORIGINAL_R2_UNTOUCHED=TRUE", flush=True)


if __name__ == "__main__":
    main()
