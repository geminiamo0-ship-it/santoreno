#!/usr/bin/env python3
"""Pinned Santo gallery v3 -> isolated Cloudflare AI Search instance (staging only).
Do not write existing five library indexes; do not upload dataset to public Git.
"""
import argparse
import hashlib
import io
import json
import os
import re
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote, urlparse

import requests

COUNT = 3295
INSTANCE = "santo-medical-images"
EMBED = "@cf/qwen/qwen3-embedding-0.6b"
HASH = "fa469888c75cec9880bc0af2b2423115ff848d9b74d72563b310f09db0e2e2e5"
HOST = "pub-2a81f2cb19cc4473a3d076e657af6121.r2.dev"
MANIFEST_KEY = "gallery/v1/santo_image_manifest.json"

def parse_dataset(archive: Path, output: Path):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != HASH:
        raise ValueError("Dataset SHA-256 mismatch; no Cloudflare writes allowed")
    docs = []
    manifest = {}
    with zipfile.ZipFile(archive) as z:
        if z.testzip():
            raise ValueError("Damaged ZIP")
        names = sorted(x for x in z.namelist() if re.fullmatch(r"santo_medical_images/img_\d{6}\.json", x))
        if len(names) != COUNT:
            raise ValueError(f"Expected {COUNT} independent image records, got {len(names)}")
        for name in names:
            d = json.loads(z.read(name))
            image_id = d.get("image_id")
            file = d.get("filename")
            key = d.get("r2_key")
            src = d.get("image_url")
            if not re.fullmatch(r"img_\d{6}", str(image_id)) or name != f"santo_medical_images/{image_id}.json":
                raise ValueError("Invalid image identity")
            if not isinstance(file, str) or key != "offline_media/" + file:
                raise ValueError(f"Invalid R2 key for {image_id}")
            if not isinstance(src, str) or urlparse(src).scheme != "https" or urlparse(src).netloc != HOST or urlparse(src).path != "/offline_media/" + quote(file, safe=""):
                raise ValueError(f"Invalid image URL for {image_id}")
            if not isinstance(d.get("search_text"), str) or len(d["search_text"].strip()) < 30:
                raise ValueError(f"Missing medical context for {image_id}")
            if image_id in manifest:
                raise ValueError("Duplicate image ID")
            document = {"image_id": image_id, "title": d["title"], "search_text": d["search_text"]}
            docs.append((f"{image_id}.json", json.dumps(document, ensure_ascii=False).encode()))
            attribution = d.get("source_attribution") or {}
            manifest[image_id] = {
                "image_url": src, "title": d["title"],
                "visual_caption": d.get("visual_caption") or "",
                "primary_system": d.get("primary_system") or "",
                "source_name": attribution.get("source_name") or "Medical gallery",
            }
    if len(docs) != COUNT or len(manifest) != COUNT:
        raise ValueError("Unexpected record count")
    output.mkdir(parents=True, exist_ok=True)
    path = output / "manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Validated {COUNT} unique medical figures; manifest bytes {path.stat().st_size}")
    return docs, path

class Cloudflare:
    def __init__(self):
        account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        if not re.fullmatch(r"[0-9a-f]{32}", account) or not token:
            raise RuntimeError("Missing existing GitHub Action Cloudflare credentials")
        self.root = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai-search/namespaces/default"
        self.headers = {"Authorization": f"Bearer {token}"}

    def call(self, method, suffix, *, json_body=None, files=None, timeout=50):
        response = requests.request(method, self.root + suffix,
            headers=self.headers, json=json_body, files=files, timeout=timeout)
        try:
            body = response.json()
        except ValueError:
            body = {}
        if response.status_code == 404 and method == "GET":
            return None
        if not response.ok or body.get("success") is False:
            codes = [str(x.get("code")) for x in body.get("errors", []) if isinstance(x, dict)]
            raise RuntimeError(f"Cloudflare HTTP {response.status_code}, error codes {codes[:3]}")
        return body.get("result")

    def instance(self):
        info = self.call("GET", f"/instances/{INSTANCE}")
        if info is None:
            created = self.call("POST", "/instances", json_body={
                "id": INSTANCE, "embedding_model": EMBED,
                "index_method": {"keyword": True, "vector": True},
                "fusion_method": "rrf", "chunk_size": 576, "chunk_overlap": 10
            })
            print(f"Created isolated AI Search index {INSTANCE}")
            info = created
        else:
            print(f"Reusing existing isolated image index {INSTANCE}")
        if not isinstance(info, dict) or info.get("id") != INSTANCE or info.get("embedding_model") != EMBED:
            raise RuntimeError("Existing instance has wrong embedding model/identity; refusing to modify")
        if info.get("source") or info.get("type") == "r2":
            raise RuntimeError("Instance is R2-backed; expected managed built-in storage")
        return info

    def upload(self, document):
        name, raw = document
        error = ""
        for attempt in range(6):
            try:
                result = self.call("POST", f"/instances/{INSTANCE}/items",
                    files={"file": (name, io.BytesIO(raw), "application/json")}, timeout=60)
                if not isinstance(result, dict) or result.get("key", "").split("/")[-1] != name:
                    return name, "Unexpected upload result key"
                return name, ""
            except (requests.RequestException, RuntimeError) as e:
                error = type(e).__name__ if isinstance(e, requests.RequestException) else str(e)
                if "HTTP 400" in error or "HTTP 403" in error or "HTTP 401" in error:
                    break
                time.sleep(min(2 ** attempt, 20))
        return name, error

    def wait_and_smoke(self):
        deadline = time.monotonic() + 1100
        while time.monotonic() < deadline:
            stats = self.call("GET", f"/instances/{INSTANCE}/stats")
            if not isinstance(stats, dict):
                raise RuntimeError("Missing index stats")
            counts = {k: stats.get(k) for k in ("completed","queued","running","error","skipped","degraded")}
            print("Image-only indexing stats:", counts, flush=True)
            if (not stats.get("degraded") and stats.get("completed",0) >= COUNT and
                stats.get("error",0) == 0 and stats.get("queued",0) == 0 and stats.get("running",0) == 0):
                break
            if stats.get("error", 0):
                raise RuntimeError("Some image documents failed indexing")
            time.sleep(30)
        else:
            raise RuntimeError("Image index not fully ready; do NOT enable staging flag")
        for query in ("Tetrahydrobiopterin BH4 phenylketonuria", "hyperkalemia ECG", "Cushing syndrome"):
            result = self.call("POST", f"/instances/{INSTANCE}/search", json_body={
                "messages": [{"role": "user", "content": query}],
                "ai_search_options": {"retrieval": {"max_num_results": 5}, "query_rewrite": {"enabled": False}}
            })
            if not isinstance(result, dict) or not result.get("chunks"):
                raise RuntimeError(f"Image search smoke returned no chunks for test query: {query}")
            print("Smoke OK:", query, "chunks:",len(result["chunks"]))
        print("Gallery fully indexed, search smoke PASSED.")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    docs, manifest = parse_dataset(Path(args.archive), Path(args.output))
    if not args.execute:
        print("Dry run only; Cloudflare untouched")
        return
    cf = Cloudflare()
    cf.instance()
    failures = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        tasks = [pool.submit(cf.upload, document) for document in docs]
        for count, future in enumerate(as_completed(tasks), 1):
            name, error = future.result()
            if error:
                failures.append((name, error))
            if count % 200 == 0 or count == COUNT:
                print(f"Index files submitted {count}/{COUNT} failures={len(failures)}", flush=True)
    if failures:
        print("Failed document examples:", failures[:6])
        raise RuntimeError(f"{len(failures)} image documents could not be uploaded")
    cf.wait_and_smoke()
    print(f"Safe to publish R2 manifest from: {manifest}")

if __name__ == "__main__":
    main()
