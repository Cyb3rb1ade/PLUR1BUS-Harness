#!/bin/bash
# A job-local CMake for the unprivileged macOS VM and hosted unit runners. No template or system installation.
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "setup-macos-cmake: expected macOS" >&2; exit 1; }
: "${RUNNER_TEMP:?RUNNER_TEMP is required}" "${GITHUB_PATH:?GITHUB_PATH is required}"

version=3.31.12
archive="cmake-$version-macos-universal.tar.gz"
# https://github.com/Kitware/CMake/releases/download/v3.31.12/cmake-3.31.12-SHA-256.txt
sha256=799af7fd545db9bf1b9cfe72f8095880e727a2d4e0df0e3dffc3bc7b95c2d3b0
directory=$(mktemp -d "$RUNNER_TEMP/plur1bus-cmake.XXXXXX")
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 \
  "https://github.com/Kitware/CMake/releases/download/v$version/$archive" --output "$directory/$archive"
printf '%s  %s\n' "$sha256" "$directory/$archive" | shasum -a 256 -c -
tar -xzf "$directory/$archive" -C "$directory"
bin="$directory/cmake-$version-macos-universal/CMake.app/Contents/bin"
"$bin/cmake" --version
printf '%s\n' "$bin" >> "$GITHUB_PATH"
rm "$directory/$archive"
