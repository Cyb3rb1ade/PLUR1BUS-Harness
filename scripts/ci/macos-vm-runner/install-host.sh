#!/bin/bash
# Installs the host half of the self-hosted macOS runner for the current user (docs/ci.md, "Self-hosted macOS runner"):
# copies orchestrator.sh and registers a LaunchAgent that keeps it running while this user is logged in. Running it
# again replaces both and restarts the orchestrator. PLUR1BUS_RUNNER_VM names the template VM (default `macOS`).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
vm=${PLUR1BUS_RUNNER_VM:-macOS}
label=com.plur1bus.ci-runner
dest="$HOME/Library/Application Support/plur1bus-ci-runner"
plist="$HOME/Library/LaunchAgents/$label.plist"
logfile="$HOME/Library/Logs/plur1bus-ci-runner.log"

command -v prlctl >/dev/null || { echo "install-host: prlctl not found (Parallels Desktop Pro or Business)" >&2; exit 1; }
command -v gh >/dev/null || { echo "install-host: gh not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "install-host: gh is not logged in" >&2; exit 1; }
prlctl list -i "$vm" >/dev/null 2>&1 || { echo "install-host: no Parallels VM called $vm" >&2; exit 1; }

install -d -m 0700 "$dest" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 0700 "$here/orchestrator.sh" "$dest/orchestrator.sh"
path="$(dirname "$(command -v gh)"):$(dirname "$(command -v prlctl)"):/usr/bin:/bin:/usr/sbin:/sbin"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$dest/orchestrator.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$path</string>
    <key>PLUR1BUS_RUNNER_VM</key>
    <string>$vm</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>$logfile</string>
  <key>StandardErrorPath</key>
  <string>$logfile</string>
</dict>
</plist>
EOF
plutil -lint "$plist" >/dev/null
# A running orchestrator needs a moment to delete its clone and reset the variable; bootstrapping before it is gone
# fails with "Input/output error".
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
for _ in $(seq 90); do
  launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break
  sleep 1
done
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "install-host: $label is running; log: $logfile"
echo "install-host: stop it with: launchctl bootout gui/$(id -u)/$label"
