## 2026-10-31 — exact-main Verify race guard (#312, candidate only)

- Incident: Santoreno [Dev #41233982557](https://github.com/geminiamo0-ship-it/santoreno/actions/runs/41233982557) failed **before** touching Cloudflare because the Noor main SHA's push Verify was not completed at the time of the source gate. Noor [Verify #41233957031](https://github.com/geminiamo0-ship-it/nour-elquran/actions/runs/41233957031) later succeeded for the same exact merge `acdd869ac596edb4019bf453d8b1ccf6f56c5c51`.
- PR #312 changes **only** the default main-source CI check: on the secret-bearing workflow, poll up to ten times with 12-second intervals; before **each** poll verify the Noor main SHA still matches the initial SHA. Success requires the exact SHA, push event, named Verify job, completed successful conclusion. Failed, cancelled, in-progress, stale SHA or ref changes never count as success; exhausted polls fail closed. Reviewed-PR checks remain unchanged.
- **Important release safety:** Noor PR #288 and Santoreno PR #307 are already merged but have **no independent APPROVED reviews** recorded on GitHub. Exact-head CI passing does not replace independent review of the D1 0023 source. PR #312 must be independently reviewed before merge; **do not trigger a remote D1 migration run** or enable cumulative ink until an independent qualified reviewer has audited the actual migrated SQL and staging scripts and signed Dev tests pass. No Cloudflare credentials are used in PR #312 validation.

# Noor Dev: reviewed PR SHA staging gate (#306)

This is an **opt-in isolated Cloudflare Dev** path for testing a Noor change before merging it. It does not deploy Noor Production or Santo and does not change feature flags.

## Default and manual modes

- Pushes to Santoreno main and manual dispatch without `noor_pr_number` continue to select the current **Noor main** SHA, requiring its exact successful push `Verify`.
- Manual `workflow_dispatch` with `noor_pr_number=288` selects only the **current immutable head SHA** of that Noor PR. It refuses a fork, closed/draft PR, non-main target, self-approval, stale approval, a subsequent change-requested review, missing exact-head successful pull-request `Verify`, or a PR that changes head during checkout/build.
- No PR event deploys; PR CI runs only offline validation. The existing staging runner still targets only `noor-core-staging` and `noor-site-staging`, and optional Chrome/LiveKit browser checks stay off by default.
- An **independent reviewer with verified Noor repository `write`, `maintain`, or `admin` permission** must approve the exact current Noor PR head before a manual PR dispatch. GitHub REST `GET /repos/{owner}/{repo}/collaborators/{reviewer}/permission` is queried with the existing read token; a `read`/`triage` review, missing permission, HTTP error, or insufficient token visibility **denies** the run. The reviewer cannot be the PR author. GitHub logins are compared case-insensitively, any outstanding `CHANGES_REQUESTED` from another independent reviewer blocks deployment, and 100 returned reviews are treated as potentially incomplete pagination and denied until a paginated implementation exists. If approval or permission visibility is unavailable, keep Noor #286 open and do not bypass the gate.

## Run after independent review and source CI

In Santoreno GitHub Actions, select **Noor Development Staging — isolated D1 and Worker**, click **Run workflow**, select `main`, enter `noor_pr_number=288`, and leave both browser flags false unless explicitly needed. The run resolves the PR head from the GitHub API, validates review and CI, checks out that SHA, revalidates the source immediately before deploying, and runs the existing synthetic teacher/owner D1 suite.

For Noor #286, acceptance still requires signed teacher pen+highlight draft save, replay/reload, publish, owner cumulative readback and sibling denial after forward-only migration 0023. Record the exact Santoreno run URL and Noor SHA in both issues. Do not merge or enable `NOOR_CUMULATIVE_INK_ENABLED` from source CI alone.

## Rollback

Remove the optional PR input and restore main-only checkout in a reviewed PR. Do not delete or rewrite applied D1 migrations. The PR gate stores no credentials, names, voice, or child data.
