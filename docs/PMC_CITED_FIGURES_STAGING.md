# PMC cited figures in Santo Research Mode — Staging

## What was missing

PMC retrieval fetched JATS XML and exposed `<fig><caption>` as prose but not
actual figure files. Research mode excluded article-R2 image hydration and
research source viewer displayed `images: []`. This caused zero genuine PMC
figures in Related Pics despite citations to full-text PMC papers.

## Implementation

- `workers/api/src/ai/pmc-figures.ts`: parse the original JATS article
  `fig/graphic xlink:href` and exact associated caption; match its media
  filename against the **2026 PMC Cloud Service AWS `media_urls` JSON**.
- Media is accepted only if the matching versioned metadata reports the same
  PMCID, `is_pmc_openaccess=true`, not retracted, approved CC0/CC BY/CC BY-SA
  licensing, and the original S3 URL has a 32-digit MD5 checksum. Never
  synthesize URLs from guessed figure IDs, accept unrelated files or allow
  arbitrary remote hosts. Exclude obvious third-party permission captions.
- Up to 2 retrieved PMC full-text articles per Research request receive
  bounded optional metadata resolution; no new AI Search, Qwen or Luna calls,
  no new source types, no upload to R2, no Cloudflare Search reindex.
- Images are attached as nonclinical metadata on each *original* PubMed
  evidence object, and only displayed **after Luna citations are verified**
  and only when that exact PubMed `sourceId` is cited. Not a medical citation.
- Existing Related Pics and Source Viewer are used; the latter requires an
  authenticated citation snapshot. Existing legacy image paths remain intact.
- A separate flag `SANTO_PMC_CITED_FIGURES_V1` enables only Staging.
  Production is unaffected and the fallback is empty media, not fabricated.
- The Gallery returns the eligible images of the cited papers, not a new
  infinite worldwide PMC search index. Initial bound is 24 figures/article
  and 50 response pictures; ordinary UI Load More applies to saved results.

## Licensing and attribution

Metadata license is necessary but sometimes not sufficient for third-party
figures within articles; obvious permission captions are excluded. Keep
source article title, PMC accession and license in `sourceName`, plus
the exact JATS caption, and use the verified Citation/Article Viewer for
source context. No image copying to owned storage occurs.

PMC official dataset: https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/
Readme: https://pmc-oa-opendata.s3.amazonaws.com/README.txt

## Verification

- Read-only real PMC provider Action:
  https://github.com/geminiamo0-ship-it/santoreno/actions/runs/40212918070
  `PMC10009416`, `CC BY`, original JATS figure `NPR2-43-85-g001.jpg`
  matched metadata `media_urls`, remote image Range HTTP 206.
- Targeted typed API, security, viewer, and research response tests:
  https://github.com/geminiamo0-ship-it/santoreno/actions/runs/40213025900
  PASSED 26 contracts, 5 widget, 68 API tests, types/build/smoke.
- Signed-in browser acceptance needed to verify a cited research paper has
  on-screen Related Pics and correct attribution. Some cited articles have
  no license-approved images; do not manufacture those images.

## Deployment boundaries

Only the Staging Worker can be deployed by this PR. Never mutate/remove
Cloudflare AI Search indexes, unrelated R2 files or Production routes.
