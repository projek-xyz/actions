#!/usr/bin/env bash
# Fail when any `uses:` reference in .github/workflows is not pinned to a full
# 40-hex commit SHA with a trailing "# vX.Y.Z" comment.
# Local relative refs (`uses: ./...`) are exempt — they cannot be SHA-pinned.
set -euo pipefail

if grep -rEn 'uses:[[:space:]]*[^[:space:]]+' .github/workflows \
  | grep -Ev 'uses: \./' \
  | grep -Ev 'uses: [^@[:space:]]+@[0-9a-f]{40}[[:space:]]+# ?v?[0-9]'; then
  echo 'error: unpinned action reference (need full 40-hex SHA + "# vX.Y.Z" comment)' >&2
  exit 1
fi

echo 'pins OK'
