# Phase 8 — Trusted source and R2 media contract

> Status: Phase 8 Issue #43. PR #49 delivered shared contracts. PR #50 adds the
> authenticated resolver and its live acceptance gate. Phase 8 is not complete
> until the staging gate and post-merge verification are both green.

## Provenance and identity

- Source metadata is copied **only** from an actually retrieved AI Search
  evidence record after the model's citation IDs are server-validated.
- A trusted source is identified by `sourceId = instanceId:chunkId` and retains
  `libraryId`, `instanceId`, `itemKey`, title, page and section.
- A global `libraryId` remains a retrieval filter, not tenant authorization.
- Unknown citations, ambiguous IDs, mismatched instances and invalid metadata
  fail closed. Browser input and model-provided URLs are never authoritative.
- `@santo/contracts/source` is the shared Zod contract for source detail,
  private snapshots, media manifests and client-safe image metadata.

## Snapshot lifecycle and authorization

A successful grounded query saves at most five **verified citation metadata**
records to private R2 **before** finalizing quota. Failed writes return
`SOURCE_SNAPSHOT_FAILED` and release a newly reserved quota unit. Orphaned
snapshots from later finalize failures are not disclosed to clients.

Snapshots are stored as private JSON at:

```text
verified-messages/v1/<sha256(tenantId + NUL + externalUserId)>/<messageId>.json
```

No prompt text, model output, server secret or R2 credential is stored there.
The resolver checks the authenticated Santo session against the exact tenant
and external-user identity, message ID and cited source ID. Snapshots expire
**logically** 30 days after creation; configure an R2 lifecycle expiration
rule (and audit it in staging/production) to **physically remove** old
`verified-messages/v1/` objects. No claim of automatic physical deletion
is made by this code alone.

The source lookup is deliberately independent from Phase 9
`ConversationDO`. The future conversation implementation must not use
client-supplied source IDs as authority or duplicate verified source records.

## Authenticated API

`POST /v1/sources/detail` accepts only:

```json
{"messageId":"<uuid>","sourceId":"<verified instance:chunk>"}
```

The response is a strictly validated source object plus an array of safe
image metadata (`assetId`, `altText`, `caption`, `contentType`,
`width`, `height`). Neither arbitrary URL nor R2 object key is exposed.

`GET /v1/sources/:messageId/:sourceId/images/:assetId` requires the same
Santo Bearer token and authorization checks. The widget should use
authenticated `fetch` and a short-lived object URL to render the returned
blob, not a bare `<img src>` request lacking Authorization.

Media responses are allowlisted to PNG/JPEG/WebP/AVIF, signature-checked,
limited to 15 MiB, marked `nosniff`, and served with `private, no-store`.
Unknown images, forged citations and missing R2 objects fail closed.

## Canonical source manifest

Curated image mappings live in the **private** R2 bucket at:

```text
source-manifests/v1/<sha256(libraryId + NUL + instanceId + NUL + itemKey)>.json
```

The manifest is a JSON array of
`TrustedSourceMediaManifestEntrySchema` objects (up to 50 entries per
document). Every entry includes the exact trusted `sourceId`,
`libraryId`, `instanceId`, `itemKey`, `assetId`, safe R2 `objectKey`,
allowlisted MIME type, alt text, caption and dimensions.

Images live under `source-media/`. Manifest object keys cannot contain
traversal sequences or arbitrary URLs. The resolver rejects contradictory
source mappings and duplicate asset IDs, and never constructs the image key
from browser input.

Missing manifests return an empty image list. Missing, invalid, oversized
or incorrectly typed mapped media is unavailable without a fallback to an
untrusted URL.

## Acceptance evidence required

- Deterministic tests must cover forged source IDs, source ambiguity,
  invalid manifests, missing assets, bytes masquerading as an image, auth
  expiry, cross-tenant/user access, unauthorized media, and no-double-charge
  / failed-persistence behavior.
- GitHub `Verify` must pass on the **exact** final PR head.
- `P8 Trusted Sources Staging Acceptance` must pass on that same head
  against WorkOS, real AI Search, Workers AI and real R2 fixture objects.
- Run-scoped staging fixtures must be cleaned up. Exact post-merge `Verify`
  must then pass before closing Issue #43.

Neither a unit-test pass nor source code alone proves live acceptance.
