#!/bin/sh
set -eu
if [ ! -w /state ]; then
  echo "State volume is not writable by 10001:10001. Initialise the volume root; check rootless UID mapping. Use a runtime volume, not a macOS virtiofs state bind." >&2
  exit 73
fi
exec /usr/bin/setpriv --no-new-privs plur1bus supervise "$@"
