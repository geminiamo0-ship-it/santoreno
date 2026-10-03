# Main Branch Protection Policy

`main` is the production source-of-truth branch for Santo.

## Required policy

Configure GitHub branch protection or a repository ruleset for `main` with:

- Require a pull request before merging.
- Require at least 1 approval once more than one maintainer is active.
- Dismiss stale approvals when new commits are pushed.
- Require review from Code Owners when practical.
- Require status checks to pass before merging.
- Required check: **Verify / repository-policy**.
- Once Phase 0 creates the code workspace, also require **Verify / code-quality**.
- Require branches to be up to date before merging when GitHub supports it reliably for the workflow.
- Require conversation resolution before merging.
- Block force pushes.
- Block branch deletion.
- Do not allow bypass except for emergency recovery; document any bypass in an issue.

## Merge policy

Preferred merge method: **squash merge** for focused implementation PRs unless preserving individual commits provides material value.

Every merged PR must reference its issue and contain verification evidence.

## Current connector limitation

The connected GitHub integration used by the project can create code, issues, PRs, and inspect Actions, but it does not expose a write operation for repository branch-protection/ruleset administration.

Therefore this repository file is the canonical required policy until the GitHub repository setting is enabled through an authorized GitHub administration surface.

Do not consider branch protection fully enabled merely because this document exists; verify the actual repository setting separately.
