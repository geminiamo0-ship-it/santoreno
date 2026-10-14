#!/usr/bin/env bash
# Download precisely the owner-approved licensed archive stored in a public Git
# asset branch. Never trust mutable branch updates without commit + SHA validation.
set -euo pipefail
ASSET_COMMIT="ce725ea59821772e1ec283ffee45cd32cbe0e36f"
ASSET_BRANCH="assets/santo-medical-libraries-2026-10-14"
EXPECTED_SHA256="708398d7b8fcc8b2b6b82142a2e819a8d322d30596f8a892eda57672b7eaa700"
dest="${1:?pass extracted destination}"
archive="${RUNNER_TEMP:?}/santo_staging_medical_library_r2_bundle.zip"
mkdir -p "${RUNNER_TEMP}/santo-assets" "$dest"
git fetch --no-tags --depth=1 origin "refs/heads/$ASSET_BRANCH"
found="$(git rev-parse FETCH_HEAD)"
if [[ "$found" != "$ASSET_COMMIT" ]]; then
  echo "Asset branch changed; refusing unverified corpus revision" >&2
  exit 1
fi
git archive FETCH_HEAD medical-libraries | tar -xf - -C "${RUNNER_TEMP}/santo-assets"
shopt -s nullglob
parts=("${RUNNER_TEMP}/santo-assets/medical-libraries/"*.zip.part-*)
if [[ "${#parts[@]}" -ne 9 ]]; then
  echo "Expected precisely nine Git asset shards" >&2
  exit 1
fi
cat "${parts[@]}" > "$archive"
if [[ "$(stat -c '%s' "$archive")" -ne 74078792 ]]; then
  echo "Archive size mismatch" >&2
  exit 1
fi
echo "$EXPECTED_SHA256  $archive" | sha256sum --check --status
python scripts/verify_medical_library_bundle.py --zip "$archive" \
  --sha256 "$EXPECTED_SHA256" --out "$dest" \
  > "${RUNNER_TEMP}/santo-corpus-verification.json"
jq -e '.objectCount == 74579 and .byRoot["medical-search"] == 67524 and .byRoot["medical-articles"] == 7049' \
  "${RUNNER_TEMP}/santo-corpus-verification.json" >/dev/null
echo "Verified pinned public Git asset branch and extracted 74,579 private R2 upload objects."
