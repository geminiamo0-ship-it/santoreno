# Phase 7 — Validated streaming contract

## Request and delivery

The authenticated POST /v1/ai/query accepts the existing validated JSON body. To request Server-Sent Events, send Accept: text/event-stream. The default response remains the original JSON GroundedAiQueryResponse.

The SSE response uses Content-Type: text/event-stream, Cache-Control: no-store, and these strictly validated events:

- delta: requestId, messageId, monotonically increasing index starting at zero, and text (up to 180 Unicode codepoints per frame).
- complete: the original GroundedAiQueryResponse, including validated citations and finalized usage.

The client must not treat the stream as committed until a complete event arrives. Do not parse model-generated HTML or source URLs from delta text.

## Safety and quota semantics

This implementation is **buffered validated delivery**, not provider-token generation streaming. The server completes generation, verifies every citation against retrieved evidence, and finalizes the server-side quota **before it sends any delta**. This trades time-to-first-token for the invariant that no unverified medical answer/citation reaches the client.

Invalid session/quota/evidence/citations, upstream failures, model timeouts, and aborted requests **before finalization** return a structured JSON error, never an SSE answer. A non-chargeable failure releases a newly reserved quota unit. An unknown library fails closed and is not broadened. A request aborted during an expensive stage uses REQUEST_CANCELLED (HTTP 499); retrieval and model deadlines use SEARCH_TIMEOUT and MODEL_TIMEOUT (HTTP 504). Deadlines bound response lifetime but underlying Cloudflare provider cancellation remains best effort; late results are ignored.

Once the answer has been successfully validated and quota finalized, a downstream disconnect **does not refund** the charge. Reusing a verified session/client idempotency key and unchanged query/library scope does not double-charge. A failed quota finalization is reported as QUOTA_FINALIZE_FAILED and must be retried with the same idempotency key.

No new customer-specific paths, quota implementation, or additional tenant/library authorizations are introduced.

## Remaining Phase 7 gate

This streaming contract requires passing full GitHub Actions Verify and real staging acceptance before Issue #36 may be closed. Provider-native progressive generation is not claimed by this buffered contract and would need its own adapter/runtime acceptance if required.
