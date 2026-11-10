#!/usr/bin/env python3
"""Build an isolated context-rich AMBOSS index from verified original article JSONs.

Reads only original source objects from santo-content-staging.
Writes only to santo-amboss-hierarchical-v2. Never edits production or old indexes.
The old article exporter flattened HTML heading levels, so do not invent a hierarchy:
use deterministic overlapping adjacent-section context, full text preservation,
original section IDs, titles, citations, and images references.
"""
import concurrent.futures as futures
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
SOURCE = "santo-content-staging"
DEST = "santo-amboss-hierarchical-v2"
CATALOG = "medical-library-catalog/v1/amboss.json"
SOURCE_PREFIX = "medical-articles/v1/amboss/"
DEST_PREFIX = "articles/"
LOCK = threading.Lock()
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/r2/buckets"
MAX_PART = 8000
MAX_CONTEXT = 15500


def api(method, bucket, key, payload=None, content_type=None):
    target = f"{BASE}/{bucket}/objects/{urllib.parse.quote(key, safe='/')}"
    data = payload.encode("utf-8") if isinstance(payload, str) else payload
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if content_type:
        headers["Content-Type"] = content_type
    for attempt in range(7):
        req = urllib.request.Request(target, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=75) as response:
                content = response.read()
                return content
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 6:
                raise RuntimeError(f"{method} failed for {bucket}/{key}: HTTP {exc.code}") from exc
            time.sleep(min(3 * (attempt + 1), 20))
    raise RuntimeError("API retries exhausted")


def get_json(bucket, key):
    return json.loads(api("GET", bucket, key).decode("utf-8"))


def split_section(section):
    """Break only oversized sections into consecutive, lossless text pieces."""
    text = section.get("text") or ""
    if not isinstance(text, str):
        raise ValueError("Invalid article section text")
    if not text:
        return [""]
    out = []
    for i in range(0, len(text), MAX_PART):
        out.append(text[i:i + MAX_PART])
    assert "".join(out) == text
    return out


def units_for(article):
    units = []
    expected_chars = 0
    for index, section in enumerate(article["sections"]):
        original_text = section.get("text") or ""
        expected_chars += len(original_text)
        parts = split_section(section)
        for n, part in enumerate(parts):
            units.append({
                "index": index,
                "id": section["id"],
                "heading": section["heading"],
                "part": n + 1,
                "parts": len(parts),
                "text": part,
                "images": section.get("images") or [],
            })
    assert sum(len(x["text"]) for x in units) == expected_chars
    return units


def render(article, focus, extras):
    ordered = sorted(extras, key=lambda x: x["_unit"])
    a, b = min(x["_unit"] for x in focus), max(x["_unit"] for x in focus)
    body = [
        f"# {article['title']}",
        "",
        "Library: AMBOSS",
        f"Article ID: {article['articleId']}",
        f"Category: {article.get('category') or ''}",
        f"Original article: {SOURCE_PREFIX}{article['articleId']}.json",
        f"Focus units (inclusive): {a + 1}-{b + 1}",
        "Context includes nearby medical sections; headings retain their original order.",
        "Headings: " + " | ".join(dict.fromkeys(x["heading"] for x in ordered)),
        "",
    ]
    for u in ordered:
        suffix = f" (part {u['part']} of {u['parts']})" if u["parts"] > 1 else ""
        body.extend([f"## {u['heading']}{suffix}", f"Original section: {u['id']}", u["text"], ""])
        if u["images"]:
            body.append("Associated image references:")
            for img in u["images"]:
                body.append(f"- {img.get('alt', '')}: {img.get('src', '')}")
            body.append("")
    return "\n".join(body)


def make_documents(article):
    units = units_for(article)
    docs = []
    # Every unit has a mandatory primary focus; adjacent context cannot hide/lose content.
    for start in range(0, len(units), 3):
        focus = [{**u, "_unit": i} for i, u in enumerate(units[start:start + 3], start)]
        chosen = list(focus)
        length = sum(len(x["text"]) for x in chosen)
        neighbors = [i for i in [start - 1, start + 3, start + 4, start + 5, start + 6] if 0 <= i < len(units)]
        for i in neighbors:
            unit = {**units[i], "_unit": i}
            if length + len(unit["text"]) + len(unit["heading"]) + 600 <= MAX_CONTEXT:
                chosen.append(unit)
                length += len(unit["text"]) + len(unit["heading"]) + 600
        doc = render(article, focus, chosen)
        key = f"{DEST_PREFIX}{article['articleId']}/context-{start + 1:04d}.md"
        docs.append((key, doc))
    assert sum(len(u["text"]) for u in units) == sum(len(s.get("text") or "") for s in article["sections"])
    return docs, units


def process_article(item):
    ident = item["id"]
    if not ident or "/" in ident or ".." in ident:
        raise ValueError("Unsafe source article ID")
    article = get_json(SOURCE, f"{SOURCE_PREFIX}{ident}.json")
    if article.get("articleId") != ident or article.get("libraryId") != "amboss":
        raise ValueError(f"Source article identity mismatch: {ident}")
    if article.get("title") != item["title"] or not article.get("sections"):
        raise ValueError(f"Source article failed catalog/schema validation: {ident}")
    docs, units = make_documents(article)
    for key, content in docs:
        api("PUT", DEST, key, content, "text/markdown; charset=utf-8")
    return {"article_id": ident, "sections": len(article["sections"]),
            "units": len(units), "documents": len(docs),
            "source_sha256": hashlib.sha256(json.dumps(article, sort_keys=True).encode()).hexdigest()}


def main():
    if not ACCOUNT or not TOKEN:
        raise ValueError("Missing required Cloudflare secrets")
    catalog = get_json(SOURCE, CATALOG)
    articles = catalog.get("articles") or []
    if len(articles) != 1481 or len({x["id"] for x in articles}) != len(articles):
        raise ValueError(f"Catalog integrity mismatch: {len(articles)} articles")
    print("Verified AMBOSS source catalog:", len(articles), "articles", flush=True)
    # Preflight: destination must be the isolated v2 bucket, never the legacy search bucket.
    if DEST in (SOURCE, "santo-amboss-search-staging", "santo-content", "santo-content-staging"):
        raise ValueError("Destination is not isolated")
    done, sections, docs = 0, 0, 0
    failures = []
    with futures.ThreadPoolExecutor(max_workers=10) as pool:
        tasks = {pool.submit(process_article, a): a["id"] for a in articles}
        for task in futures.as_completed(tasks):
            try:
                result = task.result()
                done += 1
                sections += result["sections"]
                docs += result["documents"]
                if done % 50 == 0:
                    print(f"Progress {done}/1481 articles; {docs} context files", flush=True)
            except Exception as exc:
                failures.append({"article": tasks[task], "error": str(exc)})
                print(f"FAILED article {tasks[task]}: {exc}", flush=True)
    report = {"schema": "AMBOSS_CONTEXT_V2", "articles_expected": 1481,
              "articles_succeeded": done, "sections": sections,
              "documents_uploaded": docs, "failures": failures[:50],
              "source_bucket": SOURCE, "destination_bucket": DEST}
    with open("amboss-hierarchical-v2-report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report), flush=True)
    if failures or done != len(articles):
        sys.exit("Incomplete article processing; refusing to declare indexing ready.")
    api("PUT", DEST, "_audit/build-report.json", json.dumps(report), "application/json")
    print("CORPUS_GENERATED_SUCCESSFULLY; AI Search sync is a separate asynchronous step.", flush=True)


if __name__ == "__main__":
    main()
