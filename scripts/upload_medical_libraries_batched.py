#!/usr/bin/env python3
"""Resumable Santo medical-corpus upload via one ephemeral, authenticated R2 Worker.

Uses existing Santo CLOUDFLARE_API_TOKEN only to deploy that Worker; the short
lived ingestion token is generated inside this GitHub Actions run. No R2 S3 keys.
"""
import argparse
import base64
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import random
import subprocess
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

EXPECTED = {"medical-articles": 7049, "medical-search": 67524,
            "medical-library-catalog": 6}
SCOPES = ("all", "amboss", "usmle", "passmedicine", "pastest",
          "one-examination", "catalog")
ALLOWED_ROOTS = ("medical-articles/v1/", "medical-search/v1/",
                 "medical-library-catalog/v1/")


def select_files(root, scope):
    items = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        key = path.relative_to(root).as_posix()
        if not (key.startswith(ALLOWED_ROOTS) and path.suffix in {".md", ".json"}):
            continue
        if scope == "catalog" and not key.startswith("medical-library-catalog/v1/"):
            continue
        if scope not in {"all", "catalog"} and not (
            key.startswith(f"medical-search/v1/{scope}/") or
            key.startswith(f"medical-articles/v1/{scope}/")
        ):
            continue
        items.append((key, path))
    return sorted(items)


def groups(files):
    """Bound per-worker request size and R2 put fanout."""
    group = []
    size = 0
    for key, path in files:
        next_size = (path.stat().st_size * 4 // 3) + len(key) + 180
        if group and (len(group) >= 16 or size + next_size > 2_500_000):
            yield group
            group = []
            size = 0
        group.append((key, path))
        size += next_size
    if group:
        yield group


def submit(worker_url, token, endpoint, payload=None):
    """Use curl (not Python urllib) for Cloudflare's edge: urllib POSTs returned 403.

    Keep full HTTP status, hide auth in all logs, and never display article bytes.
    """
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else None
    command = ["curl", "--silent", "--show-error", "--max-time", "90",
               "--write-out", "\n%{http_code}",
               "-H", "Authorization: Bearer " + token,
               "-H", "Content-Type: application/json"]
    if data is not None:
        command += ["-X", "POST", "--data-binary", "@-"]
    command.append(worker_url.rstrip("/") + endpoint)
    proc = subprocess.run(command, input=data, capture_output=True, timeout=105, check=False)
    if proc.returncode != 0:
        raise OSError(f"curl transport failure (exit={proc.returncode})")
    try:
        body, code = proc.stdout.rsplit(b"\n", 1)
        status = int(code)
    except (ValueError, IndexError):
        raise OSError("curl returned no HTTP status")
    try:
        result = json.loads(body)
    except (ValueError, UnicodeError):
        result = {"error": "NON_JSON_EDGE_RESPONSE"}
    return status, result


def transfer_group(worker_url, token, files):
    remaining = files
    successful = []
    for attempt in range(8):
        payload = {"files": [
            {"key": key, "body": base64.b64encode(path.read_bytes()).decode("ascii")}
            for key, path in remaining
        ]}
        try:
            status, response = submit(worker_url, token, "/batch", payload)
            if status in (200, 207):
                accepted = response.get("uploaded")
                failed = response.get("failed")
                if not isinstance(accepted, list) or not isinstance(failed, list):
                    raise RuntimeError("INVALID_WORKER_REPLY")
                owned = {key for key, _ in remaining}
                if set(accepted) | set(failed) != owned or set(accepted) & set(failed):
                    raise RuntimeError("WORKER_REPLY_MISMATCH")
                successful += accepted
                remaining = [(key, path) for key, path in remaining if key in failed]
                if not remaining:
                    return successful
            elif status in (400, 401, 403, 404, 413):
                raise RuntimeError(f"Permanent Worker HTTP {status}: {response.get('error','UNSPECIFIED')}")
            elif status not in (429, 500, 502, 503, 504):
                raise RuntimeError(f"Unexpected Worker HTTP {status}: {response.get('error','UNSPECIFIED')}")
        except (URLError, TimeoutError, OSError):
            pass  # Uncertain partial write; safe to repeat immutable R2 keys
        if attempt < 7:
            time.sleep(min(18, 0.75 * 2 ** attempt) + random.random() * .5)
    raise RuntimeError(f"R2_BATCH_RETRY_EXHAUSTED ({len(remaining)} unsaved objects)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--scope", choices=SCOPES, default="all")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--probe", action="store_true", help="Write and verify only the existing safe catalog manifest")
    args = ap.parse_args()
    token = os.environ.get("SANTO_IMPORT_TOKEN", "")
    if args.execute and (len(token) != 64 or not args.url.startswith("https://")):
        raise ValueError("Missing authenticated temporary Worker or token")
    if not 1 <= args.workers <= 12:
        raise ValueError("Bad concurrency")
    root = Path(args.dir).resolve()
    files = select_files(root, args.scope)
    full = select_files(root, "all")
    actual = dict(Counter(key.split("/")[0] for key, _ in full))
    if actual != EXPECTED:
        raise RuntimeError(f"Wrong corpus counts: {actual}")
    print(f"Validated {len(full)} corpus objects; scope {args.scope} contains {len(files)} objects.")
    if not args.execute:
        print("Dry-run: no R2 writes.")
        return

    if args.probe:
        pair = next((key, path) for key, path in full
                    if key == "medical-library-catalog/v1/catalog.json")
        sent = transfer_group(args.url, token, [pair])
        if sent != [pair[0]]:
            raise RuntimeError("Batch POST probe mismatch")
        status, evidence = submit(args.url, token, "/verify?key=" + quote(pair[0], safe=""))
        if status != 200 or evidence.get("sha256") != hashlib.sha256(pair[1].read_bytes()).hexdigest():
            raise RuntimeError(f"Authenticated R2 POST probe readback mismatch HTTP={status}")
        print("SUCCESS: curl POST persisted existing R2 catalog manifest and exact SHA-256 GET matched.", flush=True)
        return
    checkpoint = Path(args.checkpoint).resolve()
    if checkpoint.is_relative_to(root):
        raise ValueError("Checkpoint cannot be inside licensed export")
    old = set(checkpoint.read_text().splitlines()) if checkpoint.exists() else set()
    allkeys = {key for key, _ in files}
    if not old.issubset(allkeys):
        raise ValueError("Invalid resume checkpoint")
    pending = [(key, path) for key, path in files if key not in old]
    batches = list(groups(pending))
    print(f"Uploading {len(pending)} objects as {len(batches)} bounded authenticated batches.")
    lock = threading.Lock()
    written = len(old)
    errors = []
    with checkpoint.open("a", encoding="utf-8") as journal:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            future_map = {pool.submit(transfer_group, args.url, token, group): group
                          for group in batches}
            for fut in as_completed(future_map):
                try:
                    keys = fut.result()
                    with lock:
                        for key in keys:
                            journal.write(key + "\n")
                        written += len(keys)
                        journal.flush()
                        if written // 1000 != (written - len(keys)) // 1000:
                            print(f"R2 confirmed {written}/{len(files)} source objects.", flush=True)
                except Exception as exc:
                    errors.append((len(future_map[fut]), type(exc).__name__, str(exc)[:180]))
    if errors:
        print("First batch failures:", errors[:8])
        raise RuntimeError(f"R2_IMPORT_INCOMPLETE {len(errors)} failed batches (no indexing)")
    if written != len(files):
        raise RuntimeError("Unexpected missing files after batch import")

    samples = [files[0], files[len(files)//2], files[-1]]
    if args.scope == "all":
        for lib in ("amboss", "usmle", "passmedicine", "pastest", "one-examination"):
            samples.append(next((k,p) for k,p in files if k.startswith(f"medical-search/v1/{lib}/")))
    for key, path in samples:
        status, evidence = submit(args.url, token, "/verify?key=" + quote(key, safe=""))
        if status != 200 or evidence.get("sha256") != hashlib.sha256(path.read_bytes()).hexdigest():
            raise RuntimeError(f"R2_RETRIEVAL_SHA256_MISMATCH: {key} HTTP={status}")
    print(f"SUCCESS {written} persisted objects and {len(samples)} exact SHA256 R2 readback checks.")
    print("Separate AI Search indexing/real citations remain UNVERIFIED.")


if __name__ == "__main__":
    main()
