# SSH S0 research executable

This package measures `russh` against a real embedded SSH server on ephemeral
loopback sockets. No desktop product package depends on it. It never reads the
personal SSH agent, keys, keychain, runtime or configuration. Keys, passwords and
passphrases are generated per run. The embedded fixture writes only public known_hosts data.
The separate OpenSSH interoperability fixture creates private keys in an owner-only
temporary directory for external OpenSSH processes and deletes them after use; Rust
receives public metadata only. Both agents use isolated Unix sockets.

Run from the repository root, after building the desktop UI:

```sh
cargo run --locked --release --manifest-path apps/desktop/Cargo.toml -p plur1bus-ssh-spike
cargo test --offline --locked --manifest-path apps/desktop/Cargo.toml -p plur1bus-ssh-spike -- --nocapture
cargo deny --locked --manifest-path apps/desktop/transport-spike/Cargo.toml check
node --test apps/desktop/transport-spike/dependency-policy.test.mjs apps/desktop/transport-spike/known-gaps.test.mjs
# Unix, OpenSSH sshd/agent/add/keygen installed; no personal keys or agent:
node apps/desktop/scripts/ssh-rsa-agent-spike.mjs
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

**RSA in v1 is agent-only (owner 2026-10-18).** Both SHA-2 RSA variants and
subsequent authenticated exec pass against an isolated OpenSSH 10.5 server and
agent. The Rust example reads only `.pub` files and connects to the fixture socket;
external `ssh-keygen`/`ssh-add`/`ssh-agent` generate/load/sign the RSA key. The
entire desktop graph excludes the `rsa` crate, even for public operations. No
advisory suppression or RSA feature is added. Host-key pinning compares key data,
not the mutable OpenSSH comment. The host key in this probe is Ed25519.

`direct_key_policy` refuses RSA file authentication with stable
`rsa-direct-unsupported` and the owner-selected action hint; the existing direct
Ed25519/ECDSA path uses the guard. UI integration remains WP3, as specified.
Direct RSA is a future TODO after a Marvin-safe version or audited backend;
it is no longer a v1 gate.

**S0 is still partial.** Whole-desktop audit and other platform/OpenSSH-version/
proxy checks remain separate gates. Metrics measure this fixture, not LAN,
installed desktop size or real remote installation. `--no-default-features`
builds a minimal size baseline.
