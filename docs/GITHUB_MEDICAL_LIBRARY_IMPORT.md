# GitHub Actions — Private Santo medical library import

**Scope:** Staging-only ingestion of the owner-authorized medical sources. The ordinary `santoreno` source repository is PUBLIC. Do **NOT** commit the SQLite/ZIP, upload it as a public GitHub Release, or add book contents to a PR, issue, or CI artifact.

## One-time secure setup

1. In GitHub create a **separate PRIVATE repository** under `geminiamo0-ship-it`, e.g. `santo-medical-library-assets`. It will only store the licensed archive as a private Release asset.
2. Download the prepared ZIP from the ChatGPT conversation without repacking:
   `santo_staging_medical_library_r2_bundle.zip` (~71 MiB). Its verified SHA-256 is:
   `708398d7b8fcc8b2b6b82142a2e819a8d322d30596f8a892eda57672b7eaa700`.
3. In **the private source repo**, create Release `licensed-medical-libraries-2026-10-14`, and attach the original ZIP to the Release assets. Do not commit the archive to Git history.
4. In public `santoreno` repository → Settings → Secrets and variables → Actions → Variables, configure `SANTO_PRIVATE_LIBRARY_REPO=geminiamo0-ship-it/santo-medical-library-assets`.
5. Under Settings → Environments create `santo-medical-ingest-staging`. Require an owner reviewer, restrict deployment branches to `main`. In this environment, set:
   - `SANTO_LIBRARY_SOURCE_READ_TOKEN`: fine-grained GitHub PAT with **read-only Contents** on that single private asset repo (not a personal wide-scope token).
   - **No separate R2 S3 keys needed:** the existing Santo repository `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` were tested successfully with `wrangler r2 object put/get/delete` on private `santo-content-staging` from GitHub Actions (test on 14 October 2026).
   - `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` are **already defined as Santo repository secrets**; no re-entry needed. AI Search creation additionally requires its own Edit/Run permission and an R2 data-source service token UUID.
   - `AI_SEARCH_R2_SERVICE_TOKEN_ID`: account's registered AI Search R2 data-source service token UUID (only needed to configure search instances).

Never paste secrets in a chat, code commit or Actions input. GitHub Actions environment approval limits accidental or unauthorized live ingestion.

## Run from GitHub, not your local computer

Open `santoreno → Actions → Santo Medical Libraries — Private R2 Import → Run workflow` on `main`.

Run **once with the upload checkbox off** to test private release access, SHA-256, path traversal prevention, exact 74,579-file manifest, JSON library counts, and local uploader dry-run. No R2 object writes occur.

Then run with:

- `upload_to_private_r2 = true`
- `confirmation = UPLOAD_PRIVATE_SANTO_STAGING`
- `create_ai_search = true` only once AI Search service-token and cost approval are ready.

The action downloads only the approved archive from the private repo, validates checksum and allowed paths, extracts into a temporary runner directory, uploads strictly to `santo-content-staging` via Wrangler using Santo's existing Cloudflare API token, checks 74,579 successful commands and verifies representative SHA-256 readbacks, and optionally creates five isolated, prefix-restricted AI Search instances. It never alters Production, never deploys Santo itself and never enables public AI Search endpoints.

If upload is interrupted, rerunning from the same validated source overwrites the same immutable keys. The per-job checkpoint is ephemeral and is deliberately NOT exposed in a public Actions artifact. Budget for 74,579 private R2 writes, 74,579 separate Wrangler commands (slower than bulk S3), and indexing of 67,524 documents. Allow several hours; failures stop indexing and reruns safely overwrite the same deterministic keys.

## AI Search contract and limitations

Instance IDs are exactly `amboss`, `usmle`, `passmedicine`, `pastest`, and `one-examination`; these become stable Santo `libraryId` values. The service sets R2 `include_items` to `/medical-search/v1/{libraryId}/**`, excluding article JSON, image metadata, verified message snapshots and any nonmedical files. If an instance already uses the same ID but different source/path settings, the import fails without changing it.

Cloudflare indexes R2 data asynchronously. **Successful object upload or instance creation is NOT medical search acceptance.** Inspect per-instance indexing stats; then test authentic AI Search result `item.key` matches `medical-search/v1/{libraryId}/{articleId}/{sectionId}.md`; validate authenticated citation→section in Santo and actual image availability. Keep Phase 10 #58 and Source Explorer #82 open until these tests succeed.

## Troubleshooting

- `Missing private source read token`: add the fine-grained token to the protected environment.
- `Refusing public source repository`: the archive must come from a private source, never public `santoreno`.
- `SHA-256 mismatch`: wrong ZIP or ZIP was repacked; stop, confirm the original release asset.
- `Incorrect bundle object counts`: wrong or incomplete export; no R2 upload should occur.
- `Wrangler put failed`: check the existing Cloudflare token and network reliability; a retry safely overwrites deterministic paths. Readback sample SHA-256 must match before indexing.
- `Existing instance ... different`: never overwrite a different AI Search instance; resolve identity/migration deliberately.
- `CLOUDFLARE_API_TOKEN` 403 or service token missing: add explicit AI Search Edit/Run permission and a valid R2 service API token.
- `indexingStats` show queued/running: wait for background indexing and do not claim the libraries are live.
