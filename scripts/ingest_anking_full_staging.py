#!/usr/bin/env python3
"""Source-verified AnKing v12 full-library staging ingestion. No production writes.

30,521 source notes, 36,941 source cards (36,937 reported cloze-verified).
Deliberately exclude nonmedical setup instructions and unusable image-only cards;
the resulting eligible count is pinned to the verified source snapshot.
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

DRIVE_FILE_ID = "1sr_XbG5KFC8hFuNXf23WKCthyFYWk4ls"
SOURCE_SHA256 = "3e75c1629a74423f012556ff0b52c87703ce12812cfa35b195f3bf57dcebfb25"
TOTAL_SOURCE_NOTES = 30521
TOTAL_SOURCE_CARDS = 36941
ELIGIBLE_NOTES = 30489
ELIGIBLE_CARDS = 36908
SHARDS = 128
INSTANCE = "santo-anking-step-v12"
R2_PREFIX = "anking/v12/full/shards/"
MODEL = "@cf/qwen/qwen3-embedding-0.6b"


def verify_sha(path: Path):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        raise RuntimeError(f"Unrecognized AnKing library digest {digest}; abort all writes")


def download(path: Path):
    if path.exists():
        verify_sha(path)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://drive.google.com/uc?export=download&id={DRIVE_FILE_ID}"
    response = requests.get(url, timeout=160)
    if not response.ok or not response.content.startswith(b"PK\x03\x04"):
        url = f"https://drive.usercontent.google.com/download?id={DRIVE_FILE_ID}&export=download&confirm=t"
        response = requests.get(url, timeout=160)
    if not response.ok or not response.content.startswith(b"PK\x03\x04"):
        raise RuntimeError("Cannot fetch source ZIP; no Cloudflare writes attempted")
    path.write_bytes(response.content)
    verify_sha(path)


def eligible(note: dict, document: dict) -> str | None:
    name = note.get("notetype_name", "")
    if name.startswith("Getting Started"):
        return "anki_tutorial"
    if name == "Image Occlusion Enhanced":
        return "image_only"
    if any("AnkiHub_Instructions" in tag for tag in note.get("raw_tags", [])):
        return "deck_instructions"
    if name.startswith("IO-one by one") and (
        "How to Create" in note.get("clean_fact_text", "") or
        len(note.get("clean_fact_text", "")) < 25
    ):
        return "note_creation_instructions"
    if len(document.get("search_text", "")) < 70:
        return "low_content"
    if not any(str(card.get("cloze_preview") or "").strip() for card in note.get("cards", [])):
        return "missing_card_preview"
    return None


def prepare(archive: Path, output: Path):
    verify_sha(archive)
    with zipfile.ZipFile(archive) as z:
        if z.testzip():
            raise RuntimeError("Source ZIP CRC failed")
        metadata = json.loads(z.read("santo_anking_full_metadata.json"))
        search = [json.loads(row) for row in z.read("santo_anking_search_documents.jsonl").splitlines()]
        source_report = json.loads(z.read("source_db_verification_report.json"))
    if len(metadata) != TOTAL_SOURCE_NOTES or len(search) != TOTAL_SOURCE_NOTES:
        raise RuntimeError("Unexpected source note count")
    if source_report.get("total_cards_verified") != 36937 or source_report.get("cloze_matching_failures") != 4:
        raise RuntimeError("Unrecognized verification report; do not claim 100 percent cloze mapping")
    search_by_id = {row["note_id"]: row for row in search}
    if len(search_by_id) != TOTAL_SOURCE_NOTES:
        raise RuntimeError("Duplicate search note ID")
    all_notes, all_cards = set(), set()
    for row in metadata:
        note_id = row["note_id"]
        if note_id in all_notes or note_id not in search_by_id:
            raise RuntimeError("Original note mismatch/duplicate")
        all_notes.add(note_id)
        for card in row["cards"]:
            cid = card["card_id"]
            if not isinstance(cid, int) or cid in all_cards or card.get("anki_copy_query") != f"cid:{cid}":
                raise RuntimeError("Original CID collision or query mismatch")
            if card.get("cloze_number") != card.get("ord", -9) + 1:
                raise RuntimeError("Inconsistent ord/cloze mapping")
            all_cards.add(cid)
    if len(all_cards) != TOTAL_SOURCE_CARDS:
        raise RuntimeError("Source total card count mismatch")

    items = output / "items"
    shards = output / "shards"
    items.mkdir(parents=True, exist_ok=True)
    shards.mkdir(parents=True, exist_ok=True)
    mapped = defaultdict(dict)
    skips = Counter()
    eligible_card_ids = set()
    for note in metadata:
        nid = note["note_id"]
        doc = search_by_id[nid]
        if doc["id"] != f"note_{nid}":
            raise RuntimeError("Note ID/doc key mismatch")
        reason = eligible(note, doc)
        if reason:
            skips[reason] += 1
            continue
        raw_text = doc["search_text"]
        if re.search(r"\[sound:|<img\b|Photo credit:", raw_text, re.I):
            raise RuntimeError("Search contains media/attribution")
        # Restrict prompt vector text: no raw tags, media fields or source-media URLs.
        payload = {
            "note_id": nid,
            "title": (note.get("primary_system", "") + " — " + note.get("primary_topic", ""))[:180],
            "search_text": raw_text[:5000],
        }
        (items / f"note_{nid}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        normalized_cards = []
        for card in note["cards"]:
            cid = card["card_id"]
            if cid in eligible_card_ids:
                raise RuntimeError("Duplicate eligible Card ID")
            eligible_card_ids.add(cid)
            normalized_cards.append({
                "card_id": cid,
                "cloze_number": card["cloze_number"],
                "target_concepts": card.get("target_concepts") or [],
                "preview": (card.get("cloze_preview") or "")[:500],
                "anki_query": card["anki_copy_query"],
            })
        mapped[nid % SHARDS][f"note_{nid}"] = {
            "note_id": nid,
            "guid": note.get("guid"),
            "primary_system": note.get("primary_system"),
            "topic": note.get("primary_topic") or "",
            "medical_fact": (note.get("clean_fact_text") or "")[:420],
            "clinical_pearl": (note.get("clinical_pearl") or "")[:220],
            # Owner-confirmed commercial text license. No source images or audio.
            "rights_status": "licensed_for_santo",
            # Medical claims must not reach Luna until reviewed/approved one-by-one.
            "review_status": "pending_expert_review",
            "cards": normalized_cards,
        }

    total = sum(map(len, mapped.values()))
    if total != ELIGIBLE_NOTES or len(eligible_card_ids) != ELIGIBLE_CARDS:
        raise RuntimeError(f"Source eligibility drift notes={total} cards={len(eligible_card_ids)}")
    for shard in range(SHARDS):
        (shards / f"shard_{shard:03d}.json").write_text(
            json.dumps(mapped[shard], ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
    validation = {
        "source_sha256": SOURCE_SHA256,
        "original_notes": TOTAL_SOURCE_NOTES,
        "original_cards": TOTAL_SOURCE_CARDS,
        "source_cloze_verified": 36937,
        "source_cloze_unverified": 4,
        "indexable_notes": total,
        "indexable_cards": len(eligible_card_ids),
        "exclusions": dict(skips),
        "r2_shards": SHARDS,
        "note_items": len(list(items.glob("note_*.json"))),
        "uploaded_images": 0,
        "license": "owner-confirmed commercial text",
        "medical_review": "pending; CID navigation only",
    }
    (output / "validation.json").write_text(json.dumps(validation, indent=2), encoding="utf-8")
    print("VALIDATED_FULL_LIBRARY", validation, flush=True)
    return sorted(items.glob("note_*.json"))


class Cloudflare:
    def __init__(self):
        account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
        token = os.environ["CLOUDFLARE_API_TOKEN"]
        if not re.fullmatch("[a-f0-9]{32}", account) or not token:
            raise RuntimeError("Cloudflare credentials missing")
        self.root = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai-search/namespaces/default"
        self.auth = {"Authorization": "Bearer " + token}

    def call(self, method, suffix, *, body=None, files=None):
        r = requests.request(method, self.root + suffix, headers=self.auth, json=body, files=files, timeout=95)
        if method == "GET" and r.status_code == 404:
            return None
        try:
            data = r.json()
        except ValueError:
            data = {}
        if not r.ok or data.get("success") is False:
            raise RuntimeError(f"Cloudflare HTTP {r.status_code}, errors={[x.get('code') for x in data.get('errors',[]) if isinstance(x,dict)][:4]}")
        return data.get("result")

    def provision(self):
        existing = self.call("GET", f"/instances/{INSTANCE}")
        if existing is None:
            existing = self.call("POST", "/instances", body={
                "id": INSTANCE, "embedding_model": MODEL,
                "index_method": {"keyword": True, "vector": True},
                "fusion_method": "rrf",
                "chunk_size": 576,
                "chunk_overlap": 10,
            })
            print("Created isolated full AnKing index", flush=True)
        if not isinstance(existing, dict) or existing.get("id") != INSTANCE or existing.get("embedding_model") != MODEL:
            raise RuntimeError("Existing index identity/config differs; refusing mutation")

    def upload(self, file):
        error = ""
        for attempt in range(6):
            try:
                with file.open("rb") as handle:
                    result = self.call("POST", f"/instances/{INSTANCE}/items",
                                       files={"file": (file.name, io.BytesIO(handle.read()), "application/json")})
                if not isinstance(result, dict) or result.get("key", "").split("/")[-1] != file.name:
                    raise RuntimeError("Unexpected uploaded item identity")
                return file.name, ""
            except (requests.RequestException, RuntimeError) as ex:
                error = str(ex)[:200]
                if any(term in error for term in ("HTTP 400", "HTTP 403", "HTTP 401")):
                    break
                time.sleep(min(2**attempt, 25))
        return file.name, error

    def ingest(self, items):
        self.provision()
        failed = []
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(self.upload, item) for item in items]
            for index, future in enumerate(as_completed(futures), 1):
                name, error = future.result()
                if error:
                    failed.append((name, error))
                if index % 500 == 0 or index == len(items):
                    print(f"FULL_LIBRARY_SUBMITTED {index}/{len(items)} errors={len(failed)}", flush=True)
        if failed:
            print("Failed upload samples", failed[:10], flush=True)
            raise RuntimeError(f"{len(failed)} failed Cloudflare items; do not activate")
        print("FULL_LIBRARY_ALL_ITEMS_SUBMITTED; indexing is asynchronous; read stats before activation", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    archive = Path(args.archive)
    if args.download:
        download(archive)
    docs = prepare(archive, Path(args.output))
    if not args.execute:
        print("Dry run only — no Cloudflare mutations", flush=True)
        return
    Cloudflare().ingest(docs)


if __name__ == "__main__":
    main()
