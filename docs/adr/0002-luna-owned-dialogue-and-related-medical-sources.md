# ADR 0002 — Luna-owned dialogue and honest related library sources

- **Status:** Accepted for Staging candidate; real student acceptance pending
- **Date:** 2026-10-15
- **Scope:** Santo Staging plain-Markdown Luna; production legacy JSON unchanged
- **Supersedes:** ADR 0001 deterministic quick-reply routing for the Santo pilot

## Context

Santo is differentiated by its trusted AI Search library excerpts and authenticated R2 article, image and HTML exploration. Students observed provider-completed medical drafts rejected because Luna omitted or malformed `[[N]]` markers, even when genuine retrieved evidence was available. A zero-model canned greeting/clarification route is explicitly not desired: every end-user message should be answered by Luna.

## Decision

- Route all messages to the same one-pass Luna request (including greetings and clarifications), still subject to tenant/user authorization, server quotas, and ConversationDO persistence.
- Treat Luna's valid `[[N]]` references as **inline model-selected citations** only when the numbers map to actually retrieved source IDs. Neither Luna nor the browser creates source identity.
- If a provider-completed medical answer has **no valid inline marker**, the server may attach only the actual retrieved authorized excerpts as a **separately labeled related-library-source list** (`citationMode: "related"`). This is a browsing affordance, NOT claim-by-claim factual verification. Never emit fabricated source IDs or turn unknown markers into different numbered inline citations.
- Do not attach unrelated RAG hits to obvious Luna social/clarification replies; these remain uncited and model-generated with normal quota accounting.
- Keep `response.completed`, no incomplete stream acceptance, authenticated source metadata, source snapshot authorization, R2 source resolution, at-most-one provider generation attempt, and quota/idempotency safeguards.

## Alternatives rejected

Strictly reject every medically useful completed response with a missing model marker: poor availability and repeats paid inferences. Silently claim unrelated retrieved passages validate individual assertions: provenance misrepresentation. Remove all references and answer from generic knowledge: breaks Santo's distinguishing medical library experience. Static quick replies: violates explicit product intent.

## Consequences / verification

Browsers must label `citationMode: "related"` as **Related Library Sources**, not Verified Inline Citations, while keeping article/image browsing. Clinical factual correctness is not proven by a source URL existing. Unit tests must cover real cited markers, absent/unknown markers, one provider call, no random-source clarifications, persistence and source snapshots. Real authenticated acceptance on staging still required; no claim of production rollout until validated.
