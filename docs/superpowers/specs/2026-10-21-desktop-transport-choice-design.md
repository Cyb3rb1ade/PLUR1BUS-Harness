# Desktop: transport choice for remote connections and SSH hosts — design

**Status:** Owner decisions of 2026-10-21 are binding (amend D113); this spec turns them into a design. Open owner
questions are in §12 · **Date:** 2026-10-21 · **Owner:** Christian (Cyb3rb1ade) · **Track:** D (desktop) ·
**Plan:** [`2026-10-21-desktop-transport-choice.md`](../plans/2026-10-21-desktop-transport-choice.md)

**Parent specs:** desktop spec [`2026-09-27-desktop-app-design.md`](2026-09-27-desktop-app-design.md) §6.2
(*Connections*, *Origin rules*, *Remote exposure*) and the SSH spec
[`2026-10-18-desktop-ssh-remote-design.md`](2026-10-18-desktop-ssh-remote-design.md) (R3, R10, §4.3, §7.4, §8). Both
point here; this document changes neither their trust rules nor `remote.publish`.

**Why a separate file and not a new section of the SSH spec.** (1) The feature applies first to the existing `remote`
connection kind (desktop spec §6.2), which is on `main` today, and can ship before SSH WP1, which waits for the S0
gates. (2) It defines a cross-language contract (the IANA classifier with shared TypeScript/Rust vectors) and a small
harness-side change (`remote.allowSubnets`), both outside the SSH track. (3) The SSH spec is owner-decided (Q1–Q5); a
pointer section (SSH spec §13) and a schema delta in its §7.4 keep it stable while this file carries the detail.

**Inputs read** (`origin/main` @ `e004e5fe`): the two parent specs, the SSH plan and S0 report, `docs/desktop.md`,
`AGENTS.md` (*Desktop shell*), `packages/core/src/tools/web/ip.ts` and `test/tools/web/ip.test.ts`,
`packages/remote-access/src/{exposure,net-address,tailscale,security}.ts`, `packages/api/src/remote-runtime.ts`,
`apps/desktop/src-tauri/src/{connections,commands,client,pair,tray,native,shell_commands}.rs`, the desktop UI views
`add-remote.ts`/`connections.ts`, and the vector pattern of
`clients/python/plur1bus-memory-client/tests/fixtures/address-vectors.json` / `packages/log-schema/fixtures/vectors.json`.
The IANA registries were read on 2026-10-21 (§4.1).

## 1. Owner decisions (2026-10-21, verbatim summary)

1. When creating a remote connection or an SSH host the person chooses the path freely: **„Über Tailscale“** or
   **„Direkt“** (SSH or TLS in the LAN, VPN or company network). No compulsion. The harness API is still never
   published to the internet (`remote.publish` = `local | tailnet | network`, unchanged).
2. **Direct to a target in public address space:** a clear notice (banner with the reason and an explicit
   confirmation), **no block**. Public/private follows the **IANA special-purpose registries** (IPv4 and IPv6, default
   deny: only positively global counts as public). Host names are resolved, every A/AAAA is classified (**mixed ⇒
   public**), and the check is **repeated when connecting**.
3. **Own network ranges** entered by the person (intranet/company network, e.g. `remote.allowCidrs`): a range that
   contains public address space gets a clear notice, no block (companies may own public blocks).
4. **Tailscale addresses** (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) **and `*.ts.net` names:** the app must **check**
   that the host is reachable over Tailscale (local `tailscaled` running and logged in, target is a peer of the
   tailnet and online, optionally a reachability probe); otherwise a clear notice with the reason (not installed / not
   connected / peer unknown / offline). This applies to „Über Tailscale“ and to a Tailscale address entered under
   „Direkt“.
5. Implementation by the controller with Claude agents; Rust tested on the Mac (`aarch64-apple-darwin`) and a Windows
   11 x64 VM; CI covers the five targets.

## 2. Decisions at a glance

| # | Topic | Decision | Main alternative, why not |
|---|---|---|---|
| T1 | Where the choice lives | Per **remote connection** and per **SSH host profile**: `transport: "tailscale" \| "direct"`. Bundled and local connections have no transport (loopback). | A global app setting: one person reaches the home NAS over Tailscale and the clinic server directly. |
| T2 | Storage, remote connections | New sidecar file **`connection-transport.json`**, keyed by connection id; `connections.json` is **not touched**. | A new field in `connections.json`: its closed schema quarantines the whole file in every older build (R10, `.corrupt-*`), i.e. a downgrade hides all connections. |
| T3 | Storage, SSH hosts | Fields **inside `ssh-hosts.json` v1** (`transport`, `publicAck?`), because that file does not exist on `main` yet. | A second sidecar: two files per host for no gain while v1 is still unwritten. |
| T4 | What the choice changes | It declares the **intended path** and selects which **checks and notices** apply. It never changes TLS rules, pins, the SSH host-key policy or the origin rules. | Letting „Über Tailscale“ relax certificate checks: the tailnet is not a trust anchor for the harness or the SSH server. |
| T5 | Classifier | One rule set in two languages: `ip.ts` (TS, unchanged behaviour, gains registry constants and `cidrContainsPublic`) and a pure Rust crate **`plur1bus-desktop-net`** in the desktop workspace; **shared vector file** read by both test suites; the IANA snapshot id **`iana-special-2025-10-09`** is a constant on both sides and in the vector file. | A Rust port without vectors: two tables drift silently. A data-driven table loaded at runtime: the registry snapshot must be reviewed code, not data. |
| T6 | Public = ? | **Positively global** (default deny), exactly `ip.ts`'s `public: true`. Non-public addresses are split for the UI into `loopback`, `tailnet`, `private`, `special`; `unspecified`, multicast and limited broadcast are not connectable. | "Public unless private": would warn about documentation and benchmark ranges as if they were internet hosts. |
| T7 | Check-then-connect | The app resolves once, classifies, and **connects only to exactly the checked addresses** (reqwest `resolve_to_addrs`, a pre-connected TCP stream for WebSocket, pre-resolved `SocketAddr`s for russh). Every new open or reconnect repeats the full check. | Check the name, let the HTTP client resolve again: a DNS rebinding window between check and connect. |
| T8 | Tailscale check | **`tailscale status --json`** run from a **fixed absolute path** (per-OS candidate list, ownership checks), fixed argv, no shell, cleared environment, 4 s timeout, 8 MiB cap; plus a **TCP probe** whose **local address** must be one of this device's Tailscale IPs. `*.ts.net` names are resolved from the **peer list**, not from DNS. | The LocalAPI directly: three transports (Unix socket, a Windows named pipe under `ProtectedPrefix`, a macOS loopback port with a "sameuserproof" token in the app-group container), all undocumented and version-specific; `tailscale ping <ip>`: would put user input into argv. |
| T9 | Notices vs. blocks | Notices and one explicit confirmation; **the only refusals are invalid input** (non-canonical IPv4 spelling, unspecified/multicast/broadcast, no connectable address). A failed Tailscale check never blocks. | Blocking public targets: contradicts the owner decision. |
| T10 | Confirmation memory | The confirmation for a public direct target is stored per connection/host as `publicAck { atMs, classifier }` **without addresses**; it stays valid while the host is unchanged. A target that **becomes** public later (it was private when created) needs a **new** confirmation before the app connects. | Asking at every open: banner blindness. Never asking again: misses a DNS change to a public address. |

## 3. Data model and storage

### 3.1 Types (Rust, mirrored in the UI's TypeScript types)

```text
Transport   = "tailscale" | "direct"
Category    = "loopback" | "tailnet" | "private" | "special" | "public"        // §4.3
PublicAck   = { atMs: u64, classifier: "iana-special-2025-10-09" }             // what was confirmed, never where
```

### 3.2 `connection-transport.json` (remote connections)

App config directory, beside `connections.json`; atomic write through a temporary file, POSIX `0600`, at most 1 MiB:

```json
{ "version": 1,
  "connections": {
    "0199f3a2-…": { "transport": "direct", "publicAck": { "atMs": 1761043200000, "classifier": "iana-special-2025-10-09" } },
    "0199f3a3-…": { "transport": "tailscale" } } }
```

Rules (R10, downgrade and upgrade safety):

- **Older builds** do not know the file and ignore it; `connections.json` stays byte-identical in every operation of
  this feature (tested). Nothing is migrated *inside* `connections.json`.
- **Missing entry = derived default** (this is the whole migration): for a `remote` row whose origin host is a
  `*.ts.net` name or a literal in a Tailscale range → `tailscale`; otherwise `direct`; `publicAck` absent. An existing
  public direct connection therefore shows the banner once at its next open (owner question Q-T2).
- **Entries are tolerant, the file is not a schema gate:** unknown fields inside an entry and unknown top-level keys
  are kept on write (as `settings.json` does). A `version` above 1 puts the store into **read-only** mode: the app uses
  derived defaults, writes nothing and says so once ("Weg-Einstellungen stammen aus einer neueren App-Version").
- **Corrupt file** (not JSON, oversized, wrong types): only the sidecar is renamed to
  `connection-transport.json.corrupt-<ms>-<uuid>`; connections stay; defaults apply.
- **Garbage collection:** entries whose id is not in `connections.json` (for example removed by an older build) are
  dropped on the next write. Connection ids are UUIDv7, so a stale entry never meets a new row.
- Entries exist only for `kind: remote`; a write for `bundled`/`local` is refused.
- Removing a connection removes its entry after the existing keychain-first removal succeeded (same ordering as
  desktop WP4: keychain, then metadata, then sidecar).

### 3.3 `ssh-hosts.json` (SSH host profiles)

SSH spec §7.4 gains two fields in schema **version 1** (amended there): `transport` (required) and `publicAck?`. If WP2
were to ship v1 without them, the fields move into a sidecar with the rules of §3.2 instead of a v2 bump — a v2 file
would be quarantined by the v1 reader of an older build. A jump host has its own profile and therefore its own
transport and acknowledgement (§6.3).

### 3.4 What is never stored

Resolved addresses, the Tailscale status, peer names other than the one shown for the current check, probe results.
They live in memory for the duration of one check (cache §5.4) and are never logged (§9.4).

## 4. Classification rules

### 4.1 Source and snapshot

IANA *IPv4 Special-Purpose Address Space* and *IPv6 Special-Purpose Address Space*, both `updated 2025-10-09`
(read 2026-10-21 from `iana.org/assignments/iana-ipv{4,6}-special-registry/`). The snapshot id
`iana-special-2025-10-09` is a constant in `ip.ts` (`IANA_SPECIAL_REGISTRY`) and in the Rust crate
(`CLASSIFIER_ID`), and the first field of the shared vector file. Updating the snapshot is a reviewed change of all
three in one commit; the parity tests fail otherwise. No runtime download.

### 4.2 Address verdict (shared, identical to `ip.ts`)

`classify(address) → { public, reason? }`, `reason ∈ unspecified | private | shared-address-space | loopback |
link-local | cloud-metadata | reserved | multicast`:

- IPv4: every registry row with *Globally Reachable = False* is non-public (`0.0.0.0/8`, `10/8`, `100.64/10`,
  `127/8`, `169.254/16`, `172.16/12`, `192.0.0.0/24`, `192.0.2/24`, `192.88.99/24` (deprecated), `192.168/16`,
  `198.18/15`, `198.51.100/24`, `203.0.113/24`, `240/4`, `255.255.255.255`), plus multicast `224/4` and the Azure
  WireServer `168.63.129.16/32` (`cloud-metadata`). Rows marked *True* inside a *False* block (`192.0.0.9/32`,
  `192.0.0.10/32`) stay non-public: deliberately conservative, as in the SSRF guard; nobody has an SSH server there.
- IPv6: only `2000::/3` can be public; inside it `2001::/23` (incl. Teredo and the anycast/ORCHID rows),
  `2001:db8::/32`, `3fff::/20` are non-public. Outside it everything is `reserved` (covers `5f00::/16`,
  `100:0:0:1::/64`, `fec0::/10`, `::/96`), plus `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`.
- Embedded IPv4 is judged by the embedded address: IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`, 6to4
  `2002::/16`.
- Parsing accepts the legacy `inet_aton` spellings (decimal, octal, hex, short forms) **for parity** with `ip.ts`;
  host *input* refuses them (§4.4).

### 4.3 Target category (desktop layer, Rust only)

Per resolved address, in this order:

| Condition | Category | Connectable |
|---|---|---|
| `unspecified`, `multicast`, `255.255.255.255` | — | **no** (`target-not-connectable`) |
| `100.64.0.0/10` or `fd7a:115c:a1e0::/48` | `tailnet` | yes (Tailscale check §5) |
| reason `loopback` | `loopback` | yes |
| reason `private`, `link-local` | `private` | yes |
| reason `reserved`, `cloud-metadata` | `special` | yes, with a notice |
| `public: true` | `public` | yes |

`100.64.0.0/10` is also carrier-grade NAT space; `tailnet` is a *candidate* only until the Tailscale check (§5) finds
a matching peer. An IPv4-mapped address (`::ffff:a.b.c.d`) is the IPv4 host and takes that address's category (mapped
`100.64.0.0/10` is `tailnet`), whereas an address that only carries an IPv4 address through a translator (NAT64
`64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`) is not that host, so one carrying `100.64.0.0/10` is `special`
(it reaches the translator's network, not the tailnet; the vector file pins both).

**Aggregate** over all connectable addresses: `public ≻ special ≻ private ≻ tailnet ≻ loopback`
(highest wins), so **any public address makes the target public** (`target-mixed` when non-public addresses are
present too). Not-connectable addresses are dropped from the connect set and reported; if none remains the check
fails with `target-not-connectable`.

### 4.4 Host input

The host field (SSH host, origin host) accepts: a DNS name (IDNA → punycode via the `url` crate, LDH labels, ≤ 253
bytes, no trailing dot required), a canonical dotted-quad IPv4, an IPv6 literal with or without brackets, **no zone id**,
and `localhost` (treated as loopback without DNS, RFC 6761). A string that parses only under the lenient `inet_aton`
rules (`127.1`, `0x7f000001`, `017700000001`) is refused with `host-ipv4-noncanonical` — the OS resolver would turn
it into an address the person did not write. This matches `Origin::parse`, which already refuses those spellings.

### 4.5 Ranges (CIDR)

`cidrContainsPublic(cidr)` / `cidr_first_public(&Cidr)` returns the **lowest public address** in the range or none.
Algorithm (both sides, bounded): a range fully inside a non-public block → none; a range inside an embedded-IPv4 block
(`::ffff:0:0/96`, `64:ff9b::/96`, `2002::/16`) → recurse on the mapped IPv4 range; a range overlapping no block → its
first address; otherwise split into halves and recurse (depth ≤ 128). Vectors cover `0.0.0.0/0` → `1.0.0.0`,
`10.0.0.0/8` → none, `100.0.0.0/8` → `100.0.0.0`, `172.16.0.0/11` → `172.0.0.0`, `::/0`, `2000::/3`,
`fd00::/8` → none, `::ffff:10.0.0.0/104` → none, `2002:0a00::/24` → none, `64:ff9b::/96` → `64:ff9b::100:0`.

Where ranges are entered and what happens:

- **Harness `remote.allowSubnets`/`allowCidrs`** (SPA *Devices & Remote*, `config`): the SPA shows the notice under the
  field as soon as a line is valid (it classifies locally through `ip.ts`); the API adds the `1staid` row
  `remote.allowlist-public` while `publish = network` (the only level that enforces the list). Nothing is refused.
- **Desktop:** no range input exists today; the Rust function ships with the crate for the D2 exposure UI. A desktop
  list of "own networks" that would silence the target notice is **not** part of v1 (owner question Q-T3).

### 4.6 Shared vectors

`packages/core/test/fixtures/net/ip-classification-vectors.json`, hand-committed, never generated:

```text
{ "classifier": "iana-special-2025-10-09",
  "registries": { "ipv4": { "url": …, "updated": "2025-10-09" }, "ipv6": { … } },
  "table": [ { "cidr": "0.0.0.0/8", "reason": "unspecified" }, … ],            // order = evaluation order
  "addresses": [ { "input": "::ffff:7f00:1", "canonical": "127.0.0.1", "public": false, "reason": "loopback" }, … ],
  "parseRejects": [ { "input": "fe80::1%eth0", "strict": false }, … ],
  "strictRejects": [ "127.1", "0x7f000001", … ],
  "cidrs": [ { "input": "100.0.0.0/8", "firstPublic": "100.0.0.0" }, { "input": "10.0.0.0/8", "firstPublic": null }, … ],
  "categories": [ { "input": "100.101.102.103", "category": "tailnet" }, … ] }   // read by Rust only
```

Both suites assert: the classifier id equals the code constant; the code's table equals `table` entry by entry; every
`addresses`/`parseRejects`/`strictRejects`/`cidrs` row. The existing `ip.test.ts` cases move into the file (they stay
as they are in `ip.test.ts` too, so the SSRF guard's own test does not depend on the fixture).

## 5. Tailscale reachability check

### 5.1 When it runs

When the chosen transport is `tailscale`, or the host is a `*.ts.net` name (case-insensitive, trailing dot allowed),
or any resolved address is `tailnet`. A `direct` target with only private or public addresses never runs it.

### 5.2 Mechanism

1. **Binary.** Absolute candidates only, no `PATH`:
   macOS `/Applications/Tailscale.app/Contents/MacOS/Tailscale` (App Store and standalone app; the bundle binary acts
   as CLI), `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`;
   Windows `<FOLDERID_ProgramFiles>\Tailscale\tailscale.exe` (known-folder API, not the `%ProgramFiles%` variable);
   Linux `/usr/bin/tailscale`, `/usr/sbin/tailscale`, `/usr/local/bin/tailscale`, `/snap/bin/tailscale`.
   A candidate is used only if it is a regular file (a symlink is followed only into `/Applications/Tailscale.app/`,
   `/opt/homebrew/Cellar/tailscale/`, `/usr/local/Cellar/tailscale/` or `/snap/`), owned by root or the current user
   and not group/other-writable (POSIX), or not a reparse point and inside Program Files (Windows). Inside a Flatpak
   sandbox (`FLATPAK_ID`) no host binary can be run: state `check-unavailable` with the Flatpak reason (Q-T6).
2. **Run** `status --json`: `tokio::process::Command` with exactly these two arguments, stdin null, stdout capped at
   8 MiB, stderr capped at 4 KiB and used only to pick the state, `kill_on_drop`, Windows `CREATE_NO_WINDOW`, 4 s
   timeout. The environment is cleared and refilled from an allow-list (`HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG=C`
   on POSIX; `SystemRoot`, `USERPROFILE`, `LOCALAPPDATA`, `ProgramData`, `TEMP` on Windows). No shell, never an
   argument derived from input. Same executor shape as `pair.rs`'s native attach.
3. **Parse** into a minimal view (serde ignores everything else): `BackendState`, `Self.TailscaleIPs`,
   `MagicDNSSuffix`/`CurrentTailnet.MagicDNSSuffix`, and per peer `DNSName`, `HostName`, `TailscaleIPs`, `Online`,
   `PrimaryRoutes`, `Expired` (if present). The same fields as the harness's
   `packages/remote-access/src/tailscale.ts` (`detectTailscale`), so one fixture family serves both.
4. **Match the target:** `*.ts.net` name → the peer whose `DNSName` (without trailing dot) equals it; a single-label
   name → the peer whose first `DNSName` label equals it (MagicDNS short name); an address → the peer whose
   `TailscaleIPs` contains it, else `Self` (`tailscale-self`), else an online peer whose `PrimaryRoutes` contains it
   (`tailscale-subnet-route`). For a matched name the **connect set is the peer's `TailscaleIPs`** — no DNS query is
   made, which avoids leaking the name and closes the rebinding window for tailnet names. Without a match the name
   falls back to the system resolver (§6.1) with the matching notice.
5. **Probe** (always on *Check connection*, and as the first step of every open/connect over a `tailnet` path): TCP
   connect to the connect set and port (3 s per address, at most 4 addresses, no bytes sent), then compare the
   socket's **local address** with `Self.TailscaleIPs`. Not in that set ⇒ `tailscale-route-mismatch` (CGNAT collision,
   subnet routes not accepted, another VPN wins the route). The probe tells reachability independently of what the
   CLI said.

### 5.3 States and notices

| State | Code | Severity | When |
|---|---|---|---|
| ok | `tailscale-ok` | info | peer found, online, probe local address is a tailnet IP |
| self | `tailscale-self` | info | target is this device |
| subnet route | `tailscale-subnet-route` | info / notice | reached through an advertised route of an online router peer |
| not installed | `tailscale-not-installed` | notice | no candidate binary |
| check unavailable | `tailscale-check-unavailable` | notice | spawn failure, timeout, oversize or unparseable output, Flatpak |
| daemon down | `tailscale-daemon-down` | notice | CLI exits non-zero (cannot reach `tailscaled`) |
| needs login | `tailscale-needs-login` | notice | `NeedsLogin`, `NeedsMachineAuth` |
| stopped | `tailscale-stopped` | notice | any other non-`Running` backend state (`tailscale down`) |
| peer unknown | `tailscale-peer-unknown` | notice | no matching peer (for `100.64/10` the text names CGNAT) |
| peer offline | `tailscale-peer-offline` | notice | `Online: false` or `Expired: true` |
| unreachable | `tailscale-unreachable` | notice | peer online, TCP probe refused or timed out |
| route mismatch | `tailscale-route-mismatch` | notice | probe connected from a non-tailnet local address |
| not a tailnet target | `tailscale-not-tailnet-target` | notice | „Über Tailscale“ chosen, but the target is neither a `*.ts.net` name nor any tailnet address |

None of them blocks. With „Über Tailscale“ and a failed check the person may still save and connect; the public
notice (§7.2) then applies on its own terms, because the path is not verified.

### 5.4 Caching and limits

The parsed status is cached in memory for 10 s (one CLI run while the person types); at most one CLI run and one
probe in flight; a newer check supersedes an older one. Nothing is persisted.

### 5.5 Without Tailscale

Both options stay selectable. „Über Tailscale“ shows `tailscale-not-installed` with the plain text „tailscale.com/download“
(no opener plugin, AGENTS.md). „Direkt“ runs no Tailscale check unless the target is a tailnet address or name.

## 6. Name resolution

### 6.1 Resolver

- The **OS resolver** (`getaddrinfo` through `tokio::net::lookup_host`), the same one the connection would use, so
  split-horizon DNS, VPN DNS, `/etc/hosts` and mDNS behave as the person expects. **No DoH and no third-party resolver**:
  it would leak internal names and bypass company split DNS.
- **Timeout 5 s** around the lookup (the blocking worker may finish later; its result is dropped). At most 32
  addresses, de-duplicated, order kept.
- **No proxy:** harness and SSH connections never use an HTTP/SOCKS proxy (`client.rs` already builds every reqwest
  client with `.no_proxy()`; russh connects TCP directly). Because no proxy resolves on the app's behalf, the checked
  addresses are the addresses the socket uses. A proxy would make classification meaningless; it stays excluded.
- `localhost` is loopback without a query; IP literals are not resolved; tailnet names use the peer list (§5.2).
- **Jump host (SSH):** the jump host is classified and checked like any target (it is the first hop this computer
  connects to). The final target behind it is resolved **by the jump host** (`direct-tcpip` with a host name), so the
  app does **not** resolve it locally (that would leak an internal name to the local DNS and might answer differently);
  an IP literal target is classified for information. Notice `target-via-jump` (info).

### 6.2 Failures

`target-unresolved` (NXDOMAIN, no addresses) and `target-dns-timeout` are notices at add time (the person may be
offline or outside the VPN) and errors at connect time (nothing to connect to).

## 7. User interface

### 7.1 Flow

**Add remote** (`views/add-remote.ts`): name → origin → **Weg** (radio group, required, no preselection, Q-T1) →
check panel (runs 600 ms after origin and Weg are valid; „Prüfe …“; then the hints of §5.3/§7.2) → public banner and
confirmation checkbox if needed → code fields → *Koppeln*. On submit Rust **re-runs** the check (the UI result is
advisory) before any TCP connect to the harness, then pairs over the checked addresses.

**Add SSH host** (SSH WP3 wizard): address, port, user → **Weg** → check panel → banner/confirmation → host-key
confirmation → authentication. The check happens before the first SSH packet.

**Connection detail / host detail:** a line „Weg: Direkt · öffentlich bestätigt“ with *Weg ändern…* (radio + check +
confirmation in a dialog). Changing the host/origin or switching to „Über Tailscale“ clears `publicAck`.

**Open / connect:** if the fresh check is public and there is no valid `publicAck` (or the target was private when
confirmed and is public now), the command returns `transport-confirm-needed`; the page shows the banner with the
reason, *Bestätigen und verbinden*, *Abbrechen*, and *Weg ändern…*. Tailscale notices appear on the page and in the
tray but do not stop the attempt.

### 7.2 Texts (du; `ui/src/i18n/{de,en}.json`, keys `transport.*`)

| Key | Deutsch | English |
|---|---|---|
| `transport.question` | Wie erreichst du diesen Rechner? | How do you reach this computer? |
| `transport.tailscale` | Über Tailscale | Through Tailscale |
| `transport.tailscale.help` | Beide Geräte sind in deinem Tailnet. | Both devices are in your tailnet. |
| `transport.direct` | Direkt | Direct |
| `transport.direct.help` | Über dein LAN, VPN oder Firmennetz – per SSH oder HTTPS. | Over your LAN, VPN or company network, using SSH or HTTPS. |
| `transport.checking` | Prüfe {host} … | Checking {host}… |
| `transport.check` | Verbindung prüfen | Check connection |
| `transport.public.title` | Öffentliche Adresse | Public address |
| `transport.public.remote` | {host} zeigt auf eine Adresse im öffentlichen Internet ({addresses}). Der Harness sollte nie öffentlich erreichbar sein. Meist ist es ein Tippfehler, ein falscher DNS-Eintrag oder der Harness ist ungewollt ins Internet freigegeben. | {host} points to an address on the public internet ({addresses}). The harness should never be reachable from the internet. Usually this is a typo, a wrong DNS record, or the harness was exposed to the internet by mistake. |
| `transport.public.ssh` | {host} zeigt auf eine Adresse im öffentlichen Internet ({addresses}). SSH-Zugänge im Internet werden ständig angegriffen. Prüfe, ob du wirklich diesen Rechner meinst, und vergleiche beim ersten Kontakt den Host-Schlüssel. | {host} points to an address on the public internet ({addresses}). SSH servers on the internet are attacked all the time. Make sure this is the computer you mean, and compare the host key on first contact. |
| `transport.public.mixed` | {host} hat private und öffentliche Adressen. Die App behandelt das Ziel deshalb als öffentlich. | {host} has both private and public addresses, so the app treats it as public. |
| `transport.public.confirm` | Ich weiß, dass dieses Ziel im Internet liegt, und will trotzdem direkt verbinden. | I know this target is on the internet and want to connect directly anyway. |
| `transport.public.changed` | Die Adresse von {host} hat sich geändert und ist jetzt öffentlich. Bestätige das, bevor die App verbindet. | The address of {host} has changed and is now public. Confirm this before the app connects. |
| `transport.public.alt` | Stattdessen über Tailscale verbinden | Connect through Tailscale instead |
| `transport.special` | {address} ist eine Sonderadresse (zum Beispiel für Dokumentation oder Tests) und im Internet nicht erreichbar. | {address} is a special-purpose address (for example for documentation or testing) and is not reachable on the internet. |
| `transport.error.target-not-connectable` | {address} ist keine Zieladresse. | {address} is not a destination address. |
| `transport.error.host-ipv4-noncanonical` | Schreibe die IPv4-Adresse in der Form a.b.c.d. | Write the IPv4 address as a.b.c.d. |
| `transport.unresolved` | {host} lässt sich nicht auflösen. Bist du im richtigen Netz oder VPN? | {host} cannot be resolved. Are you on the right network or VPN? |
| `transport.dns-timeout` | Die Namensauflösung für {host} hat zu lange gedauert. | Resolving {host} took too long. |
| `transport.via-jump` | {host} wird vom Sprung-Host aufgelöst und hier nicht geprüft. | {host} is resolved by the jump host and not checked here. |
| `transport.tailscale.ok` | Über Tailscale erreichbar: {peer}. | Reachable through Tailscale: {peer}. |
| `transport.tailscale.self` | Das ist dieser Computer. | This is this computer. |
| `transport.tailscale.subnet-route` | Erreichbar über die Subnetz-Route von {peer}. | Reachable through {peer}'s subnet route. |
| `transport.tailscale.not-installed` | Tailscale ist auf diesem Computer nicht installiert (tailscale.com/download). | Tailscale is not installed on this computer (tailscale.com/download). |
| `transport.tailscale.check-unavailable` | Tailscale konnte nicht geprüft werden. | Tailscale could not be checked. |
| `transport.tailscale.check-unavailable.flatpak` | In der Flatpak-Version kann die App Tailscale nicht prüfen. | The Flatpak version of the app cannot check Tailscale. |
| `transport.tailscale.daemon-down` | Tailscale läuft auf diesem Computer nicht. Starte die Tailscale-App. | Tailscale is not running on this computer. Start the Tailscale app. |
| `transport.tailscale.needs-login` | Tailscale ist nicht angemeldet. Melde dich in der Tailscale-App an. | Tailscale is not signed in. Sign in in the Tailscale app. |
| `transport.tailscale.stopped` | Tailscale ist getrennt. Verbinde dich in der Tailscale-App. | Tailscale is disconnected. Connect in the Tailscale app. |
| `transport.tailscale.peer-unknown` | {host} ist kein Gerät in deinem Tailnet. | {host} is not a device in your tailnet. |
| `transport.tailscale.peer-unknown.cgnat` | Adressen aus 100.64.0.0/10 nutzen auch Internetanbieter (Carrier-NAT). | Internet providers also use addresses from 100.64.0.0/10 (carrier-grade NAT). |
| `transport.tailscale.peer-offline` | {peer} ist in deinem Tailnet, aber gerade offline. | {peer} is in your tailnet but offline right now. |
| `transport.tailscale.unreachable` | {peer} ist online, antwortet aber nicht auf Port {port}. | {peer} is online but does not answer on port {port}. |
| `transport.tailscale.route-mismatch` | Die Verbindung zu {host} läuft nicht über Tailscale. Prüfe Subnetz-Routen und andere VPNs. | The connection to {host} does not go through Tailscale. Check subnet routes and other VPNs. |
| `transport.tailscale.not-tailnet-target` | {host} ist keine Tailscale-Adresse. Wähle „Direkt“ oder gib den Tailscale-Namen ein (zum Beispiel rechner.tailnet.ts.net). | {host} is not a Tailscale address. Choose “Direct” or enter the Tailscale name (for example computer.tailnet.ts.net). |
| `transport.tailscale.short-name` | Für HTTPS brauchst du den vollen Namen ({suggestion}). | HTTPS needs the full name ({suggestion}). |
| `transport.range.public` | {range} enthält öffentliche Adressen (zum Beispiel {example}). Das passt nur, wenn dein Unternehmen eigene öffentliche Adressbereiche nutzt; sonst ist es vermutlich ein Tippfehler. | {range} contains public addresses (for example {example}). That is only right if your organisation owns public address blocks; otherwise it is probably a typo. |
| `transport.store.newer` | Weg-Einstellungen stammen aus einer neueren App-Version und werden nicht verändert. | Path settings come from a newer app version and are left unchanged. |
| `transport.path.tailscale` | Tailscale | Tailscale |
| `transport.path.direct` | Direkt | Direct |
| `transport.path.public` | Direkt · öffentlich | Direct · public |

The range text is also added to the web UI catalogues (`packages/web`, key `remote.allowlistPublic`).

### 7.3 Connection list and tray

- **List** (`views/connections.ts`): next to the existing kind chip a path chip — „Tailscale“, „Direkt“, or
  „Direkt · öffentlich“ (warning tone **and** text, never colour alone); a second chip for an active Tailscale notice
  („Tailscale getrennt“). Bundled/local rows show no path chip.
- **Tray header** (`tray.rs` `Language::status`): `PLUR1BUS — {connection} · {path} — {state}`; `{path}` is
  „Tailscale“ / „direkt“ / „direkt, öffentlich“ (EN „Tailscale“ / „direct“ / „direct, public“), omitted for
  bundled/local. A Tailscale notice on the active connection appends „— Tailscale getrennt“ / „— Tailscale
  disconnected“ and sets the badge to *Attention* (same rule as a locked secrets store).
- **Tray connection switch:** not built on `main` (plan, *Tray finding*). When it is built, each entry reads
  `{name} ({path})`.

## 8. Codes

Stable kebab-case strings returned to the bundled shell; the UI translates them (`transport.*`, §7.2).

| Code | Severity | Blocks? |
|---|---|---|
| `target-public`, `target-mixed`, `target-changed-public` | warning | needs the explicit confirmation (`transport-confirm-needed` until given) |
| `target-special` | notice | no |
| `target-unresolved`, `target-dns-timeout` | notice when adding, error when connecting | only because nothing can be connected |
| `target-via-jump` | info | no |
| `target-not-connectable`, `host-ipv4-noncanonical` | error | yes (invalid input) |
| `range-public` | warning | no |
| `tailscale-*` (§5.3) | info/notice | no |
| `transport-confirm-needed` | command error | until `connection_transport_set { publicAck: true }` |
| `transport-check-busy` | command error | superseded check |
| `transport-store-readonly` | notice | no |

## 9. Security

### 9.1 What the classification is and is not

It protects the person's **intent** (no accidental internet path, no silent DNS surprise). It is **never a trust
signal**: a private or verified-tailnet verdict never relaxes TLS verification, certificate/CA pins, the `pair-proof`
step, the `installationId` check or the SSH host-key policy (TOFU with confirmation, changed key = hard stop). Those
remain authoritative for channel integrity on every path.

### 9.2 TOCTOU and DNS rebinding

- One resolution per check; the connection uses **exactly** the checked `SocketAddr` set:
  HTTP and SSE through reqwest `ClientBuilder::resolve_to_addrs(host, &addrs)` for **every** client built for that
  open (API, streaming, events) — the clients keep `pool_max_idle_per_host(0)`, so without pinning each request would
  resolve again; WebSocket through a `TcpStream` connected to a checked address and handed to tokio-tungstenite's
  client handshake (no second lookup inside the WebSocket library); SSH through pre-resolved addresses in
  `SessionConfig` (the SSH crate does no DNS itself).
- TLS SNI and certificate verification keep the host name; SSH host-key lookup keeps `host[:port]`.
- Every new open and every reconnect (events backoff, SSH keepalive reconnect) runs the full check again; a worse
  category without a matching acknowledgement stops the reconnect loop and raises `target-changed-public` — no
  automatic acknowledgement, ever.
- Residual: a DNS answer that is private at check time and points to an attacker later is defeated by TLS/pins and
  host keys, not by the classifier.

### 9.3 Forged Tailscale answers

- The binary comes from fixed, root/admin-owned locations with ownership and writability checks; a same-user process
  that impersonates `tailscaled` is same-user malware (out of scope, as for every desktop credential).
- Worst case of a forged "ok": a notice is suppressed. A forged "offline": a notice is shown. Neither changes trust
  or blocks a connection.
- The probe's local-address comparison is an independent signal from the kernel, not from the CLI.
- `100.64.0.0/10` is never treated as Tailscale without a matching peer (CGNAT overlap).

### 9.4 Privacy and logs

The tailnet status lists every device, user and address of the tailnet. It is parsed into the minimal view in memory,
used for one match, cached ≤ 10 s, never logged, never persisted, never put into a diagnostics bundle, never sent to the
webview. The webview receives only the state code, the matched peer's label (first `DNSName` label) and its online
flag. Logs record the check's category and codes, never resolved addresses or peer data. No telemetry.

### 9.5 Tauri and IPC

No new plugin. New native commands are added to `SHELL_COMMANDS` (shell webview at the bundled origin, label and
origin checked in Rust), take closed serde structs (`deny_unknown_fields`), and accept only a host string (validated
§4.4), a port, enums and connection ids. The webview never receives the Tailscale status or the full address list
beyond the first eight addresses shown in the banner.

### 9.6 Harness API never public

Nothing here touches `remote.publish`, adds Funnel, or offers to expose the harness. A public origin for a harness
gets the strongest wording (§7.2 `transport.public.remote`) because it contradicts the exposure policy.

## 10. Relation to exposure levels and SSH

| Person's choice | Typical harness side | Typical SSH side |
|---|---|---|
| „Über Tailscale“ | `remote.publish = tailnet` (`tailscale serve`, `https://<name>.<tailnet>.ts.net`), or `network` bound to the tailnet address with a pinned self-signed certificate | sshd reached at the peer's tailnet address or `*.ts.net` name |
| „Direkt“ | `remote.publish = network` (LAN/VPN TLS, self-signed pin or company CA) | sshd in the LAN/VPN/company network; the harness API stays on loopback behind the SSH tunnel (SSH spec R8) |

Tailscale SSH (`tailscale up --ssh`) intercepts port 22 on the tailnet address with its own SSH server; v1 does not
target it (Q-T5). The desktop's own host-key TOFU applies regardless.

## 11. Testability (summary; the plan has the cases)

Shared vectors (TS + Rust); Rust unit tests with an injected `Resolver`, `TailscaleSource` and `Prober`; synthetic
`tailscale status --json` fixtures (no real tailnet data committed); store tests for R10 (`connections.json`
byte-identical, tolerant sidecar, read-only on a newer version, corrupt sidecar isolated); IPC ACL and closed-struct
tests; Playwright UI tests with an injected transport (chooser, banners, confirmation, re-confirmation, tray text,
axe light/dark DE/EN, 44 px, 400 px); manual real-Tailscale passes on the Mac and the Windows 11 VM.

## 12. Owner questions (decided 2026-10-21)

The owner accepted every recommendation below on 2026-10-21; they are binding for T0–T6.

| # | Question | Decision (= recommendation) |
|---|---|---|
| Q-T1 | Preselect a path (for example „Über Tailscale“ when Tailscale is running)? | No preselection; a required choice. The check panel suggests the other path when the input clearly belongs to it. |
| Q-T2 | Existing public direct connections (created before this feature): confirm once at the next open, or treat as confirmed? | Confirm once at the next open. |
| Q-T3 | A desktop list of own (company) ranges that turns the public banner into a quieter note for targets inside them? | Not in v1; the per-connection confirmation is enough and keeps one rule. |
| Q-T4 | Verify the Tailscale binary's signature (macOS code signature team id, Windows Authenticode) in addition to location and ownership? | Later hardening; v1 relies on fixed admin-owned paths. |
| Q-T5 | Support Tailscale SSH servers (port 22 intercepted, identity-based auth)? | Not in v1; show an info notice when the server banner identifies Tailscale SSH. |
| Q-T6 | Flatpak build: accept "Tailscale cannot be checked", or add `--filesystem=/run/tailscale:ro` and a Linux-only LocalAPI socket client? | Accept for v1 (notice only). |
| Q-T7 | Also warn in `plur1bus config set remote.allowSubnets` (Rust CLI)? That needs the classifier in the root Rust workspace as a third implementation against the same vectors. | Not in v1; SPA notice and `1staid` row cover it. |
