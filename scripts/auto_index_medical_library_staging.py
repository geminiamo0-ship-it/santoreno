#!/usr/bin/env python3
"""Post-upload, deterministic Santo staging AI Search instance provisioner.

Uses Santo's EXISTING Cloudflare API account token and the pinned Wrangler
client. Wrangler registers/reuses the R2 AI Search service token automatically.
No new secrets required. Never changes conflicting existing instances.
"""
import json
import os
from pathlib import Path
import subprocess
from urllib.error import HTTPError
from urllib.request import Request, urlopen

LIBRARIES = ("amboss", "usmle", "passmedicine", "pastest", "one-examination")
BUCKET = "santo-content-staging"


def get_json(path):
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    req = Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}"
        f"/ai-search/namespaces/default{path}",
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
    )
    try:
        with urlopen(req, timeout=50) as res:
            payload = json.load(res)
    except HTTPError as error:
        raise RuntimeError(f"Cloudflare AI Search API HTTP {error.code}") from error
    if payload.get("success") is not True:
        raise RuntimeError("Cloudflare AI Search API rejected the request")
    return payload.get("result")


def verify_instance(result, library):
    if not isinstance(result, dict):
        raise RuntimeError(f"Malformed AI Search instance: {library}")
    prefix = f"medical-search/v1/{library}/"
    params = result.get("source_params") or {}
    actual_prefix = params.get("prefix")
    actual_includes = params.get("include_items") or []
    matching = actual_prefix in (prefix, "/" + prefix) or actual_includes == [
        "/" + prefix + "**"
    ]
    if (result.get("type") != "r2" or result.get("source") != BUCKET
            or not matching):
        raise RuntimeError(
            f"Refusing instance ID collision or broad R2 indexing for {library}"
        )
    if (result.get("public_endpoint") or {}).get("enabled") is True:
        raise RuntimeError(f"AI Search instance has unexpected public endpoint: {library}")


def main():
    if not os.environ.get("CLOUDFLARE_ACCOUNT_ID") or not os.environ.get("CLOUDFLARE_API_TOKEN"):
        raise RuntimeError("Existing Santo Cloudflare credentials are missing")
    if os.environ.get("GITHUB_REPOSITORY") != "geminiamo0-ship-it/santoreno":
        raise RuntimeError("Wrong GitHub repository")
    listing = get_json("/instances")
    if not isinstance(listing, list):
        raise RuntimeError("Unrecognized AI Search namespace listing")
    instances = {record["id"]: record for record in listing if isinstance(record, dict) and "id" in record}
    new = [library for library in LIBRARIES if library not in instances]
    if len(instances) + len(new) > 10:
        raise RuntimeError("Would exceed Santo All Libraries limit of 10 search instances")

    for library in LIBRARIES:
        if library in instances:
            verify_instance(instances[library], library)
            print(f"Verified existing AI Search library: {library}", flush=True)
            continue
        prefix = f"medical-search/v1/{library}/"
        command = [
            "pnpm", "exec", "wrangler", "ai-search", "create", library,
            "--namespace", "default",
            "--type", "r2", "--source", BUCKET,
            "--prefix", prefix,
            "--hybrid-search", "true",
        ]
        result = subprocess.run(
            command, cwd=Path("workers/api").resolve(),
            capture_output=True, text=True, input="\n", timeout=180,
            env={**os.environ, "CI": "true"},
        )
        if result.returncode != 0:
            # Wrangler logs can vary by version; do not print potentially sensitive output.
            raise RuntimeError(
                f"Unable to create Cloudflare AI Search R2 instance {library}: "
                f"exit {result.returncode}"
            )
        print(f"Requested private R2 AI Search instance: {library}", flush=True)

    for library in LIBRARIES:
        result = get_json(f"/instances/{library}")
        verify_instance(result, library)
        print(f"Verified index source/prefix for {library}", flush=True)

    print("Five medical AI Search instances configured; indexing is asynchronous.")
    print("Citation-to-section acceptance is STILL PENDING; do not mark the pilot complete.")


if __name__ == "__main__":
    main()
