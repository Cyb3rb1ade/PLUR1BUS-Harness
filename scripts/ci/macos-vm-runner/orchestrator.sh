#!/bin/bash
# Host half of the self-hosted macOS runner (docs/ci.md, "Self-hosted macOS runner"). For each job it clones the stopped
# template VM, hands the clone a single-use just-in-time runner configuration, waits until the job is done and deletes
# the clone, so no job sees what an earlier one left behind. Parallels' rollback mode (--undo-disks) is no substitute:
# it is accepted but has no effect on macOS guests. install-host.sh registers this script as a LaunchAgent; stopping it
# routes the macOS jobs back to GitHub-hosted runners.
set -uo pipefail

TEMPLATE=${PLUR1BUS_RUNNER_VM:-macOS}
CLONE=${PLUR1BUS_RUNNER_CLONE:-plur1bus-runner}
REPO=${PLUR1BUS_RUNNER_REPO:-Cyb3rb1ade/PLUR1BUS-Harness}
LABEL=plur1bus-macos-vm
VARIABLE=MACOS_SELF_HOSTED
PRLCTL=${PRLCTL:-prlctl}
GH=${GH:-gh}
# After this many failed attempts in a row the jobs go back to GitHub-hosted runners until a runner starts again.
FAILURE_LIMIT=3

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
pause() { sleep "$1" & wait $!; } # `wait` lets the signal trap run at once

routed=false
route() { # true: to the VM, false: to GitHub-hosted runners
  if "$GH" variable set "$VARIABLE" --repo "$REPO" --body "$1" >/dev/null 2>&1; then
    routed=$1
    log "$VARIABLE=$1"
  else
    log "could not set $VARIABLE=$1"
  fi
}

discard_clone() {
  "$PRLCTL" stop "$CLONE" --kill >/dev/null 2>&1
  "$PRLCTL" delete "$CLONE" >/dev/null 2>&1
  ! "$PRLCTL" status "$CLONE" >/dev/null 2>&1
}

runner_id=
forget_runner() { # an ephemeral runner removes itself after its job; this cleans up after one that never got one
  [ -n "$runner_id" ] && "$GH" api -X DELETE "repos/$REPO/actions/runners/$runner_id" >/dev/null 2>&1
  runner_id=
}

child=
shutdown() {
  log "stopping"
  [ -n "$child" ] && kill "$child" 2>/dev/null
  discard_clone
  forget_runner
  route false
  exit 0
}
trap shutdown TERM INT HUP

failures=0
fail() {
  log "$1"
  failures=$((failures + 1))
  if [ "$failures" -ge "$FAILURE_LIMIT" ] && [ "$routed" = true ]; then route false; fi
  discard_clone
  forget_runner
  pause 60
}

# The template is cloned while it is stopped; a running template would hand every job its current state.
if [ "$("$PRLCTL" status "$TEMPLATE" 2>/dev/null | awk '{print $NF}')" != stopped ]; then
  log "template VM $TEMPLATE is missing or not stopped; not starting"
  exit 0
fi

# The runner is useless while the Mac sleeps; on AC power keep it awake for as long as this script runs.
if [ "${PLUR1BUS_RUNNER_CAFFEINATE:-1}" != 0 ]; then caffeinate -s -w $$ & fi

log "orchestrator for $REPO started: template $TEMPLATE, clone $CLONE"
while :; do
  if ! discard_clone; then fail "could not delete the previous clone $CLONE"; continue; fi
  if ! "$PRLCTL" clone "$TEMPLATE" --name "$CLONE" >/dev/null 2>&1; then fail "could not clone $TEMPLATE"; continue; fi
  if ! "$PRLCTL" start "$CLONE" >/dev/null 2>&1; then fail "could not start $CLONE"; continue; fi

  # The guest tools answer (they do not with `--isolate-vm on`) and the guest reaches GitHub through the pf rules.
  ready=false
  for _ in $(seq 60); do
    if "$PRLCTL" exec "$CLONE" "/usr/bin/curl -fsS -o /dev/null --max-time 5 https://api.github.com/" >/dev/null 2>&1; then
      ready=true
      break
    fi
    pause 5
  done
  if [ "$ready" != true ]; then fail "$CLONE did not answer prlctl exec or reach GitHub within five minutes"; continue; fi
  pause 10 # right after boot `prlctl exec` with stdin sometimes fails with "PrlJob_GetRetCode: Invalid argument"

  name="plur1bus-vm-$(date -u +%Y%m%d%H%M%S)"
  if ! config=$("$GH" api -X POST "repos/$REPO/actions/runners/generate-jitconfig" \
      -f name="$name" -F runner_group_id=1 -f work_folder=_work \
      -f 'labels[]=self-hosted' -f 'labels[]=macOS' -f 'labels[]=ARM64' -f "labels[]=$LABEL" \
      --jq '[.runner.id, .encoded_jit_config] | @tsv' 2>/dev/null) || [ -z "$config" ]; then
    fail "could not create a runner configuration"
    continue
  fi
  runner_id=${config%%$'\t'*}
  [ "$routed" = true ] || route true
  log "runner $name ($runner_id) is waiting for a job"

  printf '%s\n' "${config#*$'\t'}" | "$PRLCTL" exec "$CLONE" /usr/local/libexec/plur1bus-runner-once &
  child=$!
  unset config
  wait "$child"
  rc=$?
  child=
  log "runner $name finished with exit code $rc"
  forget_runner
  if [ "$rc" = 0 ]; then failures=0; else fail "runner $name failed"; fi
done
