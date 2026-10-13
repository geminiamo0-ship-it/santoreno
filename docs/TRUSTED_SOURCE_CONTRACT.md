# Phase 8 — Trusted source and medical image contract

> Status: first contract slice in PR #49; **not** an implemented source resolver
> or public API. The full Issue #43 acceptance and live R2 staging gate remain open.

## Authority and lookup

- A source belongs to a verified AI Search result: `sourceId = instanceId:chunkId`.
- `libraryId` is a validated global retrieval filter, **never** tenant authorization.
- `instanceId`, `itemKey`, title, page, and section must be taken from server-verified
  retrieval/catalog metadata, not model output or user-provided JSON.
- A future source-detail request includes `messageId` and `sourceId` only.
  The API must authenticate a Santo end-user session, look up the cited message
  within that session's tenant/user scope, verify that it cited this exact
  `sourceId`, and then resolve canonical metadata. The schemas alone do not
  perform authorization; a bare matching `sourceId` is never sufficient.
- If the source is missing, ambiguous, forged, outside the selected library,
  or absent from the authenticated message's verified citation set, fail closed.

## Shared Zod contracts

All contracts live in `@santo/contracts/source`:

- `TrustedSourceIdSchema`: verified AI Search instance/chunk identity
- `TrustedSourceMetadataSchema`: canonical library, instance, item, page and section
- `TrustedSourceDetailRequestSchema`: message-scoped lookup; no tenant override
- `TrustedSourceImageSchema`: browser-safe image metadata; no URL or object key
- `TrustedSourceDetailResponseSchema`: source plus at most 50 mapped images
- `TrustedSourceMediaManifestEntrySchema`: internal mapping to a safe R2 object key

The schemas reject arbitrary extra fields and explicitly reject direct URLs in
client-facing image metadata. Image dimensions and content types are bounded.

## R2 access rules for the future resolver

- The R2 `objectKey` is only ever obtained from a trusted manifest record.
  Do not build it by concatenating `itemKey`, `sourceId`, a URL, or user input.
- Store only under the canonical `source-media/` namespace. No path traversal,
  percent-encoded traversal, absolute paths or external URLs.
- Check exact source/library/instance/item/asset identity when joining manifest
  entries to verified citations. Duplicate or mismatched mappings fail closed.
- End-user APIs must never expose internal R2 keys or storage credentials.
  Any media delivery endpoint must authenticate and revalidate access before
  streaming an allowlisted image MIME type with safe response headers.
- Missing media is an explicit, non-sensitive not-found result; never substitute
  an arbitrary image URL.
- The later widget must consume this contract without direct R2 access.

## Testing and acceptance still required

The contract regressions cover forged IDs, mismatched search instances,
client-side URL injection, path traversal, invalid image MIME types, and unwanted
tenant selector fields. This is **not** proof of source authorization or R2 access.

Issue #43 additionally requires a resolver, authenticated endpoints, actual R2
fixtures, tenant/session isolation and retry tests, live staging acceptance on
the same final commit as `Verify`, then post-merge `Verify`.
