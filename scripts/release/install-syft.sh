#!/usr/bin/env bash
# Explicit setup operation; not called by any test or by sbom.sh.
set -euo pipefail
out="${1:?usage: install-syft.sh BIN_DIRECTORY}"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux_amd64; sum=689e12c5cbf67521ce61b9c126068f9eaabe1223e77971b2fede50033ff6b5cc ;;
  Darwin-arm64) platform=darwin_arm64; sum=91365712a06af0c0dcd06f5e87fc8791c4332831b3dd6f5474acaaf803d71d82 ;;
  *) echo 'Unsupported Syft installer platform' >&2; exit 1 ;;
esac
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
curl --fail --silent --show-error --location --retry 3 "https://github.com/anchore/syft/releases/download/v1.20.0/syft_1.20.0_${platform}.tar.gz" -o "$work/syft.tar.gz"
actual="$(node -e 'const fs=require("node:fs"),c=require("node:crypto"); console.log(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$work/syft.tar.gz")"
[ "$actual" = "$sum" ] || { echo 'Syft checksum mismatch' >&2; exit 1; }
mkdir -p "$out"; tar -xzf "$work/syft.tar.gz" -C "$out" syft
