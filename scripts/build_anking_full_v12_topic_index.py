#!/usr/bin/env python3
"""Build an Anki-native CID lookup from original licensed private v12 R2 shards.
No AI, Cloudflare AI Search, embeddings, public source media or model calls.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re

TOKENS = re.compile(r"[a-z][a-z0-9]{2,}")
SKIP = set("the and for from with what when where which this that these those treatment management diagnosis pathology explained explain features medicine flashcards card cards give show find about into have has are does do of on in to at is it as by a an patient clinical common your all".split())
EXPECTED_NOTES = 30477
EXPECTED_CARDS = 36896


def tokenize(text):
    return {word for word in TOKENS.findall(str(text).lower()) if word not in SKIP}


def build(directory: Path):
    topics = defaultdict(set)
    facts = defaultdict(set)
    card_ids = {}
    seen = set()
    for shard in range(128):
        path = directory / f"shard_{shard:03d}.json"
        if not path.is_file():
            raise ValueError(f"Missing private v12 shard {shard}")
        payload = json.loads(path.read_text("utf-8"))
        for key, note in payload.items():
            nid = note.get("note_id")
            if not re.fullmatch(r"note_\d{10,16}", key) or key != f"note_{nid}" or nid % 128 != shard:
                raise ValueError("Inconsistent original note ID or shard position")
            if note.get("rights_status") != "licensed_for_santo":
                raise ValueError("Rights-locked item unexpectedly included in v12 shard")
            if nid in card_ids:
                raise ValueError("Duplicate original note ID")
            cards = note.get("cards", [])
            ids = []
            for card in cards:
                cid = card.get("card_id")
                if not isinstance(cid, int) or cid <= 0 or cid in seen or card.get("anki_query") != f"cid:{cid}":
                    raise ValueError("Non-original, duplicate, or mismatched CID")
                seen.add(cid)
                ids.append(cid)
            card_ids[str(nid)] = ids
            topic = str(note.get("topic") or "")
            primary = str(note.get("primary_system") or "")
            fact = str(note.get("medical_fact") or "")
            pearl = str(note.get("clinical_pearl") or "")
            previews = " ".join(
                str(card.get("preview") or "") + " " + " ".join(map(str, card.get("target_concepts") or []))
                for card in cards
            )
            for term in tokenize(topic + " " + primary):
                topics[term].add(nid)
            for term in tokenize(fact + " " + pearl + " " + previews):
                facts[term].add(nid)
    if len(card_ids) != EXPECTED_NOTES or len(seen) != EXPECTED_CARDS:
        raise ValueError(f"Unexpected full v12 note/card counts {len(card_ids)}, {len(seen)}")
    result = {
        "version": 2,
        "notes": len(card_ids),
        "cards": len(seen),
        "topics": {t: sorted(ids) for t, ids in sorted(topics.items())},
        "facts": {t: sorted(ids) for t, ids in sorted(facts.items())},
        "card_ids": card_ids,
    }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shards", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    index = build(args.shards)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print("FULL_V12_ANKI_TOPIC_INDEX_BUILT",
          {"notes": index["notes"], "cards": index["cards"], "bytes": args.out.stat().st_size,
           "topic_terms": len(index["topics"]), "fact_terms": len(index["facts"])}, flush=True)


if __name__ == "__main__":
    main()
