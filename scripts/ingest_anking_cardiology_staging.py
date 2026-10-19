#!/usr/bin/env python3
"""Validate owner-licensed AnKing V3 and stage an isolated Cloudflare note-level index.
No source media, raw tags, clinical citations, or existing clinical indexes are modified.
The initial clinical review statuses remain pending until independently approved.
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import io
import json
import os
from pathlib import Path
import re
import time
import zipfile

import requests

SOURCE_SHA = "63ab3f221943c0387da65db0c82717721e707b23ac70ed2c1e1effe151d989ba"
SOURCE_NOTES = 4151
SOURCE_CARDS = 5156
INSTANCE = "santo-anking-cardiology"
EMBED = "@cf/qwen/qwen3-embedding-0.6b"
SHARDS = 32
R2_PREFIX = "anking/v3/cardiology/shards"
DRIVE_ID = "1be1rDBB2R3SG1i-TzdS-QC5hrf9E4jR6"


def download_source(destination: Path):
    if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() == SOURCE_SHA:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    candidates = [
        f"https://drive.google.com/uc?export=download&id={DRIVE_ID}",
        f"https://drive.usercontent.google.com/download?id={DRIVE_ID}&export=download&confirm=t",
    ]
    for url in candidates:
        result = requests.get(url, timeout=120)
        if result.ok and result.content.startswith(b"PK\x03\x04"):
            if hashlib.sha256(result.content).hexdigest() != SOURCE_SHA:
                raise ValueError("Source SHA mismatch; abort before ANY Cloudflare writes")
            destination.write_bytes(result.content)
            return
    raise RuntimeError("Cannot download exact SHA-pinned Cardiology V3 from public Drive share")


def prepare(source: Path, output: Path):
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA:
        raise ValueError("Bad V3 SHA-256; all infrastructure writes forbidden")
    with zipfile.ZipFile(source) as z:
        if z.testzip():
            raise ValueError("Damaged source ZIP")
        search = [json.loads(x) for x in z.read("cardiology_search_documents.jsonl").splitlines()]
        full = json.loads(z.read("cardiology_full_metadata.json"))
    if len(search) != SOURCE_NOTES or len(full) != SOURCE_NOTES:
        raise ValueError("Unexpected V3 record count")
    ids = set()
    cards = set()
    for row in full:
        nid = row.get("note_id")
        if not isinstance(nid, int) or nid in ids or nid < 10**10:
            raise ValueError("Invalid or duplicate original note ID")
        ids.add(nid)
        if row.get("review_status") != "pending_expert_review" or row.get("rights_status") != "unverified_rights_locked":
            raise ValueError("Unexpected source review/rights status; re-audit required")
        for card in row.get("cards", []):
            cid = card.get("card_id")
            if not isinstance(cid, int) or cid in cards or card.get("anki_copy_query") != f"cid:{cid}":
                raise ValueError(f"Broken card mapping on note {nid}")
            if card.get("cloze_number") != card.get("ord", -100) + 1:
                raise ValueError(f"Broken cloze ordinal on note {nid}")
            cards.add(cid)
    if len(cards) != SOURCE_CARDS:
        raise ValueError(f"Wrong CID count: {len(cards)}")
    search_ids = {row["note_id"] for row in search}
    if search_ids != ids or len(search_ids) != SOURCE_NOTES:
        raise ValueError("Search document IDs and source metadata differ")
    output.mkdir(parents=True, exist_ok=True)
    index = output / "items"
    shard_dir = output / "shards"
    index.mkdir(exist_ok=True)
    shard_dir.mkdir(exist_ok=True)
    bucket = defaultdict(dict)
    for row in full:
        nid = row["note_id"]
        key = f"note_{nid}"
        # Owner explicitly confirmed commercial rights to the AnKing text.
        # Asset rights are NOT inferred from that claim: no images/audio are copied.
        note = {
            "note_id": nid,
            "guid": row.get("guid"),
            "source_release": row.get("source_release"),
            "primary_system": row.get("primary_system"),
            "topic": row.get("primary_topic") or "",
            "medical_fact": row.get("clean_fact_text") or "",
            "clinical_pearl": row.get("clinical_pearl") or "",
            "rights_status": "licensed_for_santo",
            # Never represent unreviewed clinical teaching material as medically approved.
            "review_status": "pending_expert_review",
            "cards": [
                {
                    "card_id": c["card_id"],
                    "cloze_number": c["cloze_number"],
                    "target_concepts": c.get("target_concepts") or [],
                    "preview": c.get("cloze_preview") or "",
                    "anki_query": c["anki_copy_query"],
                }
                for c in row["cards"]
            ],
        }
        bucket[nid % SHARDS][key] = note
    for i in range(SHARDS):
        file = shard_dir / f"shard_{i:02d}.json"
        file.write_text(json.dumps(bucket[i], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for row in search:
        key = f"note_{row['note_id']}"
        if row["id"] != key:
            raise ValueError("Search item key mismatch")
        text = row.get("search_text")
        if not isinstance(text, str) or len(text.strip()) < 15 or len(text) > 6000:
            raise ValueError(f"Invalid search text for {key}")
        if re.search(r"\[sound:|<img\b|photo credit", text, flags=re.I):
            raise ValueError(f"Unwanted media or attribution in index text: {key}")
        clean = {
            "note_id": row["note_id"],
            "title": f"{row.get('primary_system', 'Medical')} - {row.get('primary_topic', '')}"[:180],
            "search_text": text,
        }
        (index / f"{key}.json").write_text(
            json.dumps(clean, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
    report = {
        "source_sha256": SOURCE_SHA,
        "notes": len(ids),
        "cards": len(cards),
        "shards": SHARDS,
        "index_items": len(list(index.glob("note_*.json"))),
        "image_assets_uploaded": 0,
        "rights": "owner_confirmed_commercial_text",
        "clinical_review": "pending_expert_review",
    }
    (output / "validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("OFFLINE VALIDATION", report, flush=True)
    return sorted(index.glob("note_*.json"))


class Cloudflare:
    def __init__(self):
        account = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
        token = os.getenv("CLOUDFLARE_API_TOKEN", "")
        if not re.fullmatch(r"[0-9a-f]{32}", account) or not token:
            raise RuntimeError("Cloudflare secrets unavailable; no uploads attempted")
        self.root = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai-search/namespaces/default"
        self.headers = {"Authorization": f"Bearer {token}"}

    def call(self, method, path, *, body=None, files=None, timeout=55):
        result = requests.request(method, self.root + path, headers=self.headers,
                                  json=body, files=files, timeout=timeout)
        if result.status_code == 404 and method == "GET":
            return None
        try:
            raw = result.json()
        except ValueError:
            raw = {}
        if not result.ok or raw.get("success") is False:
            codes = [str(e.get("code")) for e in raw.get("errors", []) if isinstance(e, dict)]
            raise RuntimeError(f"Cloudflare HTTP {result.status_code}: codes={codes[:3]}")
        return raw.get("result")

    def ensure_isolated_instance(self):
        info = self.call("GET", f"/instances/{INSTANCE}")
        if info is None:
            info = self.call("POST", "/instances", body={
                "id": INSTANCE, "embedding_model": EMBED,
                "index_method": {"keyword": True, "vector": True},
                "fusion_method": "rrf", "chunk_size": 576, "chunk_overlap": 10,
            })
            print("Created isolated AnKing instance", flush=True)
        if not isinstance(info, dict) or info.get("id") != INSTANCE or info.get("embedding_model") != EMBED:
            raise RuntimeError("Unexpected existing index identity/model; abort")
        if info.get("source") or info.get("type") == "r2":
            raise RuntimeError("Index must use managed built-in storage, not an existing source bucket")
        return info

    def upload_one(self, file):
        error = ""
        for attempt in range(5):
            try:
                with file.open("rb") as handle:
                    result = self.call(
                        "POST", f"/instances/{INSTANCE}/items",
                        files={"file": (file.name, io.BytesIO(handle.read()), "application/json")},
                        timeout=65,
                    )
                if not isinstance(result, dict) or result.get("key", "").split("/")[-1] != file.name:
                    return file.name, "Unexpected Cloudflare upload item key"
                return file.name, ""
            except (requests.RequestException, RuntimeError) as exc:
                error = str(exc)[:140]
                if "HTTP 400" in error or "HTTP 403" in error or "HTTP 401" in error:
                    break
                time.sleep(min(2 ** attempt, 15))
        return file.name, error

    def wait_for_index(self):
        deadline = time.monotonic() + 25 * 60
        while time.monotonic() < deadline:
            stats = self.call("GET", f"/instances/{INSTANCE}/stats")
            if not isinstance(stats, dict):
                raise RuntimeError("Missing index stats")
            counts = {k: stats.get(k) for k in ("completed", "queued", "running", "error", "degraded")}
            print("AnKing index", counts, flush=True)
            if stats.get("error", 0) > 0 or stats.get("degraded"):
                raise RuntimeError("AnKing indexing error/degraded; do not enable flag")
            if (stats.get("completed", 0) >= SOURCE_NOTES and
                stats.get("queued", 0) == 0 and stats.get("running", 0) == 0):
                break
            time.sleep(25)
        else:
            raise RuntimeError("AnKing indexing timed out; do not enable flag")
        for query in ("aortic stenosis murmur", "ventricular septal defect holosystolic",
                      "atrial fibrillation anticoagulation"):
            result = self.call("POST", f"/instances/{INSTANCE}/search", body={
                "messages": [{"role": "user", "content": query}],
                "ai_search_options": {
                    "retrieval": {"max_num_results": 5, "match_threshold": 0.25},
                    "query_rewrite": {"enabled": False},
                },
            })
            if not isinstance(result, dict) or not result.get("chunks"):
                raise RuntimeError(f"No AnKing chunks for {query}")
            print("Search smoke PASSED:", query, "hits=", len(result["chunks"]), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    source = Path(args.archive)
    if args.download:
        download_source(source)
    docs = prepare(source, Path(args.output))
    if not args.execute:
        print("Dry run only: Cloudflare untouched", flush=True)
        return
    cf = Cloudflare()
    cf.ensure_isolated_instance()
    errors = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(cf.upload_one, path) for path in docs]
        for count, fut in enumerate(as_completed(futures), 1):
            name, error = fut.result()
            if error:
                errors.append((name, error))
            if count % 200 == 0 or count == len(docs):
                print(f"Indexed submission {count}/{len(docs)} errors={len(errors)}", flush=True)
    if errors:
        print("Errors", errors[:8], flush=True)
        raise RuntimeError(f"Cloudflare rejected {len(errors)} of {len(docs)} note documents")
    cf.wait_for_index()
    print("All AnKing content indexed in isolated STAGING instance", flush=True)


if __name__ == "__main__":
    main()
