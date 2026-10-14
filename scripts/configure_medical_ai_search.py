#!/usr/bin/env python3
"""Safely provision five Santo AI Search R2 instances after verified private upload.

Never changes/deletes unrelated instances or enables a public AI Search endpoint.
"""
import argparse
import json
import os
import re
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

LIBRARIES = ("amboss", "usmle", "passmedicine", "pastest", "one-examination")
BUCKET = "santo-content-staging"
PREFIX = "/medical-search/v1/{}/**"


def api(account_id, token, path, method="GET", body=None):
    url = (f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
           f"/ai-search/namespaces/default{path}")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = Request(url, method=method, data=data, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/json",
        "Content-Type": "application/json",
    })
    try:
        with urlopen(request, timeout=45) as response:
            code = response.status
            payload = json.load(response)
    except HTTPError as error:
        code = error.code
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (ValueError, UnicodeError):
            payload = {}
    except (URLError, TimeoutError) as error:
        raise RuntimeError("Cloudflare API request failed") from error
    if code != 404 and not (200 <= code < 300) or (payload.get("success") is False and code != 404):
        details = payload.get("errors", [])
        codes = [str(x.get("code")) for x in details[:2] if isinstance(x, dict)]
        raise RuntimeError(f"Cloudflare AI Search API HTTP {code}; codes {codes}")
    return code, payload.get("result")


def main(execute=False):
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    service_token = os.environ.get("AI_SEARCH_R2_SERVICE_TOKEN_ID", "")
    if not re.fullmatch(r"[0-9a-f]{32}", account_id):
        raise ValueError("Missing/invalid CLOUDFLARE_ACCOUNT_ID")
    if not token:
        raise ValueError("Missing CLOUDFLARE_API_TOKEN with AI Search Edit/Run")
    if execute and not re.fullmatch(r"[0-9a-f-]{36}", service_token):
        raise ValueError("Missing AI_SEARCH_R2_SERVICE_TOKEN_ID UUID")

    code, instances = api(account_id, token, "/instances")
    if code != 200 or not isinstance(instances, list):
        raise RuntimeError("Cannot enumerate AI Search instances safely")
    present = {x.get("id"): x for x in instances if isinstance(x, dict)}
    planned = [lib for lib in LIBRARIES if lib not in present]
    if len(present) + len(planned) > 10:
        raise RuntimeError("Would exceed Santo's ten-instance global search limit")
    for lib in LIBRARIES:
        code, instance = api(account_id, token, f"/instances/{lib}")
        if code == 200:
            expected = PREFIX.format(lib)
            params = (instance or {}).get("source_params") or {}
            patterns = params.get("include_items") or []
            if (instance.get("type") != "r2" or instance.get("source") != BUCKET
                or patterns != [expected]):
                raise RuntimeError(
                    f"Existing instance {lib} has different ownership/bucket/path filters"
                )
            print(f"Existing verified: {lib}")
            continue
        if not execute:
            print(f"Would create R2-scoped AI Search instance: {lib}")
            continue
        body = {
            "id": lib, "type": "r2", "source": BUCKET, "token_id": service_token,
            "source_params": {"include_items": [PREFIX.format(lib)]},
        }
        created, _ = api(account_id, token, "/instances", "POST", body)
        if created not in (200, 201):
            raise RuntimeError(f"Instance create failed: {lib}")
        print(f"Created scoped R2 instance: {lib}")

    if not execute:
        print("Dry run only: no instances created")
        return
    # Stats may still show queued/running — never label indexing complete yet.
    stats = {}
    for lib in LIBRARIES:
        status, result = api(account_id, token, f"/instances/{lib}/stats")
        if status != 200:
            raise RuntimeError(f"Cannot retrieve indexing stats for {lib}")
        stats[lib] = {
            key: result.get(key, 0) for key in
            ("completed", "queued", "running", "error", "skipped")
        }
    print(json.dumps({"instances": LIBRARIES, "indexingStats": stats,
                      "fullyIndexed": False}, indent=2))
    print("Indexing is asynchronous. Medical source/citation acceptance remains PENDING.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    main(args.execute)
