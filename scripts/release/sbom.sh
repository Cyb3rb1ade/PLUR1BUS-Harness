#!/usr/bin/env bash
# Offline scanner: install Syft separately; this script never downloads tools or dependencies.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:?usage: sbom.sh OUT_DIRECTORY}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
syft version | grep -Eq 'Version:[[:space:]]+1\.20\.0$' || { echo 'Syft 1.20.0 required' >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/cargo" "$work/pnpm"
cp "$root/Cargo.lock" "$work/cargo/"
cp "$root/pnpm-lock.yaml" "$work/pnpm/"
SYFT_CHECK_FOR_APP_UPDATE=false syft scan "dir:$work/cargo" --source-name plur1bus-cargo --source-version "${RELEASE_VERSION:-0.1.0}" -o "cyclonedx-json=$out/cargo.cdx.json"
SYFT_CHECK_FOR_APP_UPDATE=false syft scan "dir:$work/pnpm" --source-name plur1bus-pnpm --source-version "${RELEASE_VERSION:-0.1.0}" -o "cyclonedx-json=$out/pnpm.cdx.json"
node "$root/scripts/release/normalize-sbom.mjs" "$out/cargo.cdx.json" "$out/pnpm.cdx.json"
