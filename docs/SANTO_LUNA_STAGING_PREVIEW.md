# Santo GPT-6 Luna Staging Preview — decision and verification

Tracking: Santo GitHub Issue #96, user-approved 14 October 2026.

## Scope

- The `CloudflareLunaModel` uses `env.AI.run('openai/gpt-6-luna', ...)` with Cloudflare Responses API.
- Staging-only opt-in `SANTO_LUNA_PREVIEW=true` selects the model; it is currently disabled (`false`). Production retains incumbent Workers AI regardless of flag.
- Request includes `reasoning.effort=none`, `service_tier=fast`, `store=false`, 1500 max output tokens and strict JSON `{answer,citation_ids}`.
- Adaptive professor-grade Egyptian Arabic and English prompts; no general-purpose tools, invented citations, unsourced images or direct customer DB access.
- Existing RAG evidence, auth, citation validation, quota, replay and buffered SSE are unchanged.

## Live staging acceptance (not yet performed)

1. Verify third-party model billing/availability for Santo's Cloudflare account. The Cloudflare docs list Luna, but service_tier and strict JSON have not been live tested.
2. Run ten Arabic and English clinical questions, short/long, against real indexed licensed sources. Validate citations, mechanisms, accuracy, refusal and unsupported-answer handling.
3. Measure p50/p95 latency, first visible text (buffered until validated), costs, parser error rate, idempotency/atomic quota, prompt injection and unsafe clinical advice.
4. Test Royal Bank staging student session, mobile and quota exhaustion. Disable preview on any regressions; no production rollout.
5. True provider-native streaming remains a separate safety/architecture gate; don't advertise it as implemented by the model preview.

## Status

**Live provider probe attempted 2026-10-14** with synthetic educational input, zero customer content, and the planned Responses/JSON/fast/nonreasoning settings. [GitHub Actions #38591699536](https://github.com/geminiamo0-ship-it/santoreno/actions/runs/38591699536) returned **HTTP 402: Insufficient balance; add money to your gateway or use BYOK**. This is a billing gate, not proof that requested API parameters are accepted. No response generation or billing-based acceptance occurred. The temporary probe workflow was removed after the test. The feature flag remains **OFF**; Staging and Production model selection have not been switched. After gateway balance/BYOK is configured, rerun the same parameter-compatibility check before controlled Staging activation.
