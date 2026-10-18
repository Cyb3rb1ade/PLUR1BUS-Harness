# SSH S0 research executable

This package measures `russh` against a real embedded SSH server on ephemeral
loopback sockets. No desktop product package depends on it. It never reads the
personal SSH agent, keys, keychain, runtime or configuration. Keys, passwords and
passphrases are generated per run; only public known_hosts data touches a temporary
directory. The test agent uses its own Unix socket.

Run from the repository root, after building the desktop UI:

```sh
cargo run --locked --release --manifest-path apps/desktop/Cargo.toml -p plur1bus-ssh-spike
cargo test --offline --locked --manifest-path apps/desktop/Cargo.toml -p plur1bus-ssh-spike -- --nocapture
cargo deny --locked --manifest-path apps/desktop/transport-spike/Cargo.toml check
node --test apps/desktop/transport-spike/dependency-policy.test.mjs apps/desktop/transport-spike/known-gaps.test.mjs
```

The executable checks a rejected host pin before any authentication, wrong
password refusal, 20 password connections, Ed25519 and ECDSA P-256 login,
passphrase-encrypted Ed25519 decoding/login, agent login on Unix, read-only
known_hosts lookup, PTY request, separate exec output/exit status, and 50 MiB
SFTP upload with server-side digest and complete readback. The fixture runs SSH
and SFTP framing, not mocked client responses. PTY request acceptance is not
an OS terminal or sudo acceptance test. Output contains steps and public metrics.

Pins: `russh =0.64.1` with only `ring`; `russh-sftp =2.1.1`; `rand =0.10.3`.
Key parsing, known_hosts and agent support are part of `russh::keys`; no separate
legacy key crate is needed. The SFTP version is the compatible line for the
desktop's existing exact `chrono =0.4.42`; newer SFTP lines require a coordinated
chrono/serde upgrade. Full dependency and acceptance evidence is in
[the S0 report](../../../docs/handoff/status/2026-10-18-dssh-s0.md).

**S0 is partial, WP1 blocked.** Direct RSA requires a dependency with unresolved
RUSTSEC-2023-0071, so it is absent. No audit suppression or RSA feature is added.
The whole desktop audit and the other platform/OpenSSH/proxy checks are separate
gates. Metrics measure this fixture, not LAN, installed desktop size or real
remote installation. `--no-default-features` builds a minimal size baseline.
