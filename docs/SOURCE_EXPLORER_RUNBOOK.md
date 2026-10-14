# Santo Source Explorer + Licensed SQLite Import — Staging runbook

**State (14 October 2026):** source-reader code in PR #83, Royal browser in PR #111, local SQLite export built. Not indexed, not uploaded to Santo private R2, not clinically validated. This is NOT a production-release claim.

## Product behavior

Authenticated user clicks a server-verified citation → Santo loads the original canonical article from private R2 and scrolls to the indexed section. A student may also browse all entitled global medical libraries without generating a metered AI answer. Royal Bank uses a responsive right-side source explorer/full-screen mobile article reader. No third-party HTML is rendered.

## R2 and AI Search key contract

- Reader R2: `medical-articles/v1/{libraryId}/{articleId}.json` (one canonical structured text article plus approved public media URLs).
- Search R2: `medical-search/v1/{libraryId}/{articleId}/{sectionId}.md` (one independent indexable section per file). AI Search returned `item.key` must equal the exact canonical search-file path.
- Catalog R2: `medical-library-catalog/v1/catalog.json` + `{libraryId}.json` (bounded title and category listings).
- In the Santo AI Search instance metadata set `library_id` to stable `amboss`, `usmle`, `passmedicine`, `pastest`, `one-examination`. Each instance must index the corresponding `medical-search/v1/{libraryId}/` prefix in the same **private** bucket.
- Citation identity remains the backend verified `instanceId:chunkId`. Source→article reader parses the **trusted snapshot** `itemKey` path and matches the exact `sectionId`. It never trusts a model-generated article URL, nor a caller-supplied R2 object key.
- Existing old-fixture citations return `LIBRARY_ARTICLE_NOT_AVAILABLE`, not an invented article.

## Offline export, review and upload

Run on a trusted operator workstation with the user-provided *licensed* `all_libraries.sqlite`:

```bash
python scripts/export_medical_libraries.py --db all_libraries.sqlite --out ./santo-r2-export
python -m pip install boto3
python scripts/upload_medical_libraries_r2.py --dir ./santo-r2-export  # dry run, no upload
```

Once Cloudflare R2 S3 API credentials have been stored locally as environment variables `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, run:

```bash
python scripts/upload_medical_libraries_r2.py --dir ./santo-r2-export --execute --workers 16 --checkpoint ./santo-r2-uploaded.jsonl
```

The uploader is **hard-locked to `santo-content-staging`**. It never uploads `.sqlite`, `.rar`, `.zip`, `export-report.json` or any arbitrary files. It can resume using a local checkpoint; rerun only against a verified unchanged export. Credentials must NEVER be shared in chat, committed, printed or sent through Royal Bank.

One source SQLite archive was inspected locally: 7,049 articles in five logical libraries. Export produced 7,049 article JSONs, 67,524 section markdown files, and six catalog JSON files (74,579 uploadable objects total); compressed export bundle about 29MB, original uncompressed about 179MB. Some source articles mention images missing from the ZIP, but the owner demonstrated one public media URL works. **Do not assert every image resolves**. All media links must stay on the user-approved public R2 media host; actual licensed text must never be placed there.

## Live staging acceptance still required

1. Verify private R2 object counts/checksums against export, test 10 random long/short articles in each library and confirm no unsafe scripts/iframes or broken internal links are rendered.
2. Configure five real R2-backed AI Search instances with metadata `library_id` and test index status until ready. Search each library and All Libraries, assert returned `item.key` matches the key contract.
3. Signed student session: check `/v1/libraries`, `/v1/libraries/passmedicine/articles`, and `/v1/libraries/passmedicine/articles/{articleId}`; verify no charge and no cross-user history leak.
4. Ask a factual question whose medical support is in the licensed corpus; verify model's citation ID belongs to retrieved evidence, then `POST /v1/sources/article` with verified `messageId` and `sourceId` opens correct source/section. Test wrong user/expired snapshot, malformed R2 and missing article, old fixture source, mobile view.
5. Measure indexing cost and read traffic, clinical source quality and citation support. Only then consider enabling this outside Santo Staging.

**Privacy/security:** Article reader endpoints require a valid Santo student session; global libraries remain configured per Phase 6 (same content offered to all active tenants). Browser cannot fetch private R2 objects directly. Responses are structured JSON and rendered as text. Library browse does not use the model, does not charge units, and cannot use customer DB queries. Third-party embedded HTML is stripped at ingest rather than passed through the frontend.
