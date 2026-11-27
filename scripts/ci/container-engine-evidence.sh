#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

image="$1"
prefix="$2"
engine_elf="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/plur1bus-engine.XXXXXX")"
trap 'rm -f -- "$engine_elf"' EXIT

docker run --rm --entrypoint cat "$image" /usr/local/bin/plur1bus-engine > "$engine_elf"
readelf --wide --section-headers "$engine_elf" > "$prefix.sections"
# Addresses change after the first size difference, so compare symbol names, kinds and sizes.
nm --defined-only --print-size --format=posix "$engine_elf" \
  | awk 'NF >= 4 { print $1, $2, $4 }' \
  | sort > "$prefix.symbol-sizes"
