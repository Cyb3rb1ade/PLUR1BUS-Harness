#!/usr/bin/env bash
# Print the verified destination on stdout. Diagnostics and BuildKit use stderr.
set -euo pipefail

case "${1:-}" in prepare|verify) ;; *) exit 2 ;; esac
[[ "$GITHUB_EVENT_NAME" == push ]] || exit 1
package=plur1bus-harness-distribution
case "$GITHUB_REF" in
  refs/heads/main) package+=-staging ;;
  refs/tags/v*) ;;
  *) exit 1 ;;
esac
image="ghcr.io/cyb3rb1ade/$package"

package_visibility() {
  local response rc=0 protocol code rest
  response=$(gh api --include "/users/Cyb3rb1ade/packages/container/$package") || rc=$?
  read -r protocol code rest <<< "$response"
  [[ "$protocol" == HTTP/* ]] || return 1
  if [[ "$code" == 404 && "$rc" != 0 ]]; then
    printf 'missing\n'
  elif [[ "$code" == 200 && "$rc" == 0 ]]; then
    printf '%s\n' "$response" | sed '1,/^\r\{0,1\}$/d' | jq -er '.visibility | select(. == "private" or . == "public")'
  else
    return 1
  fi
}

visibility=$(package_visibility)
if [[ "$GITHUB_REF" == refs/heads/main ]]; then
  if [[ "$1" == prepare && "$visibility" == missing ]]; then
    # stdin is the complete build context. This marker contains no checkout, engine or secrets.
    printf 'FROM scratch\nLABEL org.opencontainers.image.source="https://github.com/Cyb3rb1ade/PLUR1BUS-Harness"\n' |
      docker buildx build --platform linux/amd64 --provenance=false --sbom=false --push --tag "$image:bootstrap" - >&2
    for delay in 0 2 4 8 16; do
      sleep "$delay"
      visibility=$(package_visibility)
      [[ "$visibility" == missing ]] || break
    done
  fi
  if [[ "$visibility" != private ]]; then
    echo "The main staging package must have verified private visibility." >&2
    exit 1
  fi
fi
printf '%s\n' "$image"
