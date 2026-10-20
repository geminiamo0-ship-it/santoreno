# Santo Research Mode (PubMed / PMC) — Staging implementation

Status: **staging deployed** on 2026-10-20. Production is unchanged; feature remains off unless separately enabled.

## Contract and shared billing

`source_mode: "libraries" | "research"` defaults to `libraries`.
Both modes use the existing Santo authenticated session, ConversationDO turn
sequencing, TenantMeterDO reserve/finalize/release, a single source-citation
registry, source snapshots in R2, one model generation path, and existing
streaming. **There is no Research-only quota or subscription.**
Example: 100 allowed, 20 Libraries successes + 20 Research successes = 60 remaining.
Different source-mode payload under the same idempotency key is a conflict
when the request is pinned by the conversation state; no double charging.

## Research data path

1. PubMed NCBI ESearch discovers a bounded batch of candidate PMIDs.
2. Batched EFetch supplies article titles, abstracts, study types, dates, DOI,
   PMCID, etc. No assumption that all records have complete articles.
3. Optional OpenAlex DOI metadata (when `OPENALEX_API_KEY` is configured)
   augments citation counts. Do not treat citations as proof of medical quality.
4. Santo ranker scores candidate relevance 40%, study class 30%,
   recency 20%, age-adjusted citation influence 10%. These weights are
   experimental and do not replace human evidence appraisal.
5. EFetch PMC supplies additional relevant passages, tables/figure captions
   for eligible, accessible PMCID articles.
6. Only selected evidence enters the one Luna/Santo model pathway. Server
   verifies citation IDs and writes authenticated source snapshots.
7. Research source details open the original PubMed record. PMC media from
   official AWS Article Datasets are resolved *after* answer completion,
   matched to the article JATS `graphic xlink:href` and caption, and embedded
   in Royal Bank's answer display. This doesn't delay the first answer.
8. Figure delivery currently allows CC0, CC BY, CC BY-SA dataset records,
   excludes retracted records, and restricts links to the official public
   S3 bucket. Some articles have no available/reusable images. Review
   rights associated with particular third-party figures as appropriate.

Candidate/result/evidence/snapshot counts have bounded engineering safety
limits. They are not artificial three-article or five-image research search
caps: ESearch can inspect 60 IDs, evidence packaging takes up to 12 selected
sources, and responses can cite 10; the token budget limits actual text sent.

## Model token policy

Intended combined ceiling: **10,000 input + output tokens**, output
`max_tokens=3000`. Estimated input budget 7,000, including instructions,
history in effective query, and source metadata.
`buildBudgetedResearchPrompt` trims lower-value passage length dynamically
and reserves output. **The local token estimator is approximate**, not an exact
Qwen/Llama tokenizer or provider-verified hard enforcement. Check actual
provider usage under staging to validate the 10k ceiling and tune accordingly.
The same preflight currently runs for both Libraries and Research.

## Configuration

- `SANTO_RESEARCH_ENABLED=true` **staging only**. Production must remain
  disabled until release gates are met.
- `NCBI_API_KEY` (secret, optional for initial low-rate testing).
- `OPENALEX_API_KEY` (secret; when unset, impact enrichment is skipped,
  and the ranker uses its neutral missing-value score).
- Existing Cloudflare AI, content bucket, TenantMeterDO, and ConversationDO
  bindings remain unchanged. Never place provider credentials in Royal Bank
  browser code or version-controlled vars.
- Respect provider API limits and any relevant rights/agreements; free
  end-user access does not imply unrestricted reuse or endorsement by NLM.

## Live acceptance checklist (not yet signed off)

- [ ] A real authorized tenant/session request reaches PubMed, OpenAlex
      (if configured), and PMC in Research mode; answers include live, correct PMIDs.
- [ ] One message charged per successful reply regardless of mode; failure and
      same-key retry do not charge twice.
- [ ] Verify research/image source authorization and tenant/user isolation.
- [ ] Test real PMC articles with figures, captions, licenses, tables and
      retractions, including absent/unavailable media.
- [ ] Verify real prompt + provider output token counts, med quality,
      accessibility, mobile/RTL, and 1st-character p50/p95 times.
- [ ] Review NCBI provider limits under real concurrency and add caching/
      request-coalescing/rate-limit enforcement if needed.
- [ ] Release approval for Royal Bank frontend PR and Santo backend PR.
- [ ] Production remains unchanged until those gates pass.

## References

- Santo implementation: GitHub PR #204 / Issue #203
- Royal Bank implementation: GitHub PR #146 / Issue #145
- https://www.ncbi.nlm.nih.gov/books/NBK25497/
- https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/
- https://pmc-oa-opendata.s3.amazonaws.com/README.txt
