#!/usr/bin/env python3
"""Build compact owner-licensed Cardiology R2 topic index, no AI Search calls."""
import argparse, hashlib, json, re, zipfile
from collections import defaultdict
from pathlib import Path

SHA = "63ab3f221943c0387da65db0c82717721e707b23ac70ed2c1e1effe151d989ba"
STOP = set("a an and are be by can causes clinical common diagnosis disease does explain for from have how in is it its more most of on or please present presentation signs symptoms the their these this to treatment what when which why with about all associated features following finding facts classic medicine topic cards card flashcards show give me plus".split())

def terms(value):
    return set(t for t in re.findall(r"[a-z][a-z0-9]{2,}", str(value).lower()) if t not in STOP)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source = Path(args.source)
    if hashlib.sha256(source.read_bytes()).hexdigest() != SHA:
        raise SystemExit("AnKing Cardiology archive SHA mismatch; no write")
    with zipfile.ZipFile(source) as archive:
        rows = json.loads(archive.read("cardiology_full_metadata.json"))
    if len(rows) != 4151:
        raise SystemExit("Wrong note count")
    topics, facts = defaultdict(list), defaultdict(list)
    all_cards = set()
    for note in rows:
        note_id = note["note_id"]
        for card in note["cards"]:
            cid = card["card_id"]
            if cid in all_cards or card.get("anki_copy_query") != f"cid:{cid}":
                raise SystemExit("Invalid or duplicate original Card ID")
            all_cards.add(cid)
        terms_high = terms(" ".join([note.get("primary_topic") or ""] + (note.get("topics") or [])))
        focuses = " ".join(str(value) for card in note["cards"] for value in (card.get("target_concepts") or []))
        terms_other = terms(f"{note.get('clean_fact_text', '')} {focuses}") - terms_high
        for word in terms_high:
            topics[word].append(note_id)
        for word in terms_other:
            facts[word].append(note_id)
    if len(all_cards) != 5156:
        raise SystemExit("Wrong card count")
    index = {
        "version": 1, "notes": 4151, "cards": 5156,
        "topics": dict(sorted(topics.items())),
        "facts": dict(sorted(facts.items())),
    }
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")
    print("CARDIO_R2_TOPIC_INDEX_VALIDATED", {"bytes": target.stat().st_size, "topic_terms": len(topics), "fact_terms": len(facts)}, flush=True)

if __name__ == "__main__":
    main()
