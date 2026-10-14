#!/usr/bin/env python3
"""Upload validated private Santo corpus using existing Cloudflare account API token.

Uses the repository-pinned Wrangler (Cloudflare Account API); R2-specific S3
access/secret keys are NOT required. No book bytes pass through Git.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import os
from pathlib import Path
import subprocess

STAGING = "santo-content-staging"
EXPECTED = {"medical-articles": 7049, "medical-search": 67524,
            "medical-library-catalog": 6}
ROOTS = ("medical-articles/v1/", "medical-search/v1/",
         "medical-library-catalog/v1/")


def collect(root):
    result = []
    for file in root.rglob("*"):
        if not file.is_file():
            continue
        key = file.relative_to(root).as_posix()
        if key.startswith(ROOTS) and file.suffix in {".json", ".md"}:
            result.append((key, file))
    return sorted(result)


def invoke(wrangler_root, key, local_file, operation):
    object_path = STAGING + "/" + key
    command = ["pnpm", "exec", "wrangler", "r2", "object", operation,
               object_path, "--remote"]
    if operation == "put":
        command += ["--file=" + str(local_file),
                    "--content-type=" + ("text/markdown; charset=utf-8"
                                         if key.endswith(".md")
                                         else "application/json; charset=utf-8")]
    elif operation == "get":
        command += ["--file=" + str(local_file)]
    completed = subprocess.run(
        command, cwd=wrangler_root, capture_output=True,
        text=True, timeout=180, check=False,
    )
    if completed.returncode:
        raise RuntimeError(f"Wrangler {operation} failed on an allowed object "
                           f"(exit={completed.returncode}); "
                           f"{completed.stderr[-350:]}")
    return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dir", required=True)
    p.add_argument("--execute", action="store_true")
    p.add_argument("--workers", type=int, default=10)
    p.add_argument("--wrangler-dir", default="workers/api")
    p.add_argument("--checkpoint", default="santo-private-r2-wrangler-checkpoint.txt")
    args = p.parse_args()
    if not 1 <= args.workers <= 12:
        raise ValueError("Wrangler concurrency must be 1-12 to avoid Node memory spikes")
    root = Path(args.dir).resolve()
    wrangler_root = Path(args.wrangler_dir).resolve()
    if not wrangler_root.is_dir():
        raise ValueError("Wrangler directory not found")
    files = collect(root)
    counts = dict(Counter(key.split("/")[0] for key, _ in files))
    if counts != EXPECTED:
        raise ValueError(f"Refusing unexpected/incomplete medical corpus: {counts}")
    total = sum(path.stat().st_size for _, path in files)
    print(f"Validated {len(files)} allowed files ({total / 1048576:.1f} MiB) "
          f"to private {STAGING}. execute={args.execute}")
    if not args.execute:
        return
    if not os.environ.get("CLOUDFLARE_API_TOKEN") or not os.environ.get("CLOUDFLARE_ACCOUNT_ID"):
        raise ValueError("Santo existing Cloudflare account credentials are required")
    checkpoint = Path(args.checkpoint).resolve()
    if checkpoint.is_relative_to(root):
        raise ValueError("Checkpoint cannot be inside medical corpus")
    uploaded = set(checkpoint.read_text().splitlines()) if checkpoint.exists() else set()
    keys = {key for key, _ in files}
    if not uploaded.issubset(keys):
        raise ValueError("Stale or invalid upload checkpoint; cannot trust its contents")
    pending = [(key, path) for key, path in files if key not in uploaded]
    errors = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool, checkpoint.open("a") as journal:
        futures = {pool.submit(invoke, wrangler_root, key, file, "put"): key
                   for key, file in pending}
        for index, future in enumerate(as_completed(futures), 1):
            key = futures[future]
            try:
                future.result()
                journal.write(key + "\n")
            except Exception as exc:
                errors.append(key)
                print(f"Upload failed for {key}: {type(exc).__name__}")
            if index % 200 == 0:
                journal.flush()
                print(f"Processed {index}/{len(pending)}; failures so far {len(errors)}")
        journal.flush()
    if errors:
        raise RuntimeError(f"Upload incomplete: {len(errors)} failed; do not index")

    # Verify canonical reader/search catalogs and 5 independent search sections.
    sample = [files[0], files[-1], files[len(files) // 2]]
    for library in ("amboss", "usmle", "passmedicine", "pastest", "one-examination"):
        sample.append(next((key, path) for key, path in files
                           if key.startswith(f"medical-search/v1/{library}/")))
    sample.append(("medical-library-catalog/v1/catalog.json",
                   root / "medical-library-catalog/v1/catalog.json"))
    for i, (key, path) in enumerate(sample):
        downloaded = checkpoint.parent / f".santo-r2-readback-{i}"
        try:
            invoke(wrangler_root, key, downloaded, "get")
            if hashlib.sha256(downloaded.read_bytes()).digest() != hashlib.sha256(path.read_bytes()).digest():
                raise RuntimeError("R2 content hash verification failed")
        finally:
            downloaded.unlink(missing_ok=True)
    print(f"SUCCESS: {len(files)} PUT commands completed or checkpointed; "
          "nine sample private-R2 SHA-256 readbacks matched.")
    print("AI Search indexing and clinical citation QA are STILL PENDING.")


if __name__ == "__main__":
    main()
