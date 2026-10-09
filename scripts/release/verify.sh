#!/usr/bin/env bash
set -euo pipefail
# Verification intentionally uses the exact tag identity, never an unbounded identity regexp.
dir="${1:?usage: verify.sh RELEASE_DIRECTORY TAG}"
tag="${2:?tag required}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || { echo 'invalid tag' >&2; exit 1; }
root="$(cd "$(dirname "$0")" && pwd)"
repo=Cyb3rb1ade/PLUR1BUS-Harness
cosign verify-blob "$dir/SHA256SUMS" --bundle "$dir/SHA256SUMS.sigstore.json" \
  --certificate-identity "https://github.com/$repo/.github/workflows/release.yml@refs/tags/$tag" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
node "$root/checksums.mjs" --verify "$dir"
# The exported attestation bundle verifies each checksum-listed asset locally via gh's verifier.
while IFS= read -r line; do
  name="${line:66}"
  gh attestation verify "$dir/$name" --repo "$repo" --bundle "$dir/provenance.intoto.jsonl" \
    --signer-workflow "$repo/.github/workflows/release.yml" --source-ref "refs/tags/$tag"
done < "$dir/SHA256SUMS"
