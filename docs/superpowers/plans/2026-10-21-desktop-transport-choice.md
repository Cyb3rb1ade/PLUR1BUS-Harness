# Desktop transport choice (Tailscale / direct): implementation plan

**Goal.** Remote connections (on `main` today) and SSH host profiles (SSH WP2/WP3) record the person's free choice
*Über Tailscale* or *Direkt*; public direct targets get a banner with explicit confirmation, Tailscale targets a
reachability check, entered ranges a public-space notice, and every connection goes only to the addresses that were
checked. Specified in [`2026-10-21-desktop-transport-choice-design.md`](../specs/2026-10-21-desktop-transport-choice-design.md)
(cited as "spec §n").
**Architecture.** A pure Rust classifier crate `plur1bus-desktop-net` (mirror of `packages/core/src/tools/web/ip.ts`,
shared vector file); a `transport` module in `src-tauri` (host validation, OS resolver with timeout, target check,
Tailscale CLI check, TCP probe, sidecar store `connection-transport.json`); pinned connect sets in `client.rs` and the
SPA proxy; UI chooser, banners and chips; a harness-side `remote.allowSubnets` notice in TypeScript.
**Status.** Owner decisions 2026-10-21 binding (D113 amendment). T0–T5 can start now and do not wait for SSH S0/WP1.
T6 lands together with SSH WP1/WP2/WP3/WP5. Seven owner questions (spec §12) have recommendations; none blocks T0–T4.
**Executor.** The controller with Claude agents (owner 2026-10-21), not Codex. One branch and one ready PR per package
(`claude/transport-t0-vectors`, `…-t1-net`, `…-t2-check`, `…-t3-tailscale`, `…-t4-remote`, `…-t5-allowlist`,
`…-t6-ssh`), each from fresh `origin/main` or stacked on its predecessor with `Stacked on #N`.
**Constraints.** `AGENTS.md` desktop rules: exact-pinned direct dependencies, `--locked`, no shell/fs/http/dialog/opener
plugins, native commands in `SHELL_COMMANDS` with label/origin checks and closed structs, no tokens in JS or files,
scratch state and injected seams in tests, no real keychain, no personal runtime, **no real Tailscale state in CI or
in committed fixtures**. Desktop Green gate. No change to `remote.publish`, Funnel, pairing policy, origin rules, pins
or the SSH host-key policy. The SSRF guard's verdicts must not change (T0). No CI polling, force-push, rebase, amend
or stash. Commit identity `Cyb3rb1ade <cyb3rblade@me.com>` with model and session trailers.

## Tray finding (asked 2026-10-21)

**"Switch connection" in the tray is not built on `main` (`e004e5fe`).** Desktop spec §6.3
(`2026-09-27-desktop-app-design.md:335`) lists "Tray/menubar: … open, start/stop harness, switch connection, quit";
the D1 plan's Task 14 (`plans/2026-09-27-desktop-app-d1.md:695`) already narrowed the menu to a *Connections…* entry.
The code follows the plan: `apps/desktop/src-tauri/src/native.rs:583` `tray_menu` builds header, *Open*, *Start/Stop
harness* (bundled only), *Start runtime* (macOS), *Update…*, **one `connections` item** (`native.rs:619–625`, text
`tray.rs:148` „Verbindungen…“ / `tray.rs:157` “Connections…”), *Settings…*, *Quit*; the handler maps it to
`navigate_shell(app, "#/connections")` (`native.rs:677`). No per-connection entries, no submenu, no switch.
Side finding: *Start harness* / *Stop harness* are created disabled (`native.rs:597–603`, `604–610`, `enabled = false`),
nothing enables them, and `on_menu_event` (`native.rs:675–684`) has no arm for either id. Both are outside this plan;
T4 only adds the path label to the tray header so a future switch submenu can reuse it (spec §7.3).

## Review focus

1. **No relaxation:** no verdict (private, tailnet, peer online) ever changes TLS verification, pins, `pair-proof`,
   `installationId` or host-key handling. Grep the diff for any branch on `Category`/`TailscaleState` inside trust code.
2. **Check-then-connect on one address set:** after `check_target` nothing resolves the host again for that open —
   reqwest clients carry `resolve_to_addrs`, the WebSocket path connects a `TcpStream` to a checked address, the SSH
   session gets `SocketAddr`s. Reconnects call `check_target` again and never acknowledge on their own.
3. **Tailscale exec:** absolute candidate paths only, ownership/writability checks, argv exactly `["status","--json"]`,
   no shell, cleared environment with the allow-list, timeout, stdout/stderr caps, `kill_on_drop`.
4. **Privacy:** the status JSON is parsed into the minimal view, never logged, persisted, cached beyond 10 s or sent to
   the webview; logs carry codes only, no addresses.
5. **R10:** `connections.json` byte-identical through every T4 operation; sidecar tolerant (unknown fields kept,
   newer version read-only, corrupt sidecar isolated); old builds unaffected.
6. **Parity:** classifier id, table and every vector identical in TS and Rust; snapshot `iana-special-2025-10-09`.
7. **Notices, not blocks:** the only refusals are invalid input (§8 of the spec); every banner has text, not colour
   alone; DE uses *du*; `node scripts/check-i18n.mjs` passes.
8. **IPC:** new commands only in `SHELL_COMMANDS`, closed structs with `deny_unknown_fields`, inputs limited to host,
   port, enums, ids; no new Tauri plugin.

## Dependencies and order

```text
T0 vectors + ip.ts constants (TS) ──► T1 net crate (Rust) ──► T2 resolver/check/store ──► T4 remote connections + UI + tray
          │                                    └──────────► T3 Tailscale check + probe ──┘            │
          └──► T5 harness allowSubnets notice (TS, SPA, 1staid)                                         │
SSH: S0 ─► WP1 ──► WP2 ──► WP3 ──► WP4 ──► WP6                                                       ▼
            └──── T6 (with WP1 interface, WP2 schema, WP3 wizard, WP5 connect) ◄──────────────────── T2+T3+T4
T7 docs, status record, manual Mac/Windows passes (after T4; again after T6)
```

**Before the SSH client exists (now):** T0–T5 — the classifier, the shared vectors, the Tailscale check and the
direct/Tailscale choice with banners, confirmation and pinned connect for the **existing remote connection**, plus the
harness range notice. **With SSH WP2/WP3:** the `ssh-hosts.json` v1 fields and the wizard step (T6a/T6c); **with WP1:**
`SessionConfig` takes checked addresses (T6b); **with WP5:** re-check on connect/reconnect of the tunnel (T6d). If WP2
starts before T6, it must already include `transport` and `publicAck` in v1 (spec §3.3).

---

## T0 — Shared vectors and TS registry constants (≈ 1 agent day)

**Purpose.** Make `ip.ts` the documented TS side of the contract without changing a single SSRF verdict.

**Files.**
- `packages/core/src/tools/web/ip.ts` — add, keep everything else byte-for-byte in behaviour:
  ```ts
  export const IANA_SPECIAL_REGISTRY = {
    id: "iana-special-2025-10-09",
    ipv4: { url: "https://www.iana.org/assignments/iana-ipv4-special-registry/", updated: "2025-10-09" },
    ipv6: { url: "https://www.iana.org/assignments/iana-ipv6-special-registry/", updated: "2025-10-09" },
  } as const;
  export function classificationTable(): ReadonlyArray<{ readonly cidr: string; readonly reason: string }>; // evaluation order
  export function cidrContainsPublic(c: Cidr): ParsedAddress | null; // lowest public address or null (spec §4.5)
  ```
  `addV4`/`addV6` keep the literal CIDR string so `classificationTable()` returns exactly what was registered.
- `packages/core/test/fixtures/net/ip-classification-vectors.json` — new, hand-committed, shape of spec §4.6; at least:
  every `ip.test.ts` case; first and last address of every table row plus the outside neighbours (`172.15.255.255`,
  `172.32.0.0`, `100.63.255.255`, `100.128.0.0`, `192.167.255.255`, `192.169.0.0`); the *Globally Reachable = True*
  rows that are public (`192.31.196.1`, `192.52.193.1`, `192.175.48.1`, `2620:4f:8000::1`) and the conservative ones
  that are not (`192.0.0.9`, `192.0.0.10`, `2001:1::1`, `2001:3::1`, `2001:20::1`); `5f00::1`, `100:0:0:1::1`,
  `3fff::1`, `64:ff9b:1::1`, Teredo `2001:0:4136:e378:8000:63bf:3fff:fdd2`; NAT64/6to4 public and private
  (`64:ff9b::808:808`, `2002:808:808::1`, `2002:a00:1::1`); Tailscale `100.100.100.100`, `100.64.0.1`,
  `100.127.255.254`, `fd7a:115c:a1e0::1`, `fd7a:115c:a1e1::1` (outside the /48 → `private`); all legacy spellings;
  all rejects; the CIDR rows of spec §4.5. `canonical` values are compared as bytes, not strings.
- `packages/core/test/tools/web/ip-vectors.test.ts` — new.

**Tests (TDD, write first).**
- `vectors: classifier id equals IANA_SPECIAL_REGISTRY.id`
- `vectors: classificationTable() equals table row by row`
- `vectors: every address row (public, reason, canonical bytes)`, `…parse rejects`, `…strict rejects`
- `vectors: cidrContainsPublic for every cidr row`; `cidrContainsPublic never returns a non-public address` (sweep all
  `/8` IPv4 ranges and 4096 random IPv6 /32s against `classifyAddress`)
- unchanged: `ip.test.ts`, `ssrf-matrix.test.ts`, `guard.test.ts` green without edits.

**Acceptance.** `pnpm test` (core), `pnpm lint`, `pnpm docs:check` green; `git diff` shows no change to any range
literal or to `classifyAddress`/`parseAddress`/`parseCidr`/`inCidr` bodies.

---

## T1 — Rust classifier crate `plur1bus-desktop-net` (≈ 2 agent days)

**Purpose.** The Rust counterpart, std-only, usable by `src-tauri` and later the SSH crate.

**Files.**
- `apps/desktop/net/Cargo.toml` — new workspace member (`apps/desktop/Cargo.toml` `members`, `Cargo.lock`); no runtime
  dependencies; dev-dependencies `serde`/`serde_json` at the workspace's existing exact versions.
- `apps/desktop/net/src/lib.rs` (`#![forbid(unsafe_code)]`), `parse.rs`, `classify.rs`, `cidr.rs`, `category.rs`:
  ```rust
  pub const CLASSIFIER_ID: &str = "iana-special-2025-10-09";
  pub struct Registry { pub url: &'static str, pub updated: &'static str }
  pub const IANA_IPV4_SPECIAL: Registry; pub const IANA_IPV6_SPECIAL: Registry;
  pub fn parse_address(input: &str, strict: bool) -> Option<std::net::IpAddr>;   // == parseAddress (legacy inet_aton forms when !strict)
  pub fn canonical(a: IpAddr) -> IpAddr;                                          // IPv4-mapped → IPv4
  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum Reason { Unspecified, Private, SharedAddressSpace, Loopback, LinkLocal, CloudMetadata, Reserved, Multicast }
  impl Reason { pub fn as_str(self) -> &'static str }                            // the ip.ts strings
  #[derive(Clone, Copy, Debug, PartialEq, Eq)] pub struct Verdict { pub public: bool, pub reason: Option<Reason> }
  pub fn classify(a: IpAddr) -> Verdict;                                          // == classifyAddress
  #[derive(Clone, Copy, Debug, PartialEq, Eq)] pub struct Cidr { pub addr: IpAddr, pub prefix: u8 }
  pub fn parse_cidr(input: &str) -> Option<Cidr>;                                 // == parseCidr (strict)
  pub fn in_cidr(a: IpAddr, c: &Cidr) -> bool;                                    // == inCidr
  pub fn cidr_first_public(c: &Cidr) -> Option<IpAddr>;                           // == cidrContainsPublic
  pub fn table() -> &'static [(&'static str, Reason)];
  #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
  pub enum Category { Loopback, Tailnet, Private, Special, Public }               // Ord = aggregation order (spec §4.3)
  #[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum AddrClass { Connectable(Category), NotConnectable }
  pub fn is_tailnet(a: IpAddr) -> bool;                                           // 100.64.0.0/10, fd7a:115c:a1e0::/48
  pub fn target_class(a: IpAddr) -> AddrClass;
  pub fn aggregate<I: IntoIterator<Item = Category>>(it: I) -> Option<Category>;
  ```
- `apps/desktop/net/tests/parity.rs` — reads
  `include_str!("../../../../packages/core/test/fixtures/net/ip-classification-vectors.json")` (the `test-bins`
  precedent includes repo files the same way).

**Tests (TDD).**
- `parity_classifier_id`, `parity_table`, `parity_addresses`, `parity_parse_rejects`, `parity_strict_rejects`,
  `parity_cidrs`, `parity_categories` (the Rust-only `categories` rows).
- `aggregate_any_public_wins`, `aggregate_empty_is_none`, `not_connectable_unspecified_multicast_broadcast`.
- `tailnet_bounds` (`100.63.255.255` no, `100.64.0.0` yes, `100.127.255.255` yes, `100.128.0.0` no;
  `fd7a:115c:a1e0:ffff::1` yes, `fd7a:115c:a1e1::` no).
- `no_panic_on_arbitrary_input` — 200 000 deterministic xorshift strings (ASCII, digits, `.:[]%/x`, non-ASCII) into
  `parse_address`/`parse_cidr`; no panic, no allocation blow-up.
- `cidr_first_public_is_public_and_minimal` — for each vector range, the result classifies public and the address
  just below it (if inside the range) does not.

**Acceptance.** Desktop Green on the workspace; crate has no `[dependencies]`; parity test runs on all five CI targets
(it is part of `cargo test --workspace`).

---

## T2 — Host validation, resolver, target check, sidecar store (≈ 2 agent days)

**Purpose.** One function decides category, hints and the connect set; one store keeps the choice without touching
`connections.json`.

**Files.**
- `apps/desktop/src-tauri/Cargo.toml` — path dependency on `plur1bus-desktop-net`.
- `apps/desktop/src-tauri/src/transport/mod.rs`:
  ```rust
  #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)] #[serde(rename_all = "lowercase")]
  pub enum Transport { Tailscale, Direct }
  #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)] #[serde(rename_all = "kebab-case")]
  pub enum Purpose { Remote, Ssh, SshJump }
  pub struct TargetInput { pub host: HostInput, pub port: u16, pub transport: Transport, pub purpose: Purpose }
  pub struct ConnectPin { pub host: String, pub addrs: Vec<std::net::SocketAddr> }      // what clients must use
  pub struct CheckedTarget { pub pin: ConnectPin, pub report: TransportReport }
  pub struct CheckDeps { pub resolver: Arc<dyn Resolver>, pub tailscale: Arc<dyn TailscaleSource>, pub prober: Arc<dyn Prober> }
  pub async fn check_target(input: &TargetInput, deps: &CheckDeps, probe: bool) -> Result<CheckedTarget, TransportError>;
  pub fn gate(report: &TransportReport, ack: Option<&PublicAck>) -> Result<(), TransportError>; // ConfirmNeeded
  pub enum TransportError { NotConnectable, NonCanonicalIpv4, Unresolved, DnsTimeout, ConfirmNeeded, Busy }
  impl TransportError { pub fn code(&self) -> &'static str }                            // spec §8
  ```
- `src/transport/host.rs` — `HostInput::parse(&str) -> Result<HostInput, TransportError>` (spec §4.4: `url::Host`
  for IDNA/punycode, LDH labels, ≤ 253 bytes, canonical IPv4, IPv6 with or without brackets, no zone id,
  `localhost`); `HostInput::from_origin(&Origin) -> (HostInput, u16)`.
- `src/transport/resolve.rs` — `trait Resolver { fn lookup<'a>(&'a self, host: &'a str, port: u16) -> BoxFuture<'a,
  Result<Vec<SocketAddr>, ResolveError>>; }`; `OsResolver` = `tokio::net::lookup_host` under a 5 s
  `tokio::time::timeout`, ≤ 32 addresses, de-duplicated.
- `src/transport/report.rs` — `TransportReport { category: Option<Category>, addresses: Vec<String> /* ≤ 8 */, hints:
  Vec<Hint>, tailscale: Option<TailscaleView>, needs_public_ack: bool, classifier: &'static str }`,
  `Hint { code: &'static str, severity: Severity, params: BTreeMap<&'static str, String> }` (params `host`,
  `address`, `addresses`, `peer`, `port`, `range`, `example`, `suggestion`), `Serialize` camelCase.
- `src/transport/store.rs` — `TransportStore::open(dir)` on `connection-transport.json`;
  `get(id) -> Option<TransportEntry>`, `effective(&Connection) -> TransportEntry` (derived default, spec §3.2),
  `set(id, TransportEntry)`, `remove(id)`, `gc(&[Uuid])`, `mode() -> StoreMode { ReadWrite, ReadOnlyNewer }`;
  `TransportEntry { transport, public_ack: Option<PublicAck>, #[serde(flatten)] extra: serde_json::Map<String,
  Value> }`; atomic write `0600`, ≤ 1 MiB, `.corrupt-<ms>-<uuid>` for the sidecar only.
- `src/lib.rs` — `mod transport;`.

**Tests (`apps/desktop/src-tauri/tests/`).**
- `transport_host.rs`: table — IDN → punycode, `127.1`/`0x7f000001`/`017700000001` → `host-ipv4-noncanonical`,
  `fe80::1%en0` refused, `[::1]` ok, label > 63, name > 253, `_` and spaces refused, `localhost` loopback.
- `transport_check.rs` (fake resolver/tailscale/prober): private only → `private`, no ack needed; public only →
  `target-public`, `needs_public_ack`; private+public → `target-mixed`; `0.0.0.0` only → `target-not-connectable`;
  `0.0.0.0` + private → private with a hint and `0.0.0.0` absent from `pin.addrs`; documentation range →
  `target-special`; resolver timeout → `target-dns-timeout`; NXDOMAIN → `target-unresolved`; `localhost` makes no
  resolver call; IP literal makes no resolver call; `pin.addrs` equals the classified set exactly;
  `transport=tailscale` + public target → `tailscale-not-tailnet-target` **and** `target-public`; `gate` with/without
  ack; ack + target still public → ok; no ack + public → `ConfirmNeeded`.
- `transport_store.rs`: `connections.json` byte-identical after set/remove/gc (hash before/after); missing entry →
  derived default (`https://nas.tail1234.ts.net` → tailscale, `https://100.101.1.2:7443` → tailscale,
  `https://harness.corp.example` → direct); unknown entry field survives a write; `version: 2` → `ReadOnlyNewer`,
  `set` refused, file untouched; garbage → sidecar renamed, connections untouched, defaults; entry for a
  bundled/local row refused; gc drops ids not in `connections.json`; POSIX mode `0600`.

**Acceptance.** Desktop Green; no I/O in `check_target` except through the injected traits; the store never opens
`connections.json` for writing.

---

## T3 — Tailscale check and TCP probe (≈ 3 agent days)

**Purpose.** Spec §5: verified "reachable over Tailscale" or a reasoned notice, with no user input in any argv.

**Files.**
- `src-tauri/src/transport/tailscale.rs`:
  ```rust
  pub trait TailscaleSource: Send + Sync { fn status(&self) -> BoxFuture<'_, TailscaleStatus>; }
  pub enum TailscaleStatus { NotInstalled, Unavailable(UnavailableWhy /* Spawn|Timeout|TooLarge|Unparseable|Flatpak */),
                             DaemonDown, NeedsLogin, Stopped, Running(TailnetView) }
  pub struct TailnetView { self_ips: Vec<IpAddr>, magic_suffix: Option<String>, peers: Vec<PeerView> }   // not Serialize
  struct PeerView { dns_name: String, host_name: String, ips: Vec<IpAddr>, online: bool, expired: bool, routes: Vec<Cidr> }
  pub enum PeerMatch { Peer { label: String, ips: Vec<IpAddr>, online: bool }, SelfNode, SubnetRoute { label: String, online: bool }, None }
  pub fn match_target(view: &TailnetView, host: &HostInput, addrs: &[IpAddr]) -> PeerMatch;
  pub fn candidates() -> Vec<PathBuf>;                         // spec §5.2, per cfg(target_os)
  pub fn usable(path: &Path) -> bool;                          // regular file / allowed symlink target, owner, mode, reparse point
  pub struct CliTailscale { cache: Mutex<Option<(Instant, Arc<TailscaleStatus>)>> }   // 10 s cache, one run in flight
  ```
  Exec: `tokio::process::Command::new(path).args(["status", "--json"])`, `env_clear()` + allow-list, stdin null,
  stdout ≤ 8 MiB, stderr ≤ 4 KiB, 4 s timeout, `kill_on_drop(true)`, Windows `CREATE_NO_WINDOW`. Windows candidate
  via `SHGetKnownFolderPath(FOLDERID_ProgramFiles)` (add the `Win32_UI_Shell` feature to the existing exact
  `windows-sys` pin; no new crate). `FLATPAK_ID` set → `Unavailable(Flatpak)` without spawning.
- `src-tauri/src/transport/probe.rs` — `trait Prober { fn probe<'a>(&'a self, addrs: &'a [SocketAddr]) ->
  BoxFuture<'a, ProbeOutcome>; }`, `ProbeOutcome { Connected { local: SocketAddr, remote: SocketAddr }, Refused,
  Timeout }`; `TcpProber`: ≤ 4 addresses, 3 s each, no bytes written, socket closed at once.
- `check_target` (T2) wiring: run when spec §5.1 applies; `*.ts.net`/short-name match → connect set = peer IPs and no
  resolver call; probe local address ∉ `self_ips` → `tailscale-route-mismatch`.
- Debug-only seams (DR19 style, refused in release): `PLUR1BUS_DESKTOP_TAILSCALE_STATUS=<file>` (fixture instead of the
  CLI) and `PLUR1BUS_DESKTOP_TAILSCALE_BIN=<path>` (a fake binary, for the exec path test).
- `apps/desktop/test-bins/src/bin/fake-tailscale.rs` — prints the scenario file that sits next to it
  (`fake-tailscale.scenario`: `running|needs-login|stopped|exit1|sleep10|huge|garbage|env`); it takes its scenario
  from that file, never from the environment (the real exec clears it).
- `src-tauri/tests/fixtures/tailscale/*.json` — **synthetic** documents only (`*.example.ts.net`, documentation-style
  names, generated keys omitted): `running.json`, `needs-login.json`, `stopped.json`, `peer-offline.json`,
  `peer-expired.json`, `subnet-router.json`, `no-magicdns.json`, `unknown-fields.json`.

**Tests.**
- `tailscale_status.rs`: each fixture → expected `TailscaleStatus`; unknown fields ignored; missing `Peer` → empty
  peers; 9 MiB generated document → `TooLarge`; garbage → `Unparseable`; exit 1 → `DaemonDown`.
- `tailscale_match.rs`: `nas.example.ts.net.` (trailing dot, upper case) → peer; short `nas` → peer;
  `100.101.102.103` → peer; self IP → `SelfNode`; `192.168.10.5` within an online router's `PrimaryRoutes` →
  `SubnetRoute`; `100.70.0.1` without peer → `None` and the CGNAT text flag; offline/expired peer → online false.
- `tailscale_binary.rs` (unix): temp files with mode `0777` → unusable, `0755` owned by the test user → usable,
  symlink into an allowed prefix → usable, symlink to `/tmp/evil` → unusable; Windows: a junction → unusable.
  Candidates contain only absolute paths and never consult `PATH` (test sets a `PATH` with a fake `tailscale`).
- `tailscale_exec.rs`: through `fake-tailscale` — scenario `env` prints the names of the environment variables and
  the argv it received as JSON; the test asserts only allow-listed names and argv exactly `status --json`;
  `sleep10` is killed at 4 s; `huge` is capped.
- `tailscale_probe.rs`: local listener on 127.0.0.1; `self_ips = [127.0.0.1]` → ok; `self_ips = [100.64.0.9]` →
  `route-mismatch`; closed port → `Refused`; unroutable documentation address → `Timeout` within 3.5 s.
- `tailscale_privacy.rs`: after a check, the serialized `TransportReport` contains only the matched peer label (assert
  that no other fixture peer name, user, IP or key appears in it or in captured log output).

**Acceptance.** Desktop Green on all five targets; the release build ignores both seams (test with
`PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY=1 cargo test --release` for the seam guard, as other DR19 seams do).

---

## T4 — Remote connections: IPC, pinned connect, UI, tray (≈ 4 agent days)

**Purpose.** The existing `remote` kind gets the choice, the banners, the confirmation, the pinned connect and the
display in list and tray.

**Files.**
- `src-tauri/src/shell_commands.rs` — add `transport_check`, `connection_transport_set`.
- `src-tauri/src/commands.rs`:
  ```rust
  #[derive(Deserialize)] #[serde(deny_unknown_fields, rename_all = "camelCase")]
  pub struct TransportCheckRequest { pub target: CheckTarget, pub transport: Transport, pub purpose: Purpose }
  #[derive(Deserialize)] #[serde(deny_unknown_fields, rename_all = "camelCase", tag = "kind")]
  pub enum CheckTarget { Origin { origin: String }, Host { host: String, port: u16 }, Connection { id: Uuid } }
  #[tauri::command] pub async fn transport_check(window, state, request: TransportCheckRequest) -> Result<TransportReport, String>;
  #[derive(Deserialize)] #[serde(deny_unknown_fields, rename_all = "camelCase")]
  pub struct TransportSetRequest { pub id: Uuid, pub transport: Transport, pub public_ack: bool }
  #[tauri::command] pub async fn connection_transport_set(window, state, request: TransportSetRequest) -> Result<TransportReport, String>;
  ```
  `PairCodeRequest` gains required `transport` and `publicAck`; `ConnectionList` gains
  `transports: BTreeMap<Uuid, TransportView { transport, publicAck: bool, storeReadOnly: bool }>`.
  `pair_code`: `Origin::parse` → `check_target(probe = false)` → `gate` (with `publicAck` from the request, which is
  only honoured when the fresh report needs it) → pinned client → existing pairing → `TransportStore::set` after the
  connection row exists. `open_connection` (`commands.rs:415`): `check_target(probe = true for tailnet paths)` →
  `gate(entry.public_ack)` → on `ConfirmNeeded` return `transport-confirm-needed` before any harness contact → pinned
  `HarnessClient` for validation, SPA and events. `connection_transport_set` with `publicAck: true` runs a fresh check
  and stores the ack only if the target is public now; a host/transport change clears the ack. `connections_remove`
  removes the sidecar entry after the existing keychain-first removal. One check in flight per window (generation
  counter → `transport-check-busy` for the superseded one).
- `src-tauri/src/client.rs` — `HarnessClient::with_pin(self, pin: ConnectPin) -> Self`; `transport()` adds
  `.resolve_to_addrs(&pin.host, &pin.addrs)`; `pub async fn websocket_connect(&self, url: &str) ->
  Result<(WebSocketStream<MaybeTlsStream<TcpStream>>, Response), ClientError>` connects a `TcpStream` to the first
  reachable pinned address and runs `tokio_tungstenite::client_async_tls_with_config` on it.
- `src-tauri/src/spa_proxy.rs:562` — replace `connect_async_tls_with_config` with `client.websocket_connect`.
- `src-tauri/src/spa.rs:350`, `native.rs:412` — build clients from the open's `CheckedTarget`; the events reconnect
  path calls `check_target` again; a worse category without ack stops the loop, sets `transport_attention`, emits
  `transport-attention` to the shell.
- `src-tauri/src/tray.rs` — `TrayState { …, path: Option<PathLabel>, transport_attention: bool }`,
  `enum PathLabel { Tailscale, Direct, DirectPublic }`; `Language::status` renders spec §7.3; `badge()` returns
  `Attention` when `transport_attention`; texts `path-tailscale`, `path-direct`, `path-public`, `tailscale-attention`.
- UI: `ui/src/views/transport-choice.ts` (radio group, check panel, banner, confirmation; `role="radiogroup"`,
  banner `role="alert"` once, live region for check progress), `ui/src/models/transport-model.ts` (600 ms debounce,
  superseded-request handling), `ui/src/views/add-remote.ts` (step between origin and code; submit disabled until a
  path is chosen and a required confirmation is ticked), `ui/src/views/connections.ts` (path chip, Tailscale chip,
  *Weg ändern…* dialog, confirm-needed state with *Bestätigen und verbinden*), `ui/src/ipc.ts` bindings,
  `ui/src/i18n/{de,en}.json` keys of spec §7.2.
- `docs/desktop.md` — section *Transport choice* (storage, seams, check-then-connect, Tailscale mechanism, privacy).

**Tests.**
- Rust `tests/config.rs`/`spa.rs` pattern: both commands only for the `shell` label at the bundled origin; approvals
  and SPA webviews refused; unknown fields refused; host strings over 253 bytes refused.
- `tests/transport_open.rs` (mock harness + fake resolver): public origin without ack → `transport-confirm-needed`
  and **zero** TCP connections to the mock (counter in the mock); with ack → opens; private at add, public at open →
  confirm-needed again (`target-changed-public`); reconnect after a DNS change to public stops and flags attention.
- `tests/transport_pin.rs`: fake resolver answers A at check time and B afterwards; every HTTP, SSE and WebSocket
  request of the open reaches A (mock listens on A only; B is a second mock that must see nothing).
- `tests/pairing.rs` extension: `pair_code` with `transport` and `publicAck` round trip; sidecar entry written;
  `connections.json` byte-compare against the pre-feature writer for the same row.
- `tests/tray_state.rs` extension: header strings DE/EN with each path; attention badge.
- Browser suite (`ui/test`, injected test transport): chooser required; public banner text per purpose, checkbox
  gates submit; mixed text; Tailscale notices for every state of spec §5.3 from fixtures; confirm-needed flow on open;
  *Weg ändern…*; chips with text; axe light/dark, DE/EN; 44 px targets; 400 px; keyboard-only; screen-reader names
  for the radio group and banner.

**Acceptance.** Desktop Green; `pnpm lint` (hygiene, i18n); a remote connection can be added and opened via the UI
test transport with each path; no TCP connection to a public target before confirmation; `connections.json` unchanged
in schema and bytes.

---

## T5 — Harness `remote.allowSubnets` public-range notice (≈ 1.5 agent days)

**Purpose.** Owner decision 3 for the harness's own range input.

**Files.**
- `packages/api/src/net-bridge.ts` — re-exports `parseCidr`, `cidrContainsPublic`, `IANA_SPECIAL_REGISTRY` from
  `../../core/src/tools/web/ip.ts` (the `rbac-bridge.ts` pattern).
- `packages/remote-access/src/security.ts` — `FirstAidState.allowlistPublic?: readonly { cidr: string; example: string
  }[]`; in the `network` branch `warn("remote.allowlist-public", "<cidr> contains public addresses (for example
  <example>) …", "Keep it only if your organisation owns this block; otherwise correct remote.allowSubnets.")`.
- `packages/api/src/remote-runtime.ts` — compute `allowlistPublic` from `config.allowSubnets` and pass it at both
  `firstAidChecks` call sites (lines 96, 148).
- `packages/web/src/pages/settings/sections/devices/remote.ts` — per valid line a notice under the subnet field
  (local classification through a relative import of `ip.ts`; if `scripts/lint-hygiene.mjs` or the web build refuses
  that import, the API returns the classification with the remote settings instead); `packages/web/src/i18n/devices.ts`
  key `remote.allowlistPublic` (DE/EN, spec §7.2 `transport.range.public`).

**Tests.**
- `packages/remote-access/test/security.test.ts`: `remote.allowlist-public` present for `0.0.0.0/0` and
  `100.0.0.0/8`, absent for `10.0.0.0/8`/`fd00::/8`, absent when `publish != network`.
- `packages/api/test/remote-runtime.test.ts`: the doctor list carries the row for a public range.
- `packages/web` browser test: typing `192.0.2.0/24` shows no notice (documentation range is not public),
  `8.8.8.0/24` shows it; nothing blocks saving; axe.

**Acceptance.** `pnpm test`, `pnpm lint`, `pnpm docs:check`, `web-browser` gate green; no refusal added to
`parseRemoteConfig` or `planListeners`.

---

## T6 — SSH hosts (with WP1, WP2, WP3, WP5; ≈ 2 agent days spread over them)

- **T6a with WP2:** `ssh_hosts.rs` v1 schema with `transport` (required) and `publicAck?` (spec §3.3, SSH spec §7.4);
  tests: round trip, missing `transport` → corrupt (v1 has it from the start), no addresses stored.
- **T6b with WP1:** `SessionConfig { host_key_name: String /* host[:port] for known_hosts and the pin */, connect:
  Vec<SocketAddr> /* from CheckedTarget */, … }`; the SSH crate never calls a resolver (test: the crate's public API has
  no host-string connect; a `Resolver` panic stub is never hit). Jump host: its own `CheckedTarget`; the final target
  goes as a host name in `direct-tcpip` (hint `target-via-jump`), or as a classified literal.
- **T6c with WP3:** wizard step *Weg* + check panel + banner (purpose `ssh` text) before host-key confirmation;
  `transport_check` with `CheckTarget::Host`, `purpose: ssh | ssh-jump`; browser tests as in T4.
- **T6d with WP5:** tunnel connect and keepalive reconnect call `check_target` (probe for tailnet paths); worse
  category without ack stops reconnecting; password profiles keep asking (SSH spec §4.3).

**Acceptance.** As T4 for SSH: no SSH packet to a public target before confirmation; the session connects only to
the checked addresses; host-key tests of WP1 unchanged.

---

## T7 — Docs, status, manual passes (≈ 1 agent day + owner time)

- `docs/desktop.md` (T4 section, extended in T6), `docs/handoff/status/desktop-shell.md` rows *Transport choice*,
  a status note `docs/handoff/status/2026-10-2x-transport-choice.md` with the manual matrix below marked
  RUN/NOT RUN. User-guide text goes into the PR body as a DE/EN template (agy owns `docs/user/`).

## Test matrix

| Area | Linux CI (x64, arm64) | macOS 15 CI (arm64) | Windows CI (x64, arm64) | Owner Mac (aarch64-apple-darwin) | Windows 11 x64 VM |
|---|---|---|---|---|---|
| TS vectors, `ip.ts`, T5 (`unit`, `web-browser`) | gate | — | — | — | — |
| Rust parity + unit (T1–T3) | gate (desktop workflow) | desktop workflow | desktop workflow | `cargo test --locked --workspace` | same |
| Binary discovery real paths | `/usr/bin` absent → not-installed | `/Applications` absent → not-installed | Program Files absent → not-installed | App Store **and** standalone app; Homebrew CLI if present | MSI install; non-admin user |
| Tailscale states, real `tailscaled` | — (no tailnet in CI, no secret) | — | — | not installed / logged out / disconnected (`tailscale down`) / connected; peer online/offline; `*.ts.net` HTTPS origin; short name; subnet route; exit node on | not installed / service stopped / logged out / connected; peer offline |
| Probe local address | loopback fixture | loopback fixture | loopback fixture | real tailnet peer; CGNAT collision if available | real peer; another VPN active |
| Public direct banner | fake resolver | fake resolver | fake resolver | owner VPS (public) → banner, confirm, open | same |
| Mixed / changed DNS | fake resolver | — | — | `/etc/hosts` switch private→public between add and open | `hosts` file switch |
| DNS timeout | fake resolver | — | — | unreachable resolver in a test network location | same |
| UI (Playwright, injected transport) | gate (desktop-ui tests) | — | — | visual pass DE/EN light/dark | visual pass |
| Flatpak notice | unit (env `FLATPAK_ID`) | — | — | — | — |
| R10 downgrade | store tests | store tests | store tests | install previous build over new data: connections intact | same |

## Effort and gates

| Package | Est. (agent days) | Gate |
|---|---|---|
| T0 | 1 | — |
| T1 | 2 | T0 merged (vectors) |
| T2 | 2 | T1 |
| T3 | 3 | T1 (ranges); parallel to T2 |
| T4 | 4 | T2, T3 |
| T5 | 1.5 | T0 |
| T6 | 2 | T4; SSH WP1/WP2/WP3/WP5 respectively |
| T7 | 1 | T4 (again after T6) |

Total ≈ 16.5 agent days; T0–T5 ≈ 13.5 before any SSH client code.

## Open points

- Owner questions Q-T1 … Q-T7 (spec §12) with recommendations; T4 implements the recommendations of Q-T1 and Q-T2
  unless the owner decides otherwise before it starts.
- The tray connection switch (spec §6.3) and the disabled tray *Start/Stop harness* items are unbuilt (*Tray finding*);
  they need their own package and an owner decision whether §6.3 or the D1 plan's *Connections…* is the target.
- `packages/remote-access/src/net-address.ts` `addressScope` (used for the `network` bind-interface check) is a
  second, non-IANA scope function (it calls documentation ranges and `0.x` "public"). Not changed here; a follow-up
  could base it on `ip.ts` once the bridge exists.
