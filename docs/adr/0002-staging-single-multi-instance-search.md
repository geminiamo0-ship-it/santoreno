# ADR 0002 — Single namespace search for Staging medical retrieval

- **Status:** Deployed to Staging after successful CI; clinical and billing acceptance pending
- **Date:** 2026-10-17
- **Owners:** Santo engineering

## Context

Santo's Staging Medical Retrieval V2 fans out one AI Search request to each of five allowlisted medical indexes, then optionally repeats this pass if fewer than three source articles survive. This performs 5–10 namespace-search requests for most sourced medical questions. The business owner approved trialing one request while keeping the existing user-visible Luna answer, source validation, image, quota and safety behavior.

Cloudflare documents namespace-level multi-instance search as one API invocation: `ai_search_options.instance_ids` can include multiple instance IDs, merged chunks carry their genuine `instance_id`, and `errors` may report partial per-instance failures. **One invocation is not confirmed to equal one billable hybrid query across all instances.**

## Decision

Staging only, opt into `SANTO_AI_SEARCH_SINGLE_REQUEST_V1=true` together with the existing Medical Retrieval V2 feature switch:

1. Validate the existing catalog and immutable five approved medical instance IDs; explicit single-library filters must never expand to all indexes.
2. Preserve the existing Qwen short intent/query preparation; send that prepared query once to the Cloudflare **namespace** Search binding with `instance_ids` holding all selected authorized IDs.
3. Keep Hybrid + RRF, threshold 0.4, native reranker `@cf/baai/bge-reranker-base`, 25 merged candidate results and disabled Cloudflare query rewrite.
4. Reject malformed search payloads or any returned per-instance errors; discard unrecognized/invalid/low-score result chunks. Never silently retry, broaden a filter or fabricate a citation.
5. Honor Cloudflare's global ranked order, dedupe chunks belonging to the same original article, and pass up to five genuine `instance_id:chunk_id` sources to the unchanged Luna prompt/citation validation.
6. Disable the opt-in flag to revert to existing 5/10-search Medical Retrieval V2; do not modify production settings or data.

## Alternatives considered

- **Current per-index V2 with a conditional second pass:** better opportunities for underrepresented libraries, but 5–10 API calls and variable latency.
- **No reranker:** cheaper/simpler retrieval, but reduces relevance safeguards and was _not_ part of the final approved configuration.
- **Pass 25 chunks to Luna:** alters prompt size, citation limits and user-visible behavior; deferred separately.

## Consequences

- **Positive:** single API request per medical retrieval; simpler latency profile; same model, source provenance and tenant/quota boundaries.
- **Trade-offs:** merged top results may omit relevant smaller libraries. A partial per-index error rejects the whole search. Cloudflare billable operations per multi-instance request are not established and must be measured/confirmed.
- **Follow-up:** compare unchanged control and opt-in Staging on bilingual/short-follow-up topic-switch clinical questions, source precision and image-topic match, p50/p95 latency, and billed search units. No Production promotion until medical acceptance.

## Verification

Unit tests assert exactly one call with five allowlisted instances, filtered index, Qwen prepared query reuse, candidate and article limit, original source ID mapping, low-score/untrusted metadata rejection, failure handling and no repeat. PR #146 passed exact-head Verify `39046489023`, post-merge Verify, and Cloudflare Staging deploy/health/unauthenticated deny smoke `39046563721` on commit `3155f2836c96fed5e6fcfc7441df13d5c9fac4ae`. Authenticated medical-quality and multi-instance billable-unit acceptance remain separate.

## References

- Issues #145 and #123
- https://developers.cloudflare.com/workers/runtime-apis/bindings/ai-search/
- Santo `docs/ENGINEERING_GUARDRAILS.md`
