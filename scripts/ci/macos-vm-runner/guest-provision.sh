#!/bin/bash
# Prepares the template VM of the self-hosted macOS runner (docs/ci.md, "Self-hosted macOS runner"). Run it as root
# inside the template while the orchestrator is stopped, from the host:
#   prlctl exec "<vm>" "cat > /var/root/guest-provision.sh" < guest-provision.sh
#   prlctl exec "<vm>" "/bin/bash /var/root/guest-provision.sh"
# then shut the template down. It is idempotent. Everything it installs ends up in the template that every job's clone
# starts from, so it holds only what the routed jobs need.
set -euo pipefail

RUNNER_USER=ghrunner
RUNNER_HOME=/Users/$RUNNER_USER
RUNNER_VERSION=2.338.2
RUNNER_SHA256=25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388
RUST_TOOLCHAIN=1.95
CARGO_DENY_VERSION=0.20.2
# The Parallels shared network's DNS server, the one host address a job may reach.
GUEST_DNS=10.211.55.1

[ "$(id -u)" = 0 ] || { echo "guest-provision: run as root" >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "guest-provision: expected an arm64 guest" >&2; exit 1; }

# The unprivileged account every job runs as: no admin rights, hidden, with a password nobody knows.
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  sysadminctl -addUser "$RUNNER_USER" -fullName "GitHub Actions runner" -shell /bin/zsh -home "$RUNNER_HOME" \
    -password "$(openssl rand -base64 32)"
  createhomedir -c -u "$RUNNER_USER" >/dev/null
fi
dscl . -create "/Users/$RUNNER_USER" IsHidden 1
if dseditgroup -o checkmember -m "$RUNNER_USER" admin >/dev/null 2>&1; then
  echo "guest-provision: $RUNNER_USER must not be an administrator" >&2
  exit 1
fi

# Command Line Tools: git, clang and make for checkout and native builds.
if ! xcode-select -p >/dev/null 2>&1; then
  marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  touch "$marker"
  label=$(softwareupdate -l 2>/dev/null | sed -n 's/^\* Label: \(Command Line Tools for Xcode.*\)$/\1/p' | sort -V | tail -1)
  [ -n "$label" ] || { rm -f "$marker"; echo "guest-provision: no Command Line Tools offered" >&2; exit 1; }
  softwareupdate -i "$label" --verbose </dev/null
  rm -f "$marker"
fi

# A template that changes itself would defeat the reset: no Spotlight indexing, no automatic updates, no sleep.
mdutil -a -i off >/dev/null
softwareupdate --schedule off >/dev/null
for key in AutomaticDownload AutomaticallyInstallMacOSUpdates ConfigDataInstall CriticalUpdateInstall; do
  defaults write /Library/Preferences/com.apple.SoftwareUpdate "$key" -bool false
done
defaults write /Library/Preferences/com.apple.commerce AutoUpdate -bool false
pmset -a sleep 0 displaysleep 0 disksleep 0 powernap 0 >/dev/null

# Jobs reach the internet, never the host or the networks behind it. pf is off by default on macOS; the launch daemon
# enables it with this anchor at every boot, and plur1bus-runner-once refuses a job without it.
cat > /etc/pf.anchors/plur1bus.runner <<EOF
# Self-hosted CI runner: no job reaches the host, its LAN, a tailnet or link-local services (docs/ci.md).
table <plur1bus_private> const { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 }
pass out quick inet proto { udp, tcp } from any to $GUEST_DNS port 53
pass out quick inet proto udp from any port 68 to any port 67
block return out quick inet from any to <plur1bus_private>
block drop out quick inet from any to 224.0.0.0/4
pass out quick inet6 proto ipv6-icmp from any to any
block return out quick inet6 from any to { fc00::/7, fe80::/10 }
EOF
chmod 0644 /etc/pf.anchors/plur1bus.runner
if ! grep -qx 'anchor "plur1bus.runner"' /etc/pf.conf; then
  printf '%s\n' 'anchor "plur1bus.runner"' 'load anchor "plur1bus.runner" from "/etc/pf.anchors/plur1bus.runner"' >> /etc/pf.conf
fi
cat > /Library/LaunchDaemons/com.plur1bus.pf.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.plur1bus.pf</string>
  <key>ProgramArguments</key>
  <array>
    <string>/sbin/pfctl</string>
    <string>-E</string>
    <string>-f</string>
    <string>/etc/pf.conf</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
chmod 0644 /Library/LaunchDaemons/com.plur1bus.pf.plist
launchctl bootout system/com.plur1bus.pf 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/com.plur1bus.pf.plist
for _ in 1 2 3 4 5; do
  /sbin/pfctl -s info 2>/dev/null | grep -q '^Status: Enabled' && break
  sleep 1
done
/sbin/pfctl -a plur1bus.runner -s rules 2>/dev/null | grep -q '^block' || { echo "guest-provision: pf anchor not loaded" >&2; exit 1; }

# The pinned runner, checked against its published SHA-256.
installed=$("$RUNNER_HOME/actions-runner/bin/Runner.Listener" --version 2>/dev/null || true)
if [ "$installed" != "$RUNNER_VERSION" ]; then
  sudo -u "$RUNNER_USER" -H /bin/bash -euo pipefail -c '
    rm -rf "$HOME/actions-runner" && mkdir -p "$HOME/actions-runner" && cd "$HOME/actions-runner"
    curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v$1/actions-runner-osx-arm64-$1.tar.gz"
    echo "$2  runner.tar.gz" | shasum -a 256 -c -
    tar xzf runner.tar.gz && rm runner.tar.gz
  ' provision "$RUNNER_VERSION" "$RUNNER_SHA256" </dev/null
fi

# The per-job entry point the host's orchestrator calls.
install -d -o root -g wheel -m 0755 /usr/local/libexec
cat > /usr/local/libexec/plur1bus-runner-once <<'EOF'
#!/bin/bash
# Runs exactly one GitHub Actions job as the unprivileged user ghrunner. The host's orchestrator calls it through
# `prlctl exec` with a single-use just-in-time runner configuration on stdin and deletes this clone of the template
# afterwards, with every change the job made (docs/ci.md, "Self-hosted macOS runner").
set -euo pipefail
umask 077

# No job without the LAN block.
/sbin/pfctl -s info 2>/dev/null | grep -q '^Status: Enabled' || { echo "plur1bus-runner-once: pf is not enabled" >&2; exit 3; }
/sbin/pfctl -a plur1bus.runner -s rules 2>/dev/null | grep -q '^block' || { echo "plur1bus-runner-once: anchor plur1bus.runner is not loaded" >&2; exit 3; }

IFS= read -r ACTIONS_RUNNER_INPUT_JITCONFIG || true
[ -n "${ACTIONS_RUNNER_INPUT_JITCONFIG:-}" ] || { echo "plur1bus-runner-once: no runner configuration on stdin" >&2; exit 2; }
export ACTIONS_RUNNER_INPUT_JITCONFIG

# The runner reads its configuration from this variable and removes it from its own environment, so the configuration
# is on no command line and never reaches a job.
cd /Users/ghrunner/actions-runner
exec /usr/bin/sudo --preserve-env=ACTIONS_RUNNER_INPUT_JITCONFIG -u ghrunner -H -- /usr/bin/env \
  PATH=/Users/ghrunner/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  /Users/ghrunner/actions-runner/run.sh </dev/null
EOF
chown root:wheel /usr/local/libexec/plur1bus-runner-once
chmod 0755 /usr/local/libexec/plur1bus-runner-once

# The Rust toolchain the routed workflows pin, and cargo-deny, which `quality` would otherwise compile on every run.
sudo -u "$RUNNER_USER" -H /bin/bash -euo pipefail -c '
  if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$1"
  fi
  "$HOME/.cargo/bin/rustup" toolchain install "$1" --profile minimal
  "$HOME/.cargo/bin/rustup" default "$1"
  "$HOME/.cargo/bin/cargo" install cargo-deny --version "$2" --locked
  rm -rf "$HOME/.cargo/registry" "$HOME/.cargo/git"
' provision "$RUST_TOOLCHAIN" "$CARGO_DENY_VERSION" </dev/null

echo "guest-provision: done (runner $RUNNER_VERSION, Rust $RUST_TOOLCHAIN, cargo-deny $CARGO_DENY_VERSION)"
