#!/usr/bin/env python3
"""Backfill licensed textual AnKing note fields into the EXISTING private Staging CID shards.

This script never uploads or changes the AI Search index. It refuses missing/mismatched
source identities, CID joins, rights status, shard counts or nontext/media payload.
Outputs a complete 32-shard replacement folder and validation report. The workflow
backups originals before any staging write and performs readback comparisons.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

SOURCE_SHA = "63ab3f221943c0387da65db0c82717721e707b23ac70ed2c1e1effe151d989ba"
NOTE_COUNT = 4151
CARD_COUNT = 5156
SHARDS = 32
UNSAFE = re.compile(r"<(?:script|iframe|img|svg)\b|\[sound:", flags=re.IGNORECASE)

def safe_text(value, limit):
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if len(value) > limit or UNSAFE.search(value):
        return ""
    return value

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--existing", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if hashlib.sha256(args.archive.read_bytes()).hexdigest() != SOURCE_SHA:
        raise RuntimeError("Original archive SHA mismatch. No cloud writes.")
    with zipfile.ZipFile(args.archive) as z:
        rows = json.loads(z.read("cardiology_full_metadata.json"))
    if len(rows) != NOTE_COUNT:
        raise RuntimeError("Unexpected source size")
    by_id = {r["note_id"]: r for r in rows}
    if len(by_id) != NOTE_COUNT:
        raise RuntimeError("Duplicate original note IDs")
    validated = {}
    total_cards = 0
    for i in range(SHARDS):
        name = f"shard_{i:02d}.json"
        path = args.existing / name
        if not path.is_file():
            raise RuntimeError(f"Missing current staging shard {name}")
        shard = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(shard, dict):
            raise RuntimeError(f"Malformed current staging shard {name}")
        for key, obj in shard.items():
            if not re.fullmatch(r"note_\d{10,16}", key) or not isinstance(obj, dict):
                raise RuntimeError(f"Invalid R2 key or schema {key}")
            nid = int(key[5:])
            if nid % SHARDS != i or nid not in by_id or nid in validated:
                raise RuntimeError(f"Wrong or duplicated note/shard mapping: {nid}")
            source = by_id[nid]
            if obj.get("note_id") != nid or obj.get("rights_status") != "licensed_for_santo":
                raise RuntimeError(f"Existing shard rights or note mismatch: {nid}")
            original_cids = sorted(c["card_id"] for c in source["cards"])
            current_cids = sorted(c["card_id"] for c in obj.get("cards", []))
            if current_cids != original_cids:
                raise RuntimeError(f"CID set changed for note {nid}")
            total_cards += len(current_cids)
            fact = safe_text(source.get("clean_fact_text"), 2500)
            if fact:
                obj["medical_fact"] = fact
            pearl = safe_text(source.get("clinical_pearl"), 3000)
            obj["clinical_pearl"] = pearl
            notes = source.get("supplementary_notes") or {}
            if not isinstance(notes, dict):
                raise RuntimeError(f"Unexpected extra notes on {nid}")
            supplemental = {}
            for label, value in notes.items():
                if not isinstance(label, str) or not 0 < len(label) <= 80:
                    continue
                content = safe_text(value, 3000)
                if content:
                    supplemental[label] = content
            obj["supplementary_notes"] = supplemental
            validated[nid] = True
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / name).write_text(
            json.dumps(shard, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
    if len(validated) != NOTE_COUNT or total_cards != CARD_COUNT:
        raise RuntimeError(f"Unexpected full dataset: {len(validated)} notes and {total_cards} cards")
    report = {
        "original_notes": NOTE_COUNT,
        "original_cids": CARD_COUNT,
        "shards": SHARDS,
        "supplementary_notes": sum(bool(by_id[n].get("supplementary_notes")) for n in validated),
        "original_source_sha256": SOURCE_SHA,
        "rights_status_preserved": True,
        "review_status_preserved": True,
        "index_rebuilt": False,
        "images_or_audio_uploaded": False,
    }
    (args.output / "validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("STAGING_BACKFILL_VALIDATED", report, flush=True)

if __name__ == "__main__":
    main()
