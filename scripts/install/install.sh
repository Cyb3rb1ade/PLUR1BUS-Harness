#!/bin/sh
# PLUR1BUS one-line installer for Linux and macOS (spec §6.5, HB19).
#
#   curl -fsSL https://<release host>/install.sh | sh -s -- [setup flags]
#
# Reads the release feed ({channel}.json), takes native.binary[<target>], downloads the binary, verifies its SHA-256
# BEFORE anything runs, installs it to ~/.local/bin/plur1bus and runs `plur1bus setup "$@"`. setup then verifies the
# Node runtime and the core payload against the hashes baked into the binary. A checksum mismatch, an unknown target
# or a feed without that target exit 1 with nothing installed. Never uses sudo; never writes outside $HOME.
#
# Known limit (HB19, ADR-012): the feed's minisign signature is not checked here (no tool for it on a bare system);
# the feed comes over HTTPS, and `plur1bus update --check` verifies the signature.
#
# Environment:
#   PLUR1BUS_CHANNEL        release channel (default: stable)
#   PLUR1BUS_INSTALL_FEED   feed URL; `{channel}` is replaced (default: https://updates.plur1bus.app/{channel}.json).
#                           https:// or file:// only.
set -eu

die() {
  printf 'plur1bus install: %s\n' "$*" >&2
  exit 1
}

# linux-x64 | linux-arm64 | darwin-arm64, or empty for a host outside the release matrix.
detect_target() {
  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)
  case "$os" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) os= ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) arch= ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple silicon: install the native arm64 build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  case "$os-$arch" in
    linux-x64 | linux-arm64 | darwin-arm64) echo "$os-$arch" ;;
    *) echo "" ;;
  esac
}

# fetch <url> <file>: https or file URLs only, redirects stay on https.
fetch() {
  case "$1" in
    https://* | file://*) ;;
    *) die "refusing to download over anything but https: $1" ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' --proto-redir '=https' --max-filesize 536870912 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    case "$1" in file://*) die "file:// feeds need curl" ;; esac
    wget -q --https-only -O "$2" "$1"
  else
    die "neither curl nor wget is installed"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else
    die "no SHA-256 tool (sha256sum, shasum or openssl) found"
  fi
}

# asset_field <feed text on one line> <target> <url|sha256>: the field of native.binary[<target>]. The binary map's
# assets are flat objects, so the map is `"binary":{ "<t>":{...}, ... }` with no deeper nesting.
asset_field() {
  printf '%s' "$1" |
    sed -e 's/.*"native"[[:space:]]*:[[:space:]]*{//' |
    sed -n -e 's/.*"binary"[[:space:]]*:[[:space:]]*{\(\([[:space:]]*"[^"]*"[[:space:]]*:[[:space:]]*{[^{}]*}[[:space:]]*,\{0,1\}\)*\)}.*/\1/p' |
    sed -n -e "s/.*\"$2\"[[:space:]]*:[[:space:]]*{\([^{}]*\)}.*/\1/p" |
    sed -n -e "s/.*\"$3\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

main() {
  channel=${PLUR1BUS_CHANNEL:-stable}
  case "$channel" in
    *[!a-z0-9-]* | "") die "invalid channel: $channel" ;;
  esac
  # Not `${VAR:-...{channel}...}`: the `}` of the placeholder would end the expansion.
  feed_url=${PLUR1BUS_INSTALL_FEED:-}
  [ -n "$feed_url" ] || feed_url='https://updates.plur1bus.app/{channel}.json'
  feed_url=$(printf '%s' "$feed_url" | sed "s/{channel}/$channel/g")

  target=$(detect_target)
  [ -n "$target" ] || die "unsupported target $(uname -s 2>/dev/null)/$(uname -m 2>/dev/null): release builds exist for linux-x64, linux-arm64 and darwin-arm64"

  bindir="$HOME/.local/bin"
  created_bindir=
  if [ ! -d "$bindir" ]; then
    mkdir -p "$bindir"
    created_bindir=1
  fi
  tmp="$bindir/plur1bus.tmp-$$"
  feed="$bindir/plur1bus-feed.tmp-$$"
  cleanup() {
    rm -f "$tmp" "$feed"
    if [ -n "$created_bindir" ] && [ ! -e "$bindir/plur1bus" ]; then rmdir "$bindir" 2>/dev/null || true; fi
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM

  fetch "$feed_url" "$feed" || die "could not read the release feed $feed_url"
  # One line, JSON-escaped slashes undone.
  text=$(tr -d '\r\n' <"$feed" | sed -e 's#\\/#/#g')
  url=$(asset_field "$text" "$target" url)
  want=$(asset_field "$text" "$target" sha256 | tr 'A-F' 'a-f')
  [ -n "$url" ] || die "the release feed has no binary for $target"
  printf '%s' "$want" | grep -Eq '^[0-9a-f]{64}$' || die "the release feed has no valid sha256 for $target"

  printf 'plur1bus install: downloading %s (%s)\n' "$url" "$target" >&2
  fetch "$url" "$tmp" || die "could not download $url"
  got=$(sha256_of "$tmp")
  if [ "$got" != "$want" ]; then
    die "checksum mismatch for $url: expected $want, got $got (nothing installed)"
  fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$bindir/plur1bus"
  printf 'plur1bus install: installed %s (sha256 %s)\n' "$bindir/plur1bus" "$got" >&2
  case ":$PATH:" in
    *":$bindir:"*) ;;
    *) printf 'plur1bus install: add %s to your PATH\n' "$bindir" >&2 ;;
  esac

  # exec skips the EXIT trap: clean up now.
  rm -f "$feed"
  trap - EXIT
  # Piped into sh, stdin is the script itself: give setup the terminal for its questions when there is one.
  if [ ! -t 0 ] && (: </dev/tty) 2>/dev/null; then
    exec "$bindir/plur1bus" setup "$@" </dev/tty
  fi
  exec "$bindir/plur1bus" setup "$@"
}

# The whole script is read before main runs, so a truncated download never executes half of it.
main "$@"
