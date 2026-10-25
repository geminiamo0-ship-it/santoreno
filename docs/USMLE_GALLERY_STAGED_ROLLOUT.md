# Santo USMLE Image Gallery — staged integration and validation

Scope: staging only. Built on existing santo-medical-images Gallery instance.
Do not change the five clinical AI Search indexes, AMBOSS, existing gallery
manifest, Luna citation evidence, original R2 files, or Production.

## Source audit (Google Drive ZIP, 2026-10-25)

- 4,525 distinct image IDs and URLs, 7,482 article/source references.
- Original caption and figure legend are null for all 4,525. Generated captions
  are derived from article-adjacent text, never visually verified.
- 3,185 have unknown modality.
- All 4,525 are rights-locked and display_ready=false: **no live ingestion**.
- Prior five misassociations improved, but broader caption correctness is
  unproven. The six independently reviewed image IDs have explicit corrections.
- All descriptions have a repetitive "shown in the context of" phrase; do not
  embed this boilerplate into AI Search.
- Conservative validation flags 218 short captions (some are valid single-word
  clinical terms) and 84 sparse contexts, not confirmed diagnosis errors.

## Preparation

scripts/prepare_usmle_gallery.py reads the private dataset from local disk
with no Cloudflare writes and no bulk ingestion. Never commit the source JSONL
or generated medical content to a public repository.

  python scripts/prepare_usmle_gallery.py \
    --input /private/usmle_images_full_library.jsonl \
    --output /private/usmle-gallery-ready \
    --expected-count 4525

Outputs: private_review.jsonl, qa_summary.json, approved_items/*.json,
and usmle_image_manifest.json. Only affirmatively rights-approved,
display-ready, valid records get indexable docs. A URL SHA-256 fingerprint
is not a content hash.

## Worker integration

- Existing img_000001-style records use original v1 Gallery manifest, unchanged.
- New USMLE IDs (usmle_L, usmle_U and usmle_B followed by digits) may be
  recognized from the existing Gallery namespace search.
- Separate manifest key: gallery/v1/usmle_image_manifest.json in CONTENT_BUCKET.
- Hydration requires manifest-level rights_status=approved, display_ready=true,
  allowlisted image URL matching the original ID and no external fetch.
- New source disabled unless staging SANTO_USMLE_GALLERY_V1=true.
- No USMLE gallery image may count as medical citations or context sent to Luna.

## Remaining acceptance gates

1. Confirm redistribution rights and clear only authorized images.
2. Review weak/generic titles, insufficient contexts, and earlier diagnoses.
3. Verify media URLs and source mapping. Never delete original media.
4. Upload explicitly approved documents to existing santo-medical-images
   managed instance (do not recreate/modify five clinical indexes).
5. Monitor completed/queued/running/error/skipped counts; do not claim complete
   without finished ingestion and real relevance/safety tests.
6. Publish authorized USMLE manifest under separate R2 key, switch Staging
   gate on, verify source viewer and real user requests. Production remains off.
7. Verify answer latency, quote/citation isolation and Gallery dedup.

**Pagination limitation:** Cloudflare currently caps one search response at
50 results. The existing Load More UI can reveal the retrieved pool, but
it does NOT guarantee exhaustive paging of every relevant image beyond 50.
A separate paged image catalog query is needed for a truly unlimited Gallery.

## Release update — 25 October 2026 (owner-authorized Staging)

- Owner explicitly confirmed image-display rights for this dataset; the original rights flags remain preserved in source and per-image QA.
- Owner authorized proceeding despite ONE known Cloudflare timeout, `usmle_L116818.json`. No failed image is included in the published manifest.
- **Actual index counters:** completed=7533, queued=0, running=0, error=1, skipped=0, degraded=0. This equals 3,295 original images + **4,238 published USMLE images**; 286 low-quality images remain excluded from the original 4,525.
- Staged-image manifest contains exactly 4,238 entries and passed R2 byte-for-byte readback.
- Five basic image-topic searches returned USMLE images (first USMLE hit at rank 1 for each); this does NOT prove exact image correctness on every query.
- Staging Worker deployed and health plus unauthenticated-401 checks passed. Production untouched.
- [Successful release GitHub Actions #40208253739](https://github.com/geminiamo0-ship-it/santoreno/actions/runs/40208253739), staging Worker version `cf3c5a59-8173-421a-a62f-f3aa75e75258`.
- Signed-in browser QA, detailed per-diagnosis image relevance, and genuine unbounded Load More pagination remain outstanding. PR #213 stays draft until final review.

