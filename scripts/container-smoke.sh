#!/usr/bin/env bash
# Smoke test of the harness image (M8): it starts under the hardened settings of deploy/compose.yaml, its HEALTHCHECK turns
# healthy, `plur1bus --version` answers in the container, and the security properties hold. Docker only; no network
# beyond what the image itself needs. Usage: scripts/container-smoke.sh <image> [expected-version]
# Env: SMOKE_TIMEOUT_S (default 240), SMOKE_RUN_ARGS (extra `docker run` arguments, tests of this script), GH_ENGINE_READ_TOKEN (checked absent from the image history when set).
set -euo pipefail

image="${1:?usage: container-smoke.sh <image> [expected-version]}"
expected="${2:-}"
timeout_s="${SMOKE_TIMEOUT_S:-240}"
read -r -a smoke_run_args <<< "${SMOKE_RUN_ARGS:-}"
name="plur1bus-smoke-$$"
state="$name-state"
models="$name-models"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::group::container logs" >&2
    docker logs --tail 200 "$name" >&2 2>&1 || true
    docker inspect --format '{{json .State.Health}}' "$name" >&2 2>&1 || true
    echo "::endgroup::" >&2
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$state" "$models" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

fail() { echo "smoke: FAIL: $*" >&2; exit 1; }
ok() { echo "smoke: ok: $*"; }

docker volume create "$state" >/dev/null
docker volume create "$models" >/dev/null
# The same hardening as deploy/compose.yaml.
docker run -d --name "$name" --init --read-only --tmpfs /tmp:size=64m,mode=1777,noexec,nosuid \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 1024 --memory 3g --stop-timeout 150 \
  -v "$state:/var/lib/plur1bus" -v "$models:/var/lib/plur1bus/models" \
  "${smoke_run_args[@]}" "$image" >/dev/null

# 1. health goes green
deadline=$((SECONDS + timeout_s))
while :; do
  h="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")"
  r="$(docker inspect --format '{{.State.Status}}' "$name")"
  [ "$r" = "running" ] || fail "container is $r"
  [ "$h" = "healthy" ] && break
  [ "$SECONDS" -lt "$deadline" ] || fail "not healthy after ${timeout_s}s (health: $h)"
  sleep 3
done
ok "healthy"

# 2. the CLI in the container
version="$(docker exec "$name" plur1bus --version)"
echo "$version" | grep -Eq '^plur1bus [0-9]+\.[0-9]+\.[0-9]+' || fail "unexpected --version: $version"
if [ -n "$expected" ]; then [ "$version" = "plur1bus $expected" ] || fail "version $version, expected $expected"; fi
ok "$version"

# 3. security properties
[ "$(docker inspect --format '{{.Config.User}}' "$name")" = "10001:10001" ] || fail "not running as 10001:10001"
[ "$(docker exec "$name" id -u)" = "10001" ] || fail "uid is not 10001"
[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$name")" = "true" ] || fail "root fs not read-only"
docker exec "$name" sh -c 'touch /usr/local/smoke 2>/dev/null' && fail "wrote to the read-only root fs"
docker exec "$name" sh -c 'touch /var/lib/plur1bus/smoke && rm /var/lib/plur1bus/smoke' || fail "state volume is not writable"
[ "$(docker exec "$name" printenv PLUR1BUS_CONTAINER)" = "1" ] || fail "PLUR1BUS_CONTAINER is not 1"
ok "non-root, read-only root, state writable"

# 4. no secrets in layers or environment
history="$(docker history --no-trunc --format '{{.CreatedBy}}' "$image")"
if [ -n "${GH_ENGINE_READ_TOKEN:-}" ] && { echo "$history"; docker inspect "$image"; } | grep -qF -- "$GH_ENGINE_READ_TOKEN"; then
  fail "the engine token appears in the image metadata"
fi
if docker inspect --format '{{json .Config.Env}}' "$image" | grep -Eiq 'token|secret|password'; then fail "secret-looking image ENV"; fi
ok "no secrets in image metadata"

# 5. clean stop within the budget
docker stop --time 150 "$name" >/dev/null
code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
[ "$code" = "0" ] || fail "stopped with exit code $code"
ok "clean stop"
echo "smoke: all checks passed"
