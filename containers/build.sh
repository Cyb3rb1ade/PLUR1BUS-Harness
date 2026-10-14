#!/bin/sh
# Both engines use the same Dockerfile and exact source commit metadata.
set -eu
runtime=${1:-apple}
image=${2:-plur1bus-harness:local}
case "$runtime" in
  apple|docker) ;;
  *) echo 'Usage: containers/build.sh apple|docker [IMAGE]' >&2; exit 64 ;;
esac
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
revision=$(git -C "$root" rev-parse HEAD)
epoch=$(git -C "$root" log -1 --format=%ct)
created=$(git -C "$root" log -1 --format=%cI)
# A stable context avoids Apple's context enumerator racing concurrent Cargo builds.
context=$(mktemp -d "${TMPDIR:-/tmp}/plur1bus-image.XXXXXX")
# A trapped signal would otherwise run the handler and let the script carry on; exit so the build stops too.
trap 'rm -rf "$context"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
rsync -a --exclude .git --exclude .git-bundles --exclude .com.apple.container --exclude target \
  --exclude node_modules --exclude dist --exclude .DS_Store --exclude '.env*' --exclude '*.pem' --exclude '*.key' \
  --exclude .netrc --exclude '*.log' --exclude .claude --exclude .superpowers "$root/" "$context/"
set -- --platform "${PLUR1BUS_BUILD_PLATFORM:-linux/arm64}" -f containers/harness/Dockerfile -t "$image" \
  --build-arg "SOURCE_DATE_EPOCH=$epoch" --build-arg "VCS_REF=$revision" --build-arg "CREATED=$created"
if [ -n "${GH_ENGINE_READ_TOKEN:-}" ]; then
  set -- "$@" --secret id=engine_token,env=GH_ENGINE_READ_TOKEN
fi
cd "$context"
case "$runtime" in
  apple)
    # Preloading the pinned index avoids a cold-store root-manifest failure in Apple 1.5.0.
    sed -n 's/^FROM \([^ ]*\).*/\1/p' containers/harness/Dockerfile | sort -u | while IFS= read -r base; do
      container image pull --platform "${PLUR1BUS_BUILD_PLATFORM:-linux/arm64}" "$base"
    done
    container build "$@" . ;;
  docker) docker buildx build --load "$@" . ;;
  *) echo 'Usage: containers/build.sh apple|docker [IMAGE]' >&2; exit 64 ;;
esac
