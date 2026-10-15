# Medical Retrieval v2 — Cloudflare quality-first rollout plan

**Approved:** 2026-10-15 · **Issue:** #123 · **Scope:** Santo Staging only until measured acceptance

## Product contract

Santo is a medical education copilot. The answer author is **Luna only**, for every user-facing turn. In contrast, retrieval and source/image selection may use Cloudflare AI Search, Workers and optional specialized Cloudflare ranking components without generating another student-visible reply. Preserve the existing ConversationDO context/ordering, source snapshots, auth, quota, one-pass generation and original R2 articles.

### Never change

- Cloudflare ecosystem only: AI Search + Workers + R2; no Elasticsearch, Cohere or an independently indexed image database.
- Original article HTML is the source of truth. Images, alt/caption, tables and diagrams remain associated with the actual section. A cited article opens in the existing authenticated source explorer.
- A `related` article card is **not** an inline citation or a license to insert its images. Missing evidence must be stated honestly, not silently upgraded to verified provenance.
- Only five authorized library indexes or a user's explicit authorized library filter. Never broaden to foreign namespaces.
- Do **not** delete/recreate/resync search indexes or modify licensed R2 content for this rollout. AMBOSS ingestion recovery tracked independently in #109.

## Existing baseline — current staging source code

`workers/api/src/ai/retrieval.ts`: five parallel per-library Hybrid searches, `max_num_results: 3` and `match_threshold: 0.4`, filtered by a conservative token overlap gate, then `slice(0, 1)` per library and `MAX_RESULTS=5`. It can miss a relevant article lower in the search ranking and can reject relevant synonyms/acronyms. `workers/api/src/ai/service.ts` then passes up to five evidence passages to Luna. It is **not** proof that a topic is absent from the library when nothing passes the gate.

## Ordered work

### 0. Ground-truth dataset & baseline
- Produce a **human-reviewed** 100–200 question evaluation set: English + Arabic, disease shorthand, mechanism/symptom/diagnosis/management, multilingual synonyms, ambiguous follow-up vs explicit topic switch. No copyrighted article passages or student data committed to public GitHub.
- Gold labeling includes actual R2 itemKey, section and representative figure identity; the best result is a human-judged best relevant section, not any high-scoring match.
- Baseline metrics: article Recall@10, section precision, MRR/NDCG, selected-source precision, cited-claim precision, suitable-image@3, duplicate-image rate, unrelated-figure rate, source-free rate, p50/p95 and search calls. Record current configuration and run before changes.

### 1. Candidate breadth (first code PR)
- Raise per-index candidate budget *only after verifying currently supported Cloudflare AI Search options/limits*.
- Never force one hit per library. Keep a bounded global candidate pool, deduplicated by `sourceId`; diversity should prevent one library from crowding out all others without forcing irrelevant hits.
- Preserve original trusted identifiers as returned by search: `{sourceId,libraryId,instanceId,itemKey,title,section,page,text,score}`. Reject unknown index/itemKey/ambiguous IDs before source snapshot.
- Prefer global ranking on calibrated evidence and query/section match, not naive cross-index raw-score sorting. Keep grounding payload bounded, with at most 5 visible citations until contracts change.

### 2. Adaptive query strategy & reranking
- First query current topic and clinical intent; do not mix an unrelated previous disease into a new-topic search.
- Expand with synonyms/medical shorthand and cross-lingual forms **only when initial evidence quality is insufficient**; generate any query rewrites through supported Cloudflare features or deterministic expansion. Do not add a second **answer** model.
- Evaluate the native AI Search reranker first. If a supported Cloudflare Workers AI rerank model improves gold-set metrics, permit a second ranking pass on already retrieved excerpts. The exact model/features must be verified before coding.
- Cap **billable search operations** at 15 per question in Staging as a safety ceiling, not a fixed search count. Apply deadline, cancellation, explicit filter and fail-closed infrastructure rules. Log only anonymized counts/latency, not licensed text or patient prompts.

### 3. R2 article-guided figure selection
- After selecting true cited articles, resolve their original HTML using the **existing authorized source snapshot**; do not fetch unrelated or unclaimed articles for display.
- Extract image `src` / alt / figcaption / closest headings/paragraph text and preserve article/section ownership. Score each image **for each answer section**; e.g. aortic stenosis *mechanism* prefers obstruction/LV pressure overload drawings above remote heart-failure complications.
- Deduplicate image identity within answer and ideally within the active conversation; use the same safe authorized asset proxy and existing full-source navigation.
- No standalone image index, multimodal embeddings or invented image URLs. When no relevant illustration is found, omit it.

### 4. Answer/provenance and UI integration
- Luna answers once and may use only the selected retrieved `[[N]]` citation aliases. Verified citations are claim-specific; background clinical teaching without evidence is not mislabeled as library-grounded.
- Never auto-create five `related` cards because there are five indexes. Review source-snapshot and figure selection as one evidence pathway.
- UI retains article explorer, exact original citations, image accessibility, tables and RTL.

### 5. Staging acceptance & release gates
- Stage behind a flag (control vs treatment), no automatic production rollout.
- Synthetic Vitest regressions including **FMF after aortic stenosis**, source-free false negatives, section-appropriate figures, repeated images, same-key retries, explicit library filtering and 0 images on nonclinical greetings.
- Exact-head Verify, read-only licensed corpus benchmark, human review of sampled cards and medical figures, separate authenticated real browser acceptance after approval (the benchmark need not invoke Luna repeatedly), and observability of calls/tokens/p95.
- Targets for human review: article Recall@10 >=95%, sampled claim/source precision >=98%, figure suitability >=90% when a suitable source image exists. These are **targets**, not current results, and need error bars/representative samples.
- Rollout only if objective quality improves and no quota, security, source authenticity or ConversationDO regression. Otherwise retain existing release and report blockers.

## Deployment/implementation order

1. Baseline harness and gold labels (this first documentation/decision PR contains **no runtime change**).
2. Controlled retrieval candidate/rank implementation with integration tests.
3. HTML image selection improvements in Santo API and Royal Bank UI.
4. Verified staging deployment and before/after report.
5. Separately authorized production rollout.

**Scope control:** Do not promote a planning PR as finished implementation or call the AI Search performance targets achieved without measurements.
