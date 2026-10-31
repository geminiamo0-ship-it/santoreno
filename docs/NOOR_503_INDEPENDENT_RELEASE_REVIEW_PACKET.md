# Noor ink 503 — independent Dev release review packet (31 Oct 2026)

This file is an **audit handoff**, NOT an independent approval or a release authorization. This PR runs no Cloudflare writes.

## Source and proof (immutable references)

| Scope | Head | Evidence |
| --- | --- | --- |
| Noor migration source, merged PR [#288](https://github.com/geminiamo0-ship-it/nour-elquran/pull/288) | original PR head `09fed0cddb4fcfc6ded5f96183361bbb1b003399`; merged to main `acdd869ac596edb4019bf453d8b1ccf6f56c5c51` | [Noor native D1 Verify #41228150823](https://github.com/geminiamo0-ship-it/nour-elquran/actions/runs/41228150823), [Noor main Verify #41233957031](https://github.com/geminiamo0-ship-it/nour-elquran/actions/runs/41233957031) |
| Santoreno original Dev gate, merged PR [#307](https://github.com/geminiamo0-ship-it/santoreno/pull/307) | original PR head `a2b271df01caaab920ac1d2fbdc8da3d4bdafa19`; merged to main `bafd5fa4ba7cea08f712252fe2212a23220e1f32` | [Santoreno Verify #41229150081](https://github.com/geminiamo0-ship-it/santoreno/actions/runs/41229150081) |
| Santoreno bounded latest-main-Verify race fix, PR [#312](https://github.com/geminiamo0-ship-it/santoreno/pull/312) | **Use exact current PR SHA**, recheck at review time | [Latest Verify](https://github.com/geminiamo0-ship-it/santoreno/actions/workflows/verify.yml), [PR-only Dev validation](https://github.com/geminiamo0-ship-it/santoreno/actions/workflows/noor-private-staging.yml) |
| Actual failed automatic Dev run | Santoreno `bafd5fa4ba7cea08f712252fe2212a23220e1f32` | [Run #41233982557](https://github.com/geminiamo0-ship-it/santoreno/actions/runs/41233982557), `NOOR_SOURCE_GATE_DENIED: No successful exact-head Noor main Verify` **before remote D1 migration** |

## Incident and code being reviewed

The older native Cloudflare D1 SQLite evaluator rejects a six-repeated-hex-class `GLOB` in the private Sheikh draft trigger with `LIKE or GLOB pattern too complex` on an authorized pen+highlight INSERT. Migration [`0023_quran_ink_color_d1_compat.sql`](https://github.com/geminiamo0-ship-it/nour-elquran/blob/acdd869ac596edb4019bf453d8b1ccf6f56c5c51/workers/api/migrations/0023_quran_ink_color_d1_compat.sql) recreates **two triggers** (`teacher_assignment_draft_guard` and `learner_quran_event_guard`) using length/prefix/short negated-hex `GLOB`, plus explicit `COALESCE(json_type(...),'<missing>')` checks. It does not delete or rewrite old migrations or data.

The native Wrangler D1 fixture proves populated 0022 → forward 0023, replay-safety, retention of a prior draft, acceptance of a new valid ink revision and atomic publish to the learner Quran ledger; unassigned siblings, malformed colors, and missing coordinates are denied. This is **local** proof, not remote Dev or Production verification.

Santoreno PR #312 fixes the separate workflow race: at most ten 12-second attempts for the current exact Noor main SHA's **latest successful completed push Verify**. It fails if the SHA changes during waiting, on wrong event/SHA, malformed or incomplete run results, pending/failed/cancelled latest Verify, or exhausted attempts. The explicitly reviewed PR-head path remains separate.

## Independent reviewer responsibilities (not fulfilled by the author or CI)

1. Confirm identity and `write`, `maintain` or `admin` permission in both repositories. The author `geminiamo0-ship-it` cannot independently review the author's work.
2. Compare the **merged** Noor PR #288 diff at its original exact head to its merge and to migration 0023 now on main. Audit SQL null semantics, identity/sibling isolation, replay/versioning, immutable publication and both trigger definitions.
3. Compare Santoreno merged PR #307 diff to its merge. Audit Cloudflare credential scope, `noor-core-staging` database name, `noor-site-staging` Worker name, signed synthetic test-only accounts, no production resources, SHA selection, and non-PR deployment conditions.
4. Independently review the **exact current head** of PR #312 and submit a GitHub `APPROVED` review on it (not merely a comment); document post-merge Noor #288 and Santoreno #307 audit explicitly, with their exact merge SHAs and any limitations, on [Noor issue #286](https://github.com/geminiamo0-ship-it/nour-elquran/issues/286) and [Santoreno issue #306](https://github.com/geminiamo0-ship-it/santoreno/issues/306). GitHub does not support a fresh APPROVED review on a closed merged PR, so **do not represent an audit comment as an original PR approval**.
5. If the review is substantive and the existing security/permission gate cannot accept its format, update the gate through another independently approved PR, not by temporarily bypassing it.

## Remote Dev acceptance — AFTER approval, never before

- Check current main SHAs and successful exact-head Verify; do not use a stale SHA or old success.
- Use only the already existing isolated `noor-core-staging` D1 and `noor-site-staging` Worker, never production. Take a Dev backup/snapshot if available and inspect migration state *before* writes.
- Apply 0023 **forward-only** through the pinned Wrangler migrations runner. Confirm exactly one successful applied migration record and unchanged previous migrations. **No** `NOOR_CUMULATIVE_INK_ENABLED` toggle yet.
- Synthetic two-session Sheikh/learner verification: signed Sheikh GET private drafts → pen + highlight save → same-ID idempotent replay → publish assignment atomically → authenticated learner read shows both shared marks on correct page → wrong teacher/sibling/unauthenticated learner receives denial. Verify no draft or Quran ledger rows for foreign siblings.
- A migration-success log or HTTP 200 on a health route is **not enough**: require the signed end-to-end save, publish and owner Quran readback with no 503. Record GitHub run URL, exact Noor SHA, exact Santoreno SHA, migration 0023 state, error classification, and negative test results.
- If any test fails, keep feature flag OFF; file a follow-up issue with *sanitized* D1 code/status only (no raw SQL response, bearer cookies, child details or audio). Restore guards through a new forward-only migration, never delete historical migration files. No Production changes.

## Current release decision

**BLOCKED**: At creation of this packet, GitHub review histories for merged #288 and #307 do not contain independent `APPROVED` submissions, and PR #312 has none. The auto Dev run stopped before any D1 writes; **remote 503 is still unverified**. Do not infer release authorization from a merge or passing CI.
