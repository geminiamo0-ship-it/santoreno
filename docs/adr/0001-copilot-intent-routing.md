# ADR 0001 — Medical Education Copilot: conservative intent routing before grounded AI

- **Status:** Proposed (product concept endorsed; architecture not deployed)
- **Date:** 2026-10-14
- **Owners:** Santo engineering

## Context

Santo is a multi-tenant medical education assistant embedded in external learning platforms. The verified Phase 7 grounded AI core intentionally always retrieves trusted evidence and refuses an unsourced answer. This is appropriate for medical knowledge, but a greeting such as 'hi' gets INSUFFICIENT_EVIDENCE and consumes an unnecessary AI Search attempt. Students also want natural, limited medical-study conversation, study navigation and question-bank review. The active exam and source/usage security guarantees cannot be weakened.

## Decision

Introduce a **server-side conservative intent routing boundary** before the expensive RAG path. Authenticate tenant and user, evaluate rate limits and effective exam disclosure, then select one of deterministic greeting/acknowledgment, off-topic redirect, non-factual clarification/study navigation, urgent generic safety response, exam-restricted handling, or the current evidence-grounded medical answer.

Grounded requests must retain the existing AI Search -> bounded evidence -> model -> citation validation -> authorized source resolution -> idempotent TenantMeterDO finalization contract. Ambiguous/mixed factual medical requests are grounded, not silently downgraded. Non-factual generated coaching, if permitted, has an explicit model-cost policy and does not silently bypass quota. Deterministic fixed responses may use zero metered units while always honoring tenant authentication, suspension and rate limits. Emergency safety routing may advise seeking immediate local emergency help without awaiting retrieval, but may not assert unsupported diagnosis.

Version a **provider-neutral Core System Prompt** server-side, and inject only authenticated/minimized platform, student, library and exam context. No tenant-specific conditionals, browser-granted exam permission, unsigned student progress, or special client database access. Enforce permissions and citation validation in code regardless of prompt. Do not replace the current grounded prompt until the new composition and evaluation gates pass.

Documented behaviors: docs/prompts/SANTO_MEDICAL_EDUCATION_COPILOT_V1.md and docs/COPILOT_ROUTING_V1.md.

## Alternatives considered

### A. Always run RAG, even for greetings

Preserves strong evidence-only behavior and the simplest service, but gives poor conversational UX, unnecessary retrieval work and errors for social/organizational turns.

### B. Always let one LLM choose and answer without RAG

Natural and flexible, but risks hallucinated medical facts, forged sources, role injection, cost bypass, missing exam restrictions, and lack of verifiable authority. Rejected.

### C. Client-side router/widget rules

May improve UI responsiveness, but browser-controlled routing is manipulable and cannot safely authorize exams, quotas, source access or tenant context. Rejected as the source of truth; the widget may only display server-approved responses.

### D. Per-customer system prompts or forks

Could tailor individual customer marketing copy, but creates inconsistent safety rules and operational drift. Rejected; use generic schema-validated configuration under immutable Santo policy.

## Consequences

### Positive

- Better conversational fit for medical students while keeping clinical answers grounded.
- Less expensive deterministic handling for trivial messages without hidden model calls.
- Clear future integration points for verified qbank, library and study contexts.
- Provider-independent policy and auditable prompt versioning.

### Negative / trade-offs

- New route decisions and fallbacks need thorough bilingual and adversarial evaluation.
- Client/user attempts to smuggle protected active exam content remain a tricky host/backend authorization boundary.
- Quota and persisted conversation handling for free responses must preserve ordered replay/idempotency; no second quota implementation.
- Localization and emergency safety templates require careful QA.

### Follow-up

- Separate implementation issue/PRs and feature flag (disabled initially), without touching current pilot state until verified.
- Confirm effective server-side exam context with a generic host contract before qbank-specific behavior.
- Pilot on indexed, licensed medical data and verify real citation quality; do not conflate design with Phase 10 live acceptance.

## Verification

Before enabling: exact-head CI with policy, provider and schema tests; no unauthenticated route, no cross-tenant progress leak, no exam answer exposure, malicious prompt injection, invalid source IDs rejected, no false free generation, no double-charge after retry; genuine WorkOS/session/browser Staging validation with real licensed references and bounded context. Preserve current buffered verified SSE behavior. Post-merge Verify, staging acceptance and customer approval needed before live claim.

## References

- GitHub Issue #73 — copilot v1 system prompt and routing specification.
- GitHub Issue #58 — open Phase 10 pilot acceptance.
- SANTO_MASTER_PLAN.md §§26–34 (global knowledge, retrieval, AI lifecycle).
- docs/ENGINEERING_GUARDRAILS.md §§5, 10–11, 15–17, 21.
- docs/AI_STREAMING_CONTRACT.md; docs/TRUSTED_SOURCE_CONTRACT.md.
