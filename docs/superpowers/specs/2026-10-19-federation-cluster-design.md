# Federation: full protocol control and clusters of PLUR1BUS instances — design

**Status:** Owner decisions of 2026-10-19 incorporated (§15 Q1–Q8 decided, **D114**; Q9–Q14 decided the same day,
§15) (phase 1: specification and plan, no product code) · **amended 2026-10-20: D116** (relationship memory and
confidentiality levels: Q10 refined in §7.3 and §15; hand-over §7.4 follows D116 point 10) · **Date:** 2026-10-19 · **Owner:** Christian (Cyb3rb1ade) ·
**Track:** F (federation), new; target **Beta 2**, after v0.1.0 (decided) · **Decision record:** D114 in the core
spec's register ([`2026-09-24-m1b-2a-core-daemon-cli-design.md`](2026-09-24-m1b-2a-core-daemon-cli-design.md) §2) ·
**Plan:** [`2026-10-19-federation-cluster.md`](../plans/2026-10-19-federation-cluster.md)

**Owner request (2026-10-19, dictated, verbatim in substance):** „Erweitere den Plan um eine Funktion – gerne am Ende
bzw. für die zweite Beta –, die es erlaubt, via ACP/MCP (ggf. Protokoll erweitern) wirklich alle Funktionen zu steuern,
und dass man aus zwei PLUR1BUS-Instanzen eine Art Cluster bilden kann, nicht nur lokal, sondern auch über Tailscale.
Beispiel: Ich habe mein PLUR1BUS mit einem lokalen Modell, mein Kumpel auch. Unsere beiden Agenten sollen zusammen an
einem Projekt arbeiten. Man soll einzelne lokale Projekte für angeschlossene Instanzen/Cluster-Instanzen freigeben
können; der andere kann dann entweder seinen Agenten zur Verfügung stellen oder ihn selbst ins Projekt schieben. Die
Engine muss dann wissen, dass die Instruktionen entweder auf beide verteilt oder parallel orchestriert abgearbeitet
werden. Der in die Session gejointe Agent braucht den ganzen Kontext. Dabei muss geprüft werden, ob das Kontextfenster
passt. Wenn nicht: zur Laufzeit das Kontextfenster der laufenden Session reduzieren, oder eine Funktion, die bei ca.
80 % des Token-Fensters des Agenten mit dem kleineren Fenster schon kompaktiert und darauf achtet, dass der Kontext
nicht zu groß wird.“

**Owner follow-up (2026-10-19, on Q2, verbatim):** „b2 wär trotzdem gut. Einen Agenten sollte man verliehen / auf
Mission/Projekt schicken können. Dabei müssen die x PLUR1BUS-Instanzen online bleiben (logisch). Ein
permanent-Übergeben-Feature wäre natürlich nur folgerichtig.“ This adds two contribution modes to the feature: **(b2)
lending an agent on a mission** (§7.3) and **(b3) handing an agent over permanently** (§7.4).

**Inputs read for this spec** (state of `origin/main` @ `dcab21bc`): `AGENTS.md`; [`docs/milestones.md`](../../milestones.md)
(§2, M3, M5, M6, Track D/X/HM, §6.3, §7, §8); [`docs/a2a.md`](../../a2a.md) and `packages/core/src/a2a/`;
[`docs/acp.md`](../../acp.md) and `packages/core/src/acp/`; [`docs/mcp-client.md`](../../mcp-client.md);
[ADR-008](../../adr/ADR-008-protocols-mcp-acp-a2a.md); [ADR-014](../../adr/ADR-014-mcp-host-adapter.md);
[`docs/identity.md`](../../identity.md); [`docs/rbac.md`](../../rbac.md) and
[ADR-007](../../adr/ADR-007-users-roles-identity.md); [`docs/security.md`](../../security.md) (RBAC/WebMCP matrix) and
`packages/webmcp/src/provider.ts`; [`docs/egress.md`](../../egress.md) and `packages/core/src/tools/web/ip.ts`;
[`docs/user/en/privacy.md`](../../user/en/privacy.md) (`privacy.localOnly`, #570);
[`docs/collaboration.md`](../../collaboration.md), `packages/core/src/collab/` (`target.ts`, `handoff.ts`) and the M5 plan
[`2026-10-15-m5-collaboration.md`](../plans/2026-10-15-m5-collaboration.md); `packages/core/src/session/compaction.ts`,
[`docs/architecture/compaction.md`](../../architecture/compaction.md) and [ADR-010](../../adr/ADR-010-latency-and-caching.md)
(prompt zones, compaction record); [`docs/prompt-cache.md`](../../prompt-cache.md); [`docs/budgets.md`](../../budgets.md);
[`docs/remote-access.md`](../../remote-access.md) and `packages/remote-access/src/net-address.ts`; the desktop SSH spec
[`2026-10-18-desktop-ssh-remote-design.md`](2026-10-18-desktop-ssh-remote-design.md) (structure and style). The
Codex Großpaket 2 phases N (MCP server), O (ACP client) and P (outbound A2A) are named as prerequisites by the
controller; none of them has a document or branch on `main` at this commit, so this spec relies on ADR-008's decisions
for them and lists what it needs from each (§3).

## 1. Goal, non-goals, placement

**Goal.** Two (later *n*) PLUR1BUS installations, each owned by a different person and usually running its own local
model, can form a **federation** ("cluster" in the owner's words) over the LAN or a tailnet and work together on one
project:

1. **Full control over protocols.** Everything a person can do through the harness RPC surface can also be done by an
   authorised MCP or ACP client, within the same RBAC and D109 rules, so a federation is built from published protocols
   and not from a private back channel.
2. **Peering.** Instance A and instance B pair once (code + fingerprint confirmation on both sides), then reach each
   other over a mutually authenticated channel; either owner can revoke at any time.
3. **Project sharing.** An owner shares a single local project with a peer, read-only or as a contributor; nothing else
   on the instance becomes visible.
4. **Contributing agents.** The peer either offers one of its agents **as a service** (the agent runs at the peer, on the
   peer's model and budget) or **joins** it into a shared session (it then follows the whole session context). Beyond
   that, an owner can **lend** an agent to a peer for a mission or project (b2: the agent runs at the borrower on the
   borrower's model while ownership and identity stay with the lender, under a lease that needs both instances
   online) or **hand it over permanently** (b3: ownership and identity move to the receiver).
5. **Orchestration.** The project owner's instance orchestrates: work is **split** across agents or done **in parallel**
   and merged, using the M5 consult/delegate machinery, the D104 hand-off format and one trace across instances.
6. **Context-window safety.** When an agent joins a session, the harness determines the smallest usable context window of
   all participants, compacts the running session at once if it does not fit, and from then on compacts ahead of every
   turn at a configurable share (default **80 %**) of that smallest window.

**Non-goals (this design).**

- Not part of **v0.1.0**. Federation needs M3 remote access, M5 and the M6 protocol work on `main` first (§3). Target is
  the second beta after v0.1.0 ("Beta 2", decided 2026-10-19, Q1).
- No shared database, no replicated memory store, no consensus protocol. Each instance stays the only writer of its own
  state; a shared project has exactly one **home instance** (the owner's).
- No memory sharing by default: a memory crosses the link only as an explicitly selected item (copied, tainted,
  revocable on a cooperative guest; Q3). No secret ever crosses the link (§11.3), neither in a share nor in a loan or
  hand-over package.
- No public exposure. The federation listener rides the existing `remote.publish` levels (`tailnet`, `network`); `local`
  admits only peers on the same machine. Funnel stays forbidden at every level.
- No automatic discovery in v1 (no mDNS, no tailnet scan). A peer is added by address or by a pairing link.
- No named group object ("cluster") in v1: federation is pairwise, with any number of peers per project (Q4); a named
  cluster object may follow later.
- No worktree files in a v1 share; later at most a read-only git bundle as an explicit share item (Q3).
- No transitive federation: B never forwards A's project to C (§8.4).
- No remote administration. `admin.*`, `humanOnly` actions, configuration writes and process control are never
  reachable by a peer, and "full control" for MCP/ACP clients does not widen them (§4.4).
- No copy of a peer's agent definition without a lease or a hand-over: an agent definition leaves its instance only
  as a loan (b2, §7.3, returned at the end) or as a two-sided permanent hand-over (b3, §7.4).
- No sub-lending: a borrower cannot lend on or hand over a borrowed agent, and a lent agent cannot be handed over by
  its lender while the loan runs.

**Relation to earlier decisions.** ADR-008 already plans an MCP server, an ACP client and an A2A 1.0.0 client and server
with peers registered by URL, a trust level, an allowlist and a budget. ADR-003 Q4 (external agents stateless) and Q5
(depth 1) hold across instances. This design adds: a peer identity and pairing (instead of bearer keys typed into a peer
table), a PLUR1BUS control profile on the three protocols, project sharing, the join mode and the context-window
negotiation, and the loan and hand-over of agents. Recorded as **D114** (decided 2026-10-19, Q1).

## 2. Decisions at a glance

| # | Topic | Decision (owner decisions of 2026-10-19 marked) | Main alternative, why not |
|---|---|---|---|
| F-R1 | Peer-to-peer protocol | **A2A 1.0.0 (JSON-RPC + SSE) with a PLUR1BUS federation extension** for agent work between instances; the extension adds project, context and window methods. | A private `federation.*` RPC: duplicates task lifecycle, streaming and cancel that A2A already defines; peers of other vendors could never take part. |
| F-R2 | "Full control" for clients | **One schema-derived control profile**: MCP tools `plur1bus_<method>` and ACP extension methods `_plur1bus/<method>`, both generated from `rpc.schema.json` with the WebMCP provider's derivation and forbidden set. **Decided (Q5):** profile minus the WebMCP forbidden set; no further families can be opened for personal tokens. | A hand-kept tool list per protocol: drifts from the RPC schema, as ADR-008 already warns for MCP descriptors. |
| F-R3 | Peer identity | **Ed25519 instance key** per installation, fingerprint `sha256:` like device keys; per-connection challenge signature (the F44 `DeviceStore.connect` pattern) on top of TLS. Optional mTLS on a direct `network` listener. | mTLS only: `tailscale serve` terminates TLS, so a client certificate never reaches the harness on the `tailnet` level. |
| F-R4 | Trust bootstrap | **Federation invite**: eight-character code, 10 minutes, one use (identity/pairing code rules), link carries origin, TLS pin and instance fingerprint; **both owners confirm** a short authentication string. | Bearer keys typed into a peer table (today's A2A server): no mutual identity, no revocation story, keys in chat messages. |
| F-R5 | Transport | **LAN or tailnet**, through the existing exposure levels. Tailscale is optional: a peer address is a MagicDNS name or tailnet IP the owner enters, plus status detection; no tsnet in v1. **Decided (Q6);** tsnet and Tailscale identity as a peer factor later. | tsnet in-process (Q6): a second Tailscale node per instance, Go dependency, larger change. |
| F-R6 | Peer principal | New principal kind **`peer`** (`peer:<id>`), no role, **scopes only**, deny by default; `humanOnly` refuses it like an agent. | Mapping a peer to a harness user: a remote installation would hold a local account and its role. |
| F-R7 | Sharing unit | **One project**, level `read` or `contribute`; shared: project brief, board, trace (redacted), selected artifacts. **Not shared by default:** memories, worktree files, chats outside the project. **Decided (Q3):** memories only explicitly per item (copied, tainted, revocable on a cooperative guest); worktree files not in v1, later at most a read-only git bundle as an explicit share item. | Sharing an agent or a whole instance: far wider than the request ("einzelne lokale Projekte"). |
| F-R8 | Contributing an agent | **(a) Agent as a service is the default**: the agent runs at its owner's instance with its owner's model, budget and approvals. **(b) Join** is opt-in per share and per agent; execution still stays at the peer. **Decided (Q2).** | Join as the default: every joined agent widens the outflow to the whole session. |
| F-R9 | Orchestrator | **The home instance** (project owner's lead agent) orchestrates; peers execute contracts. | Symmetric orchestration: two writers of one board and session, conflict resolution, no single trace root. |
| F-R10 | Context on join | **Context package**: project brief + compaction summary + newest turns that fit + referenced excerpts; redacted, tainted. Full transcript only by explicit owner choice per join. | Raw history by default: leaks more than needed and usually does not fit the smaller window anyway. |
| F-R11 | Window negotiation | Effective window = **min over participants of the window available for shared context**; runtime compaction on join; pre-turn policy **compact at 80 %** (configurable); join refused below a minimum. **Decided (Q7):** 0.8 / 16 k / 32 k kept; a join that forces compaction of a running session asks the owner first. | Truncating per participant: every agent sees a different history, and the shared summary diverges. |
| F-R12 | Privacy | Sharing with a peer **is data leaving the machine**: explicit confirmation per share; under `privacy.localOnly` only peers that count as local. | Treating a peer like a web tool (egress only): `privacy.localOnly` exists to stop exactly this kind of outflow to models elsewhere. |
| F-R13 | Switch | `federation.enabled` **false** by default; nothing listens and no peer can pair until an Owner turns it on. | On by default: new attack surface on every install. |
| F-R14 | Lending an agent (b2) | **Loan on a mission**: ownership and identity stay with the lender; the agent runs at the borrower on the borrower's models (model-profile mapping, window policy), scoped to one borrower project, with an expiry, a **lease** renewed while both instances are online, recall at any time and return at mission end; no private memories unless selected, never secrets; mission memories flow back to the lender. **Owner request 2026-10-19.** | Running the agent at the borrower without a lease: the lender loses control the moment its instance goes offline. |
| F-R15 | Handing an agent over (b3) | *Amended 2026-10-20 (D116 point 10): the whole memory tree moves under control, the giver's relationship becomes „Früherer Mensch: <Name>“, levels stay in force (§7.4).* **Two-sided permanent hand-over**: offer → acceptance → confirmation by both owners; signed hand-over package (the `plur1bus.agent-export/1` bundle shape, definition plus selected memories, never secrets); new agent ID at the receiver with provenance "handed over from"; the giver's original is **archived**, not deleted. **Owner request 2026-10-19.** | Moving the agent ID itself: two instances would claim one identity, and audit on the giver's side would point at an agent it no longer owns. |

## 3. Prerequisites and dependencies

| # | Prerequisite | Needed for | Owner workstream | Status on `main` @ `dcab21bc` |
|---|---|---|---|---|
| P1 | MCP **server** exposure behind `authorize()` (ADR-008 action 4), Streamable HTTP behind the API | §4 control profile over MCP | M6 / Codex GP2 **phase N** | missing (M6 acceptance 2 *offen*) |
| P2 | ACP **client** side (`session/request_permission`, `fs/*`, `terminal/*`) and the external-agent targets | §4.3 ACP profile both ways; external agents as project members across instances | M6 / Codex GP2 **phase O** | missing (M6 acceptance 4 *offen*) |
| P3 | **Outbound A2A 1.0.0** client and the 1.0.0 server binding with card signing, served by `packages/api` (not a separate listener), persistent task store, a dedicated `a2a` session kind | §5 peer link, §7 agent as a service | M6 / Codex GP2 **phase P** | inbound 0.3.0 only, loopback, in-memory store (`docs/a2a.md`) |
| P4 | M5 collaboration on `main`: `DelegationTarget`, D104 hand-off, project sessions, trace/replay, budget admission | §7, §8 | M5 | in the M5 PR stack (#510, #514–#516, #520), not a `main` claim (milestones §M5 status) |
| P5 | M3 remote access: `tailnet`/`network` listener in the API, TLS material, pairing codes and pair-proof, device store with Ed25519 challenge | §5 transport and trust | M3 | library + API integration (remote-access.md); real tailnet/network acceptance open |
| P6 | `privacy.localOnly` and `privacy.localEndpoints` enforced in code | §11.1 | M2 / #570 | user docs on `main`; enforcement in the #570 stack |
| P7 | POST-capable `egress.request` (the variant requested in the local-only package) | outbound peer calls through egress, not around it | M2 / egress | GET-only today (`docs/a2a.md`, push POST lives in `a2a/push.ts`) |
| P8 | D109 binding of external principals (the `a2a-peer` follow-up) and the taint producer | §11.4 | D109 follow-ups | open (milestones §8 blocking item 10) |
| P9 | Principal kind `peer` in RBAC and the RPC caller identity (schema change) | F-R6 | M3 / RBAC owners | not present (`Principal.kind` is `person` or `agent`) |

P1–P3 gate everything except the spike; P4 gates §7–§8; P5 gates real two-machine runs (loopback two-instance tests
work without it); P6–P9 gate the security acceptance, not the first prototype. Loans and hand-overs (§7.3, §7.4)
additionally use `agent.export`/`agent.import`/`agent.archive` (on `main`, experimental), `memory.import` and the
re-embedding migration (`docs/embedding-migration.md`), the D105 class table and the D112 catalogue.

## 4. Full control over MCP and ACP

### 4.1 The gap today

| Surface | What it exposes on `main` | Share of the RPC surface |
|---|---|---|
| Harness RPC (`docs/rpc.md`) | 449 methods in about 40 namespaces (`project.*` 29, `admin.*` 20, `media.*` 19, `voice.*` 18, `agent.*` 17, `chat.*` 15, `memory.*` 14, …) | 100 % |
| WebMCP provider (`packages/webmcp`) | tools derived **from the RPC schema and the core's capability handshake**, minus a fixed forbidden set (`admin.*`, auth, lifecycle, config writes, installs, …), writes only on page opt-in plus human confirmation | most reads, opted-in writes |
| MCP server | nothing (ADR-008 plans two groups: harness functions and read-only memory tools) | 0 % |
| ACP agent (`plur1bus acp serve`) | `initialize`, `session/new`, `session/prompt`, `session/cancel` | chat turns only |
| A2A server (inbound 0.3.0) | card, `message/send|stream`, `tasks/*` per exposed agent | chat turns only |

So "really all functions" is today only true for the web UI. The WebMCP provider already solved the hard part — a tool
set that follows the RPC schema, with a reviewed deny list and a confirmation hook — but only inside the browser page.

### 4.2 Control profile

One **control profile** is defined once and rendered onto each protocol:

- **Source of truth:** `rpc.schema.json` plus the core's capability handshake, exactly as `packages/webmcp/src/provider.ts`
  does today. The derivation (method → tool name, params → `inputSchema`, page-bound params removed) moves into a shared
  module used by WebMCP, the MCP server and the ACP extension; WebMCP's forbidden set becomes the profile's
  **never-exposed set** and stays the single list.
- **MCP rendering (needs P1):** tools named `plur1bus_<method with dots as underscores>` in a dedicated tool group
  `control`, next to ADR-008's `harness` and `memory` groups. Default exposure: **no** control tools (ADR-008 Q3); an
  Owner enables read tools per token, write tools per method family, each family listed in the token's scopes.
  **Decided 2026-10-19 (Q5):** the families an Owner can enable are exactly the profile's; the never-exposed set cannot
  be opened for any token, a personal token of an Owner included.
- **ACP rendering:** ACP v1 reserves method names starting with `_` for extensions. The agent side answers
  `_plur1bus/describe` (the profile for this caller) and `_plur1bus/call { method, params }`; capabilities announce
  `_meta.plur1bus.control: 1`. Editors that ignore extensions are unaffected.
- **A2A rendering:** no control methods. A2A is for agent work between peers (§5); a peer is never a remote controller.
- **No new RPC methods** are needed for the profile itself; every tool call becomes the RPC call it names and runs through
  the same guard.

### 4.3 Is a protocol extension needed?

| Need | MCP | ACP | A2A |
|---|---|---|---|
| Call any allowed RPC method | standard tools; no extension | **extension methods** (`_plur1bus/*`), allowed by ACP v1 | not offered |
| Stream long results (events, chat deltas) | tool result + `notifications/progress`; `chat.events` as polling tool | session updates already used for turns | native SSE |
| Project share, context package, window negotiation between instances | — | — | **A2A extension** `https://plur1bus.app/a2a/ext/federation/v1` declared in the card's `capabilities.extensions` and activated per request; adds the methods in §5.6 |

The federation extension is **required** for peers that want project sharing and joins, and **optional** otherwise: a
plain A2A 1.0.0 client can still consult an exposed agent. Spike S0 confirms that `@a2a-js/sdk` 1.2.0 can serve
extension-defined methods; if not, the same methods live on a sibling JSON-RPC path `/federation/v1` on the same
listener, with the same authentication.

### 4.4 RBAC and D109 stay authoritative

- Every control-profile call is an ordinary RPC call with the caller's authenticated principal; `authorize()` and the
  method's guard decide. A token's scopes narrow, never widen, the person's role (ADR-007).
- **Never exposed through any protocol:** the whole `admin.*` family, every `humanOnly` action (`grant.*`, `approval.*`
  decisions, …), `core.auth`, `core.shutdown`, supervisor/daemon/module control, configuration writes, secret reveal and
  the rest of WebMCP's forbidden set. A test walks the schema and fails when a method is reachable by MCP or ACP but
  forbidden for WebMCP, so the three lists cannot diverge (extension of `packages/webmcp/test/rbac-matrix.test.ts`).
- An **agent** calling the profile (an MCP host's model acting for a person) is an `agent` principal: `humanOnly` refuses
  it; D109 decides tool effects and approvals as for any other agent tool call.
- A **peer** (§6) never gets the control profile; it has only the federation scopes.

## 5. Federation model

### 5.1 Terms

| Term | Meaning |
|---|---|
| Instance | one PLUR1BUS installation (one core, one state root), identified by its `installationId` and its **instance key** |
| Peer | another instance this one has paired with |
| Federation | the set of instances paired with each other; in v1 every pair is explicit (A–B, A–C) and a project may have any number of peers; there is no group object (decided 2026-10-19, Q4; a named cluster object may follow later) |
| Home instance | the instance that owns a shared project; it holds the board, the shared session and the trace root |
| Guest | a peer that has been given access to a shared project |
| Lender / borrower | for a loan (b2, §7.3): the instance that owns the agent / the instance the agent runs at during the mission |
| Giver / receiver | for a permanent hand-over (b3, §7.4): the instance that gives the agent away / the one that becomes its owner |
| Lease | a short-lived, lender-signed permission that a lent agent may act; renewed while both instances are online |

### 5.2 Instance identity

- At first enable the core generates an **Ed25519 instance key**; the private key goes to the secret store (ADR-005),
  never into a file or export. Fingerprint `sha256:<base64url>` as for device keys (`remote-access.md`).
- The public key, the fingerprint, the instance's display name and its federation origins form the **instance card**,
  served as the A2A extension's parameters and signed with the instance key. It names no person, path, model or memory.
- Key rotation: a new key is announced over the current authenticated link and confirmed by the peer (the trust-rollover
  pattern of `remote-access.md`); a peer that missed the rotation pairs again.

### 5.3 Transport

| Situation | How B reaches A | TLS | Notes |
|---|---|---|---|
| Two instances on one machine (tests, demos) | loopback origin | none (loopback http) | counts as **local** for `privacy.localOnly` |
| LAN | A at `remote.publish = network` (TLS listener, self-signed pin or company CA) | pinned through the invite | allow-list of client subnets applies; mTLS optional |
| Tailnet | A at `remote.publish = tailnet` (`tailscale serve` → loopback API) | Tailscale certificate, normal CA validation + pin | B enters A's MagicDNS name (`a-host.<tailnet>.ts.net`) or tailnet IP; Tailscale ACLs are an extra fence |
| Internet without VPN | not supported | — | never public; no Funnel |

- The federation endpoints are **mounted in `packages/api`** next to the A2A routes (P3), not on a new listener.
- **Tailscale stays optional** (decided 2026-10-19, Q6). The harness needs only an address the owner enters;
  `detectTailscale` shows status (Tailscale running, signed in, the peer's tailnet name reachable) and fills in the
  MagicDNS name, never required. No Tailscale API key, no tsnet in v1; a tsnet node per instance and the Tailscale
  identity as an extra peer factor are later options.
- **Egress for outbound peer calls.** Tailnet addresses are in `100.64.0.0/10`, which the SSRF guard classifies as
  `shared-address-space` and refuses (`tools/web/ip.ts`); LAN peers are private addresses, refused too. A peer record
  therefore carries a **network class** (`loopback | lan | tailnet`) and its pinned address(es); the egress decision for
  a call to that peer allows exactly that address and port, nothing else in the range (ADR-008 D63's `network: "local"`
  idea, made per peer). Peer calls go through `egress.request` (P7), never a raw socket.

### 5.4 Pairing (trust bootstrap)

1. Owner A turns on federation and chooses **Invite a peer**. The core issues a **federation invite**: an eight-character
   code from the identity alphabet (40 bits), valid **10 minutes**, one use, at most three open, stored only as a salted
   hash (identity.md rules); a link
   `plur1bus://federate?origin=<A origin>&code=XXXX-XXXX&exp=<s>&pin=sha256:…&fp=sha256:…&tag=<hmac>` and its QR data.
2. Owner B enters the link (or origin + typed code) in **Add a peer**. For a typed code B first runs **pair-proof**
   against A, so a TLS-intercepting relay is detected before the code is sent (remote-access.md).
3. B redeems with its instance card; A answers with its own. Both sides compute a **short authentication string** (six
   groups of digits from both fingerprints and the invite tag) and show it with the other side's display name and
   origin. **Both owners must confirm** that the strings match (by phone, in person, or over a channel they trust); until
   both confirmed, the pair is `pending` and nothing else is allowed. Confirmation has its own 10-minute window.
4. On confirmation each side stores a **peer record** and audits `federation.peer.paired`. Failed redemptions count against
   the invite and the source like device pairing (five failures in ten minutes lock the source for 15 minutes, ten burn
   the code).

**Peer record** (`state/peers.json`, `0600`, atomic writes, closed schema, tombstones kept like `devices.json`):
`{ id, displayName, installationId, publicKey, fingerprint, origins[], networkClass, pinnedAddresses[], tlsPin?,
pairedBy, pairedAt, lastSeenAt, scopes[], localForPrivacy: boolean, status: pending|active|suspended|revoked, revokedAt? }`.

### 5.5 Connection authentication

- Every connection starts with a **challenge**: the callee issues 32 random bytes bound to the TLS session (or the loopback
  socket); the caller signs `label | challenge | callee fingerprint | caller fingerprint` with its instance key; the callee
  checks the signature against the peer record. The result is a short-lived session credential (15 minutes, renewable)
  bound to the connection, never written to disk.
- Every A2A or extension request additionally carries a nonce and timestamp (±120 s) to refuse replays.
- A revoked or suspended peer is refused before any work; revocation closes its live connections (DeviceStore close
  callbacks).

### 5.6 Federation extension methods (A2A)

| Method | Direction | Purpose | Scope |
|---|---|---|---|
| `federation/hello` | both | exchange instance cards, versions, extension level | `federation.card.read` |
| `federation/project.list` | guest → home | projects shared with this guest | `project.read` |
| `federation/project.get` | guest → home | brief, board, members, agent slots (redacted) | `project.read` |
| `federation/project.subscribe` | guest → home | SSE of board and session events for the share | `project.read` |
| `federation/agent.offer` | guest → home | announce an agent the guest offers (display name, skills, window claim, model locality) | `agent.offer` |
| `federation/join.request` / `join.accept` / `join.leave` | both | session join handshake (§9, §10) | `agent.join` |
| `federation/context.fetch` | guest → home | the context package for a join (§9) | `agent.join` |
| `federation/window.update` | both | a participant's usable window changed (model switch, leave) | `agent.join` |
| `federation/loan.request` | borrower → lender | ask for an agent for a named borrower project (optional; the lender answers with an offer or not at all) | `agent.loan` |
| `federation/loan.offer` / `loan.accept` / `loan.decline` | lender → borrower / back | loan offer with the package manifest, scope, expiry and restrictions; acceptance with the model mapping (§7.3) | `agent.loan` |
| `federation/loan.package.fetch` | borrower → lender | the loan package after acceptance | `agent.loan` |
| `federation/lease.renew` | borrower → lender | heartbeat; answered with a new lease or a refusal (recalled, expired) | `agent.loan` |
| `federation/loan.recall` | lender → borrower | end the mission now | `agent.loan` |
| `federation/loan.memories.push` | borrower → lender | a batch of mission memories (live or at return, Q10); acknowledged per batch | `agent.loan` |
| `federation/loan.return` | borrower → lender | mission ended; final memory batch, removal confirmed | `agent.loan` |
| `federation/handover.offer` / `handover.accept` / `handover.confirm` / `handover.decline` | giver ↔ receiver | the three-step permanent hand-over (§7.4) | `agent.handover` |
| `federation/handover.package.fetch` | receiver → giver | the signed hand-over package after both owners agreed | `agent.handover` |
| `federation/handover.done` | receiver → giver | import finished, new agent ID; the giver archives the original | `agent.handover` |

Agent work itself (consults, delegations, join turns) uses the standard A2A `message/send|stream`, `tasks/get|cancel`
with the D104 contract in a `data` part and the W3C `traceparent` in message metadata.

## 6. Peer principal and scopes

- `peer:<peer id>` with `kind: "peer"`; it is neither a person nor an agent. `authorize()` refuses every `humanOnly` action
  (the check is "not explicitly a person", so this already holds), every role-based grant (a peer has no role) and every
  action outside its scopes.
- **Scopes** (closed list, granted per peer and narrowed per share): `federation.card.read`, `project.read`,
  `project.contribute`, `agent.offer`, `agent.join`, `agent.serve` (the home may call the guest's offered agent),
  `agent.loan` (loans in either direction with this peer) and `agent.handover` (hand-overs in either direction). The
  last two are off for a new peer; an Owner turns them on per peer.
- A request from a peer may carry an **acting-person assertion** (an opaque, peer-signed id of the remote person who
  triggered it). It is recorded in audit and trace for attribution only; it never authorises anything locally.
- Peers never reach the control profile, `memory.*`, `secret.*`, `config.*`, `admin.*`, `identity.*`, `device.*`, chats or
  agents outside a share.

## 7. Contributing agents

### 7.1 Variants

| | (a) Agent as a service (**default**) | (b) Join into the session (opt-in) | (b2) Loan on a mission | (b3) Permanent hand-over |
|---|---|---|---|---|
| What happens | the home orchestrator sends a D104 contract to the peer's agent; it runs at the peer and returns `plur1bus.return/1` | the peer's agent becomes a **participant** of the shared session and takes turns with the full shared context; it still runs at the peer | the lender's agent definition goes to the borrower for one mission (a borrower project), runs there under a lease and comes back at the end (§7.3) | the giver's agent definition and selected memories move to the receiver, which becomes the owner (§7.4) |
| Where the model runs | at the peer (its local model stays local) | at the peer | at the borrower, on a borrower model mapped from the agent's model profile | at the receiver |
| Ownership and identity | peer | peer | **stay with the lender**; the borrower shows "on loan from" | **move** to the receiver: new agent ID with provenance "handed over from" |
| Data that leaves its instance | the contract (≤ 2 k tokens) + context excerpts the contract names | the context package (§9), then every new session event | lender → borrower: definition, explicitly selected memories (copies, tainted); borrower → lender: mission memories | definition + selected memories, signed; never secrets |
| Who pays | the peer, from its own budget | the peer, per turn | the borrower (its models, its budget) | the receiver from then on |
| Both instances online | per task | per session | **required**: lease and heartbeat; lender offline → mission pauses; borrower offline → agent returned after grace | only during the hand-over |
| Fits | split tasks, reviews, independent sub-problems | pair work, long design sessions, "beide arbeiten im selben Verlauf" | "einen Agenten verleihen / auf Mission oder Projekt schicken": the borrower's project needs the lender's agent, on the borrower's machine and data | giving an agent away for good ("permanent übergeben") |
| Window negotiation (§10) | per contract: the package must fit the peer's window | **mandatory** for the whole session | the mapped model must offer at least `federation.context.minWindowTokens` usable window; the mission session uses the borrower's normal compaction policy | the receiver's own policy |

**Decided 2026-10-19 (Q2):** (a) is the default for every offered agent, because the local model stays with its owner
and the outflow is bounded per task. (b) is opt-in per share (the home owner allows `agent.join`) and per agent (the
guest owner allows this agent to be joined). (b2) and (b3) are part of the feature at the owner's request; both need
the peer scope `agent.loan` or `agent.handover`, which is off by default.

### 7.2 Agent as a service in the M5 model

- A peer's offered agent appears on the home as a **remote project member** `peer:<id>/agent:<agentId>` with display name,
  skills and window claim. It is a `DelegationTarget` of a new kind `peer` (today `local | external | a2a`); M5 keeps a
  single `delegate_task` and one ticket path, as `target.ts` requires.
- On the guest, the incoming task runs as a **project session** owned by `collab-peer:<home peer id>:<projectId>`, inside
  the agent's own `AgentScope`, with the guest's tools, D109 decisions, approvals and budget. The guest owner can require
  approval for every incoming task (`federation.serve.requireApproval`, default `true`; decided 2026-10-19, Q8).
  Optionally the guest owner turns on **auto-accept for a paired peer** (`autoAccept` in the peer record, off by
  default): tasks from that peer start without a prompt as long as the offered agent's daily token cap
  (`agent.offer.dailyTokens`) is not used up; once it is, every further task of the day waits for approval again, and
  a task whose contract asks for more than the rest of the cap is never auto-accepted. Auto-accept never covers joins,
  loans or hand-overs.
- The guest's agent recalls nothing from its owner's memories into the shared work unless its owner turned that on for
  the share (`share.guestMemory: none | agent-private-read`, default `none`); nothing it learns is captured into its store
  from shared content without that switch. ADR-003 Q4 (stateless external agents) is the default.
- **Memories in a share (decided 2026-10-19, Q3):** a memory reaches a peer only as an explicitly selected **share item**,
  one entry at a time, chosen by the person who owns it. The guest receives a **copy** marked with its origin
  (`origin.system: "peer:<id>"`, `sourceRef` naming the home memory), treated as tainted data on the guest; removing the
  item from the share sends `federation.share.item.revoked`, and a cooperative guest deletes its copy (the home cannot
  enforce that; the UI says so). Worktree files are not share items in v1.

### 7.3 Lending an agent on a mission (b2)

Owner 2026-10-19: „Einen Agenten sollte man verliehen / auf Mission/Projekt schicken können. Dabei müssen die x
PLUR1BUS-Instanzen online bleiben (logisch).“

**Principle.** Ownership and identity stay with the **lender**. For the mission the agent runs at the **borrower**, on
the borrower's models and budget, inside one borrower project (Q14), for a bounded time, and only while a valid **lease**
from the lender exists. The lender can recall it at any time; at the end it is returned and its mission memories flow
back.

**Flow.**

1. **Offer** (lender Owner, `humanOnly`, T3 surface): agent, peer, **scope** (one borrower project, Q14; the borrower
   names the project in its acceptance, or the lender answers a borrower's loan request that already names it), **expiry** (`expiresAt`, at most
   `federation.loan.maxDays`), **lender restrictions** (tool families, effects or skills the agent must not use at the
   borrower; they can only narrow), the list of **selected memories** to send (default none) and whether the borrower
   may keep copies of mission memories after the return (Q13). `federation/loan.offer` carries the package manifest
   (names, counts, hashes; no content) so the borrower sees what would arrive.
2. **Acceptance** (borrower Owner or the project lead with Owner/Admin approval, `humanOnly`): the borrower picks the
   **model mapping** (below), sees the effective tool profile (below) and accepts. Only then does the borrower fetch the
   package (`federation/loan.package.fetch`).
3. **Mission.** The borrower registers the agent as a **mission agent** `peer:<lender>/agent:<agentId>`, shown with
   "on loan from <lender display name> until <expiry>", as a member of the scoped project only. It is not visible to
   other projects, chats or channels of the borrower and cannot be addressed outside the project.
4. **End.** The mission ends on whichever comes first: the borrower ends it (`federation/loan.return`), the expiry, the
   lender's recall (`federation/loan.recall`), revocation of the peer, or a grace timeout (below). At the end the
   borrower stops the agent at the next turn boundary, pushes the remaining mission memories, removes the definition,
   the selected-memory copies and (unless kept by Q13) the mission memories, and confirms the removal in
   `loan.return`; the lender audits `federation.loan.returned`.

**Loan package** (built on the lender from the `plur1bus.agent-export/1` bundle of `agent.export`, signed with the
instance key, content-hashed):

- **Agent definition:** persona and instructions, skills (by id, version and hash; a skill the borrower does not have
  arrives as a package that passes the borrower's own X1 inspection, or the skill stays unavailable), tool profile,
  model profile (model class from the D105 class table, required capabilities such as tools or vision, minimum
  context window, preferred model names as hints only).
- **Selected memories:** only entries the lender Owner selected explicitly; each is a **copy** with
  `origin.system: "peer:<lender>"`, `sourceRef` to the lender's entry and the mission id; on the borrower they live only
  in the mission agent's store and count as tainted data (D109). Default: no memories.
- **Never:** secret values, OAuth tokens, credentials, device tokens, the instance key. Secret **references** in the
  definition are reduced to names; the borrower binds its own secrets to them or the dependent tools stay unavailable.
  The lender's other agents, chats, projects and private memories that were not selected never enter the package.

**Model-profile mapping.** The borrower maps the agent's model profile onto models available at the borrower: the D105
class table and the D112 catalogue propose the smallest borrower model of the requested class that has the required
capabilities and the agent may use under the borrower's policy; the borrower Owner can pick another allowed model.
The usable window of the mapped model (`avail` as in §10.1) must be at least `federation.context.minWindowTokens`,
otherwise acceptance is refused (`E_DENIED`, reason `context-window-too-small`); below
`federation.context.warnWindowTokens` the borrower confirms. Under the borrower's `privacy.localOnly` only local models
can be mapped. If the lender's offer requires `local` model locality (for example because the agent's selected
memories are private), the borrower must map a local model; the claim is unverifiable and the offer dialog says so.

**Rights.** The borrower's policy governs what the agent may do at the borrower: its RBAC rights in the scoped project,
the borrower's D109 capabilities, grants, approvals and roots. The **effective tool profile** is the intersection of
the agent's own tool profile, the borrower's policy for mission agents (default: the borrower's agent defaults, no
standing grants; every grant is made by a borrower person for this mission and ends with it) and the lender's
restrictions. Approvals for the agent's actions are asked of borrower persons; the lender is never asked to approve a
borrower action and cannot grant anything at the borrower. Depth 1 holds: a mission agent has no federation tools and
cannot be lent on, handed over or exposed to a third instance.

**Lease and liveness.** "Both instances stay online" is enforced, not assumed:

- The lender issues a **lease** (signed: loan id, agent, borrower fingerprint, `notAfter`), valid for
  `federation.loan.leaseTtlMs` (proposed 120 s). The borrower renews it every `federation.loan.heartbeatMs` (proposed
  30 s) through `federation/lease.renew`; the lender answers with a new lease or a refusal (`recalled`, `expired`,
  `revoked`).
- The borrower's turn loop and tool dispatcher check for a **valid lease before every model call and every tool call**
  of the mission agent (one check in the dispatcher's `policy.decide` path, not in prompts). Without one the mission is
  **paused**: no new model call, no new tool call; a running tool call that can be cancelled is cancelled, one that
  cannot is allowed to finish and its result is held, not acted on.
- **Lender offline:** renewals fail, the lease expires, the mission pauses at once and resumes automatically when a
  renewal succeeds again. If the lender stays unreachable longer than `federation.loan.lenderGraceMs` (Q9), the
  mission **ends** as if returned; mission memories not yet delivered stay in the borrower's **outbox** (encrypted at
  rest with the borrower's secret-store key, never readable by the borrower's agents) and are delivered at the next
  connection, or discarded by the borrower Owner after `federation.loan.outboxDays`.
- **Borrower offline:** the lender sees no renewals. After `federation.loan.borrowerGraceMs` (Q9) the lender marks the
  loan `returned-by-timeout`; the agent is fully the lender's again. A borrower that comes back finds its lease expired
  and the loan ended: it cannot resume, delivers its outbox, removes the definition and confirms.
- **Recall:** `federation/loan.recall` takes effect at the borrower's next turn boundary; an unreachable borrower is
  stopped at the latest when its lease expires, because the lender no longer renews.

**Mission memories.** Memories the agent forms during the mission are stored at the borrower in the mission agent's
own store, tagged with the mission id and `origin.system: "peer:<borrower>"`. They flow back to the lender through
`federation/loan.memories.push`, either **continuously** (in batches, each acknowledged, recommended) or **only at the
return** (Q10). The lender imports them into the agent's store through `memory.import` with provenance `mission`
(`sourceRef: "mission:<loanId>@<borrower fingerprint>#<n>"`) and the duplicate and conflict handling of the importer;
they stay marked as peer-originated content, so a turn that recalls them is tainted for D109. The lender Owner may
choose review instead of direct import (`federation.loan.memoryReturn: import | propose`, default `import`; `propose`
files them as memory proposals). At the borrower the mission memories are removed after the confirmed delivery, or
kept as copies tagged with the mission if the keep option of Q13 applies.

**Relationships and levels (amended 2026-10-20, D116 point 9).** When the lent agent talks to a person at the
borrower, the relationship *agent × borrower person* is the active one; mission memories are captured with that
relationship, the mission as context and a confidentiality level (`teilbar`, `vertraulich`, `privat`). They keep
flowing back **continuously** (Q10 unchanged), but **separated by relationship and level**: every item in a
`federation/loan.memories.push` batch carries its relationship key and level, and the lender imports them as entries
of that foreign relationship. In conversations with the home person they follow the D116 rules: `teilbar` with an
origin label, `vertraulich` usable but never disclosed, `privat` never in the prompt. Home memories in the loan
package keep their relationship and level; `privat` entries cannot be selected for a loan package. Reports to the
parent go through the project level (D115 report channel, WP14), not through relationship memories. Details:
[`2026-10-20-memory-tree-relationships-design.md`](2026-10-20-memory-tree-relationships-design.md) §12.

**The agent at home during the loan.** The lender's agent stays defined at home. Whether it keeps working there in
parallel, or is locked to "on mission" while the loan runs, is owner question Q11 (recommended: keeps working; the
mission runs as a separate mission instance with its own memory namespace, and only its memories come back).

**Audit and trace.** Both sides audit offer, acceptance, package delivery (hash, counts), lease state changes
(`paused`, `resumed`), recall, return, memory batches (counts, hashes, no content) and removal. The borrower's trace
holds the mission sessions; the lender receives a **redacted mission summary** (sessions, turns, tool calls by family,
tokens, status) at each memory push and at the return, and sees no borrower content beyond the mission memories.

### 7.4 Handing an agent over permanently (b3)

Owner 2026-10-19: „Ein permanent-Übergeben-Feature wäre natürlich nur folgerichtig.“

**Principle.** Ownership and identity move. The receiver creates a **new agent** with its own agent ID and records
where it came from; the giver keeps an **archived** original. Nothing is deleted by the hand-over itself.

**Three steps, both owners confirm:**

1. **Offer** (giver Owner, `humanOnly`, T3): agent, receiver peer, the memories to include (default none; selection
   per entry or "all agent-private memories" as an explicit choice), and a note. The offer carries the package
   manifest (names, counts, hashes, embedding identity of the memories), valid 7 days.
2. **Acceptance** (receiver Owner, `humanOnly`, T3): the receiver sees the manifest, the skills it would have to
   install, the secret names it will have to bind, and the model-profile mapping proposal (as in §7.3), and accepts.
3. **Confirmation** (giver Owner, `humanOnly`, T3): the giver sees the acceptance and the receiver's display name and
   fingerprint again and confirms. Only now does the receiver fetch the package (`federation/handover.package.fetch`).
   Either side can decline or withdraw until this point; an offer that is not confirmed expires.

**Hand-over package** (`plur1bus.agent-export/1` bundle of `agent.export`, extended by the hand-over header: giver
fingerprint, receiver fingerprint, offer id, both confirmations; signed with the giver's instance key, SHA-256
manifest):

- definition (persona, instructions, skills by id/version/hash with the same X1 rule as §7.3, tool profile, model
  profile) and the selected memories as text with metadata and their **embedding identity**;
- **never secrets**: values are stripped as `agent.import` already does; references stay as names and the receiver
  binds its own;
- no vectors are trusted across instances. **Re-embedding at the receiver:** memories are imported through
  `memory.import`; when the giver's embedding identity differs from the receiver store's, each entry is embedded with
  the receiver's model at import. If the receiver's store is itself in a re-embedding migration, the entries are parked
  as `pending-reembed` and carried along by `memory reembed`, exactly as the importer does for OpenClaw cards
  (`docs/import.md`). The package never creates a second vector space in the receiver's store.

**At the receiver.** `agent.import` verifies signature, hash, receiver fingerprint and both confirmations, imports
with `onConflict: rename`, and assigns a **new agent ID** with provenance
`handedOverFrom: { instanceFingerprint, displayName, agentId, offerId, packageHash, at }`, shown on the agent page.
Rights are bounded by the receiver's policy (no grants travel; the receiver's D109 defaults apply). Imported memories
carry `origin.system: "peer:<giver>"` and `sourceRef` to the giver's entry and count as peer-originated content for
D109 like every other memory that crossed the link. The receiver confirms with
`federation/handover.done` (new agent ID, import counts).

**At the giver.** On `handover.done` the giver **archives** the original (`agent.archive`): no chats, jobs, channels or
offers; its store stays untouched. Final deletion is a separate, explicit, `humanOnly` action (`agent.delete` with its
typed confirmation), never part of the hand-over. If `handover.done` does not arrive within the package window, the
giver keeps the agent active and the hand-over is marked `incomplete`; a retry uses the same offer id, and the receiver
refuses a second import of the same package (replay).

**Undo.** Whether a hand-over can be reversed within a period, and by whom, is owner question Q12 (recommended: 7 days,
started by the giver, confirmed by the receiver; the receiver's agent is archived, the giver's original unarchived;
memories formed at the receiver stay with the receiver unless both agree to send them back).

**Controlled transfer of everything (amended 2026-10-20, D116 point 10).** Owner 2026-10-20: „Alles wird kontrolliert
an den neuen Owner übergeben.“ This replaces the default "memories to include: none" of step 1: the package contains
the agent's **whole memory tree** (agent level, relationships, project entries the project allows) with nodes,
relationships, contexts and confidentiality levels; the giver reviews the manifest per branch and level before the
confirmation in step 3; secrets stay names only and voice templates never travel. At the receiver the giver's
relationship with the agent becomes **„Früherer Mensch: <Name>“** (exactly this label, no gendered form); its levels
stay in force (`teilbar` usable with origin label, `vertraulich` never disclosed, `privat` never in conversations with
the new person); the new person's "Mein Mensch" and "Wir" start empty. The 7-day undo (Q12) is unchanged. How
relationships of persons other than the giver move is D116 owner question Q12. Details:
[`2026-10-20-memory-tree-relationships-design.md`](2026-10-20-memory-tree-relationships-design.md) §13.

**Audit** on both sides: `federation.handover.offered|accepted|confirmed|declined|delivered|done|incomplete`, with
package hash and counts, never content.

## 8. Orchestration

### 8.1 Modes

| Mode | Meaning | Mechanism | Merge |
|---|---|---|---|
| **Distributed** (default) | the orchestrator splits the instruction into sub-tasks and assigns each to one agent (local or peer) | `delegate_task` per sub-task with a D104 contract; dependencies expressed as board cards | results land as returns on their cards; L10 external verifiers (tests, lint) decide success, not self-reports |
| **Parallel** | several agents work on the same contract independently | M5 fan-out (one contract, N targets) | `best-of` by verifier result, `review` (a reviewer agent merges with citations), or `owner` (the person picks); the choice is part of the contract |

Fan-out stays **off** by default (`collaboration.fanoutEnabled`); parallel mode across instances needs it on and its
own switch `federation.parallelEnabled` (default `false`), because it multiplies cost on both sides.

### 8.2 Roles

- The **home instance's lead agent** is the orchestrator; the home owner (or a project lead) starts and aborts work.
- Joined agents (variant b) can post to the board and propose sub-tasks, but cannot delegate across instances
  themselves (depth 1, ADR-003 Q5).

### 8.3 Budget and cost

- **Each instance pays for its own model calls** and enforces its own budget ledger (M2). The home's project budget
  covers home-side spend; peer usage is reported in the return's `cost` field and shown, but never booked against the
  peer's money by the home.
- The guest can refuse a task with a budget reason; the orchestrator sees a refusal, not a silent timeout.
- Per peer and share: request limits (A2A defaults: 60 requests/min per peer, 8 live tasks, 8 streams), a daily token
  cap the guest owner sets for each offered agent (`agent.offer.dailyTokens`).

### 8.4 Guardrails across instances

- Depth 1 holds globally: a peer's agent that runs a contract has no federation tools; a contract that arrives from a
  peer cannot be delegated to a third instance (**no transitivity**). The same holds for loans: a mission agent cannot
  be lent on, handed over, offered as a service or joined to another instance's session.
- With several peers per project (Q4) every pair is checked on its own: a guest sees only what its own share allows,
  never another guest's items, offers or turns beyond what the shared session itself contains.
- Cycle and repeat detection use the trace id, which travels in `traceparent`; a guest refuses a contract whose trace
  already contains a span of its own instance for the same project.
- Time limits from the contract's deadline; user abort on the home sends `tasks/cancel` to every live peer task; a
  guest abort returns a `partial` return.

### 8.5 Trace across instances

- One W3C trace per orchestration, root span on the home. Each peer task is a span; the guest returns a **redacted span
  summary** (agent, duration, token counts, cost if known, status, preview) that the home stitches into its trace.
- Replay (`collab.session.replay`) works for home-side sessions. A guest session is replayable on the guest by its owner;
  the home sees only the summary, unless the guest owner shares the transcript for that span.

## 9. Context hand-over on join

**What a joined agent receives (context package, built on the home):**

1. **Project brief:** name, goal, instructions, acceptance criteria, members and agent slots.
2. **Session summary:** the newest applied compaction summary of the shared session (the existing tiered summaries,
   `summaryMaxTokens`), or a fresh one (§10.3).
3. **Recent turns:** the newest whole turns that fit the remaining budget (never cut inside a turn; the newest turn always
   included, as `Compactor.prepare` does).
4. **Referenced excerpts:** cards, artifacts and tool results the recent turns point to, clipped with pointers
   (`truncateWithPointer`).

**Never in the package:** zone 3 (the home agent's frozen memory snapshot) and the volatile tail (recall blocks) of any
home agent — those are the home user's memories (M5 acceptance 4); incognito sessions (they cannot be shared at all);
secrets; content the redactor removed.

**Full transcript:** only when the home owner chooses it for this join; it still passes redaction, still must fit
(§10) and is still marked untrusted.

**Redaction:** the shared redactor (`logs` redactor with PII on, as collab traces use) plus secret patterns runs before
the package leaves; the package records `transformedBy: ["redact", "truncate"]` in its provenance.

**Taint:** everything that arrives from a peer — returns, joined-agent turns, board posts — enters the home as data with
a provenance envelope (`origin.system: "peer:<id>"`, `origin.agent`, `hops`), never as system or user text. A home turn
that consumed peer content is **tainted** for D109 (P8): side-effect tools require approval even where they would not
otherwise. The same holds on the guest for content from the home.

## 10. Context-window negotiation

### 10.1 What "window" means here

For each participant *i* the relevant number is not the raw model window but the window **available for shared
context**:

`avail_i = contextWindow_i − fixed_i − reserve_i`

- `contextWindow_i`: the catalogue's `contextWindow` for the participant's effective `(provider, model)`
  (`session/catalog.ts`; unknown models use the existing conservative fallback, and fallback candidates count with their
  smallest window, as `docs/architecture/compaction.md` already does).
- `fixed_i`: the participant's own zones 1–3 (tools, system, its frozen snapshot), which are not shared but occupy its
  window (ADR-010 §1).
- `reserve_i`: output reserve (the model's max output setting, at least 10 % of the window).

Home participants are computed locally. A peer reports `avail_i` and `contextWindow_i` in `join.request` and
`window.update`; the claim is signed but cannot be verified, so the home uses `min(claim, contextWindow from its own
catalogue for the named model, if known)`.

**Effective session window** `W = min_i avail_i` over all current participants (home agents included).

### 10.2 Join flow

1. Guest sends `join.request` with its agent's `avail`, `contextWindow`, model locality (`local | cloud`) and tokenizer
   family.
2. Home computes `W'` with the new participant. If `W' < federation.context.minWindowTokens` the join is **refused**
   (`E_DENIED`, reason `context-window-too-small`, with both numbers). If `W' < federation.context.warnWindowTokens` the
   home owner confirms with the consequence shown (more frequent compaction, less history per turn).
3. Home sets the shared session's window to `W'` at runtime: `Compactor.configureModel(sessionId, model, W')` already
   scales `summaryMaxTokens` and `maxMessageTokens` to a smaller window; the bound applies from the next view.
4. If the current view exceeds `compactAtRatio × W'`, the join would force a compaction of the running session. The home
   **asks its owner first** (decided 2026-10-19, Q7): the dialog names the joining agent, `W'`, how much history the
   summary replaces and the prompt-cache cost (§10.5); only on confirmation does the home compact **before** sending
   the package (§10.3). Declining refuses the join (`E_DENIED`, reason `compaction-declined`). The confirmation is
   never skipped, not even for an auto-accepted peer (§7.2).
5. Home sends `join.accept` with `W'` and the package; the guest's agent starts with a view that fits.

### 10.3 Runtime compaction

- The **foreground path** must not wait for an LLM: it uses a matching prepared summary or the deterministic digest
  (`Compactor.prepare`, L14). For a join the home may instead wait up to `federation.context.joinSummaryWaitMs`
  (default 20 s) for the background `summarize` worker to produce a better summary; on timeout it uses the digest.
- Under `privacy.localOnly` the summary model must be local, as already enforced for compaction summaries.
- Compaction checkpoints still run before the swap (engine `compaction` checkpoint, skipped for incognito, which cannot
  be shared anyway).

### 10.4 The 80 % policy

- New key **`federation.context.compactAtRatio`** (number, default `0.8`, range `0.5`–`0.88`; `x-restart: live`,
  `x-tier: advanced`). For a shared session the compactor's hard bound becomes
  `min(session.compaction.hardRatio, compactAtRatio) × W` and its soft threshold
  `min(session.compaction.softRatio, compactAtRatio − 0.15) × W`, so a summary is prepared early and swapped at 80 %.
- **Before every turn of any participant** the home runs the check on the view it will send, with a conservative token
  estimate: the maximum of the home's calibrated estimate and the `chars / 4` floor, plus a 10 % margin when the
  participants' tokenizer families differ (a guest's model may count more tokens than the home's).
- After every turn the existing soft-threshold worker prepares the next summary, so the next swap is cheap.
- When a participant leaves or switches model, `W` is recomputed. A larger `W` applies to later turns only; hidden
  history is not re-inserted automatically ("hide, don't delete": the transcript keeps it, restoring would cost cache).

### 10.5 Prompt-cache consequences (ADR-010)

- A swap rewrites the conversation zone (zone 4) for **every** participant: each instance's provider cache for that
  session's tail is invalidated once per swap; zones 1–3 are per participant and unaffected.
- A smaller `W` means more frequent swaps. The existing segment rule (swap down to half the soft threshold) keeps swaps
  rare; the UI shows the swap count and `prompt.prefix-invalidated` events per participant.
- A join or leave that changes `W` is a cache-relevant action under R4: the confirmation dialog states that the next
  turn re-reads the conversation at full price for every participant.

### 10.6 Very small windows

- `federation.context.minWindowTokens` default **16 384** (`avail`, not raw window): below it a participant cannot hold a
  useful summary plus one turn; the join is refused. `federation.context.warnWindowTokens` default **32 768**: owner
  confirmation. Both `x-restart: live`, `x-tier: advanced`. The defaults 0.8 / 16 384 / 32 768 are decided
  (2026-10-19, Q7).
- For variant (a) the same numbers bound the contract plus excerpts per task; a task that cannot fit is refused by the
  orchestrator before sending.

## 11. Privacy and security

### 11.1 `privacy.localOnly`

- Sharing a project with a peer, accepting a join or serving a peer's contract **sends data off this machine** unless the
  peer is on loopback. Each share therefore needs an explicit confirmation by an Owner or project lead that names the
  peer, the level and what is shared; the record is audited.
- While `privacy.localOnly` applies to the installation **or to any agent in the project**, a share is allowed only with a
  peer whose origin is loopback or whose origin is listed in `privacy.localEndpoints` (`localForPrivacy` in the peer
  record); otherwise `E_DENIED` with reason `local-only`.
- The home also requires the guest's agent to declare **model locality `local`** under `privacy.localOnly`; the claim is
  signed but unverifiable, which the confirmation dialog says. A guest under its own `privacy.localOnly` refuses to serve
  with a cloud model.
- Loans and hand-overs send an agent definition and possibly memories off the machine. While `privacy.localOnly`
  applies to the installation or to the agent, a loan or hand-over is allowed only to a `localForPrivacy` peer, and a
  loan offer then requires `local` model locality at the borrower. Mission memories returned to the lender are peer
  content under the same rules.

### 11.2 Egress

All outbound peer calls go through `egress.request` with the per-peer address exception (§5.3). A peer cannot make the
home fetch anything else: URIs in peer content are stored, never fetched (as the A2A server already does for file
parts).

### 11.3 Secrets

The secret store is not addressable by any federation method. API keys, OAuth tokens, device tokens and the instance
private key never enter a package, a return, a trace or a log — loan and hand-over packages included: secret
references travel as names only, and the receiving side binds its own secrets. The redactor runs on every outbound payload; a test feeds
known secret fixtures through every federation path and asserts they never appear (pattern of
`packages/remote-access/test/secrets-never-leave.test.ts`).

### 11.4 Threat model

| Threat | Asset | Protection | Residual risk |
|---|---|---|---|
| Prompt injection through peer content | home agents' tools and data | provenance envelope, data-not-instructions, D109 taint → approvals for side effects | a person who approves a harmful action |
| Compromised peer instance | shared project, home availability | scopes per share, no control profile, no memories, rate limits, size caps, revocation, kill switch `federation.enabled` | everything already shared with that peer |
| Malicious peer lying about its window or locality | context bounds, privacy | home caps the claim with its own catalogue; locality claims are flagged unverifiable; `localOnly` requires local peers | a peer that claims `local` and uses a cloud model |
| Stolen invite code | pairing | 10 minutes, one use, pair-proof for typed codes, **two-sided SAS confirmation** | a person who confirms without comparing |
| MITM | link | TLS pin from the invite, challenge bound to the TLS session, instance key signatures | — |
| Replay | tasks | nonce + timestamp, idempotent `messageId` | — |
| Transitive leak | home data at third parties | no transitivity rule, trace check, guest storage of shared content tagged with the share and deleted on revocation by a well-behaved guest | a compromised guest keeps copies |
| Cost abuse | guest budget | approval per incoming task by default, daily token cap per offered agent, own budget ledger | — |
| Denial of service | both | per-peer and per-address limits (A2A defaults), failed-auth lockout before signature checks | — |
| Borrower keeps using a lent agent | lender's agent definition and selected memories | lease checked before every model and tool call, recall, expiry, grace timeout, removal confirmation, audit on both sides | a compromised borrower keeps a copy of the definition and the selected memories and runs it without the harness |
| Poisoned mission memories | lender's agent store | peer provenance and D109 taint on recall, optional review (`memoryReturn: propose`), duplicate/conflict handling of the importer | a person who accepts a poisoned memory in review |
| Forged or replayed hand-over | agent ownership | three-step confirmation by both owners, signed package bound to both fingerprints and the offer id, replay refusal, archived (not deleted) original | — |
| Secrets in a loan or hand-over package | credentials | names only, stripping as in `agent.import`, secret-fixture scan over every package | — |

### 11.5 Revocation and audit

- Revoking a peer (either side) ends live connections and joins, cancels running tasks (partials kept), stops
  subscriptions and marks the record `revoked`. Revoking a share does the same for that project only.
- Data already sent cannot be recalled. A well-behaved guest deletes cached shared content on revocation
  (`federation.share.revoked` received); the UI says plainly that the home cannot enforce this.
- Audit events (no keys, codes or content): `federation.enabled|disabled`, `federation.invite.created|redeemed|failed`,
  `federation.peer.paired|confirmed|suspended|revoked|key-rotated`, `federation.share.created|changed|revoked`,
  `federation.join.requested|accepted|refused|left`, `federation.task.received|refused|finished`,
  `federation.window.changed`, `federation.compaction.forced`,
  `federation.loan.offered|accepted|declined|delivered|paused|resumed|recalled|returned|returned-by-timeout`,
  `federation.loan.memories.pushed`, `federation.handover.offered|accepted|confirmed|declined|delivered|done|incomplete`.

## 12. Configuration (proposed keys)

| Key | Type | Default | `x-restart` | `x-tier` | Meaning |
|---|---|---|---|---|---|
| `federation.enabled` | boolean | `false` | `core` | `advanced` | mount the federation endpoints and allow pairing |
| `federation.displayName` | string | host name | `live` | `basic` | name shown to peers |
| `federation.serve.requireApproval` | boolean | `true` | `live` | `advanced` | each incoming peer task waits for owner approval, except from peers with `autoAccept` within the agent's daily token cap (Q8) |
| `federation.parallelEnabled` | boolean | `false` | `live` | `advanced` | parallel mode across instances (also needs `collaboration.fanoutEnabled`) |
| `federation.context.compactAtRatio` | number | `0.8` | `live` | `advanced` | compact shared sessions at this share of the effective window |
| `federation.context.minWindowTokens` | integer | `16384` | `live` | `advanced` | refuse joins below this usable window |
| `federation.context.warnWindowTokens` | integer | `32768` | `live` | `advanced` | confirmation below this usable window |
| `federation.context.joinSummaryWaitMs` | integer | `20000` | `live` | `advanced` | how long a join waits for an LLM summary before using the digest |
| `federation.limits.*` | object | A2A defaults | `live` | `advanced` | per-peer request, task and stream limits |
| `federation.loan.maxDays` | integer | `30` | `live` | `advanced` | longest loan an offer may name |
| `federation.loan.leaseTtlMs` | integer | `120000` | `live` | `advanced` | lease lifetime (Q9) |
| `federation.loan.heartbeatMs` | integer | `30000` | `live` | `advanced` | lease renewal interval (Q9) |
| `federation.loan.lenderGraceMs` | integer | `86400000` | `live` | `advanced` | lender unreachable this long → paused mission ends (Q9) |
| `federation.loan.borrowerGraceMs` | integer | `900000` | `live` | `advanced` | borrower unreachable this long → lender treats the agent as returned (Q9) |
| `federation.loan.memorySync` | string | `live` | `live` | `advanced` | `live` or `on-return` (Q10) |
| `federation.loan.memoryReturn` | string | `import` | `live` | `advanced` | `import` or `propose` for returned mission memories |
| `federation.loan.outboxDays` | integer | `30` | `live` | `advanced` | undelivered mission memories kept at the borrower |
| `federation.handover.undoDays` | integer | `7` | `live` | `advanced` | undo window for a hand-over; `0` = no undo (Q12) |

Peers (with their `autoAccept` flag), shares, offers, loans, leases and hand-overs are **state** (`state/peers.json`,
the collab store, a federation store for loans and hand-overs), not configuration. The proposed defaults of the loan
and hand-over keys are owner questions Q9, Q10 and Q12. All keys are written by
Owner/Admin only and are on WebMCP's forbidden list like every configuration write.

## 13. Testability

- **Two instances in one test process or CI job:** two state roots, two cores, two API listeners on loopback; a fake
  resolver and egress seam map a fake tailnet name (`peer-b.test.ts.net`) and a `100.64.x.y` address onto the second
  listener, so the tailnet class path is exercised without Tailscale.
- **Fake models with fixed windows** (e.g. 32 k and 128 k) through the session `ChatProvider` seam; deterministic fake
  summarizer; token estimates pinned.
- **Pairing:** invite, pair-proof, SAS mismatch, one-sided confirmation, expiry, brute force lockout, revocation during a
  task, key rotation, replayed requests.
- **Control profile:** schema walk comparing MCP/ACP exposure with the WebMCP forbidden set; `humanOnly` refusal of agent
  and peer principals with the real guard.
- **Sharing and privacy:** `localOnly` refusals; secret fixtures never leave; memory markers never in packages (pattern of
  `collab/isolation.test.ts`); incognito sessions not shareable.
- **Window policy:** join that fits, join that forces compaction, join refused below minimum, warning band, leave and
  re-expand, mixed tokenizer margin, swap count and cache events.
- **Orchestration:** distributed with verifiers, parallel with each merge rule, abort propagation, budget refusal on the
  guest, cycle refusal, transitivity refusal, stitched trace.
- **Loan (b2):** offer → acceptance with model mapping → package; mapped model below the minimum window refused; the
  effective tool profile is the intersection (lender restriction and borrower policy each remove a tool); **lease
  expiry pauses the mission** (no model or tool call without a valid lease, a held tool result is not acted on) and a
  renewal resumes it; lender beyond grace → mission ends, outbox delivered at reconnection; borrower beyond grace →
  lender marks `returned-by-timeout`, the returning borrower cannot resume; **recall** stops at the next turn boundary
  and an unreachable borrower at lease expiry; **mission memories pushed back** (live and on-return), imported with
  provenance, removed at the borrower or kept by option; selected memories arrive as tainted copies; mission agent has
  no federation tools and cannot be lent on or handed over; **no secrets in the package** (secret fixtures).
- **Hand-over (b3):** the three steps with both confirmations; decline and expiry at each step; **no secrets in the
  package**; new agent ID with `handedOverFrom`; **original archived, not deleted**, `agent.delete` stays separate;
  **re-embedding at the receiver** with a different embedding identity (fake embedders with different identities) and
  `pending-reembed` parking during a receiver migration; replayed package refused; undo within the window (if Q12 keeps
  it).
- **Real two-machine run** (manual, owner worksheet): two hosts on one tailnet, local models on both.

## 14. Alternatives considered

- **Private federation RPC instead of A2A** — rejected (F-R1): re-implements task lifecycle and streaming, closes the door
  to other A2A agents.
- **MCP between instances** (each instance as the other's MCP server) — rejected for agent work: MCP has no task lifecycle
  or cancel semantics for long agent runs, and it would expose tools rather than agents. MCP remains the right protocol
  for "a client controls one instance" (§4).
- **Shared state through a replicated store (CRDT, git remote of the project)** — rejected for v1: two writers, conflict
  resolution, and memories/board would leave the machine wholesale. A read-only git bundle of a worktree may be added
  as an explicit share item later (Q3).
- **mTLS as the only peer authentication** — rejected (F-R3): does not survive `tailscale serve`.
- **tsnet in-process Tailscale** — later option (Q6).
- **Truncating context per participant** instead of one effective window — rejected (F-R11).
- **Transplant without a lease** (copying a peer's agent definition to the home and running it there with no tie back
  to its owner, the earlier b2 alternative) — rejected: it would neither keep ownership with the lender nor transfer
  it cleanly. It is replaced by the loan with a lease (b2, §7.3) and the two-sided hand-over (b3, §7.4), both owner
  requests of 2026-10-19.

## 15. Owner questions

Q1–Q8 were answered by the owner on 2026-10-19; the answers are worked into the sections named. Q9–Q14 arise from the
loan and hand-over modes the owner added the same day and are open.

1. **Q1 — Placement and number.** *Status: entschieden 2026-10-19.* Beta 2 (the second beta after v0.1.0) and a new D
   number: **D114** (the next free number after D113, which #592 used for the desktop SSH remote installation). Track F
   stays outside the v0.1.0 total.
2. **Q2 — Default contribution mode.** *Status: entschieden 2026-10-19.* Default (a) agent as a service; (b) join is
   opt-in per share and per agent. **In addition, at the owner's explicit request, (b2) lending an agent on a mission
   or project and (b3) handing an agent over permanently are part of the feature** (§7.1, §7.3, §7.4; F-R14, F-R15).
3. **Q3 — What a share may contain.** *Status: entschieden 2026-10-19.* Memories only explicitly per entry (copied,
   tainted, revocable on a cooperative guest; §7.2). Worktree files not in v1; later at most a read-only git bundle as
   an explicit share item.
4. **Q4 — More than two instances in v1.** *Status: entschieden 2026-10-19.* Pairwise federation with any number of
   peers per project; a named cluster object later (§5.1, §8.4).
5. **Q5 — Full control over MCP/ACP.** *Status: entschieden 2026-10-19.* Schema-derived control profile minus the
   WebMCP forbidden set; no further families can be opened for personal tokens (§4.2).
6. **Q6 — Tailscale depth.** *Status: entschieden 2026-10-19.* v1 "enter a tailnet address" plus status detection;
   tsnet and the Tailscale identity as a peer factor later (§5.3).
7. **Q7 — Window policy defaults.** *Status: entschieden 2026-10-19.* `compactAtRatio` 0.8, minimum usable window 16 k,
   warning at 32 k stay; when a join would force compaction of a running session, the owner is asked first (§10.2).
8. **Q8 — Costs and approvals for served tasks.** *Status: entschieden 2026-10-19.* Default: approval for every incoming
   peer task; optional auto-accept for paired peers within a daily token cap (§7.2).
9. **Q9 — Lease and grace times for loans.** *Status: entschieden 2026-10-19.* Lease 120 s / heartbeat 30 s; a paused mission ends after the lender is unreachable for 24 h; the agent counts as returned after the borrower is unreachable for 15 min; `federation.loan.maxDays` 30. Lease 120 s renewed every 30 s; the mission pauses as soon as the lease
   lapses. How long may the **lender** be unreachable before a paused mission ends (proposed **24 h**), and how long the
   **borrower** before the lender treats the agent as returned (proposed **15 min**)? Is 30 days the right longest loan
   (`federation.loan.maxDays`)?
10. **Q10 — When mission memories flow back.** *Status: entschieden 2026-10-19.* Continuously in acknowledged batches; returned mission memories are imported directly (no proposal step). *Refined 2026-10-20 (D116 point 9):* mission memories keep flowing back continuously, but separated by relationship and confidentiality level; in conversations with the home person the D116 levels apply (§7.3). Continuously in acknowledged batches during the mission (recommended:
    nothing is lost if the borrower fails, the lender sees progress) or only at the return? And should returned
    mission memories be imported directly (proposed default) or arrive as memory proposals for review?
11. **Q11 — The lent agent at home.** *Status: entschieden 2026-10-19.* The lender's agent keeps working at home; the mission is a separate instance whose memories come back. Does the lender's agent keep working at home during a loan, with the mission as a
    separate instance whose memories come back (recommended), or is it locked to "on mission" until it returns?
12. **Q12 — Undo of a permanent hand-over.** *Status: entschieden 2026-10-19.* Reversible within 7 days, started by the giver and confirmed by the receiver (`federation.handover.undoDays` 7); memories formed at the receiver stay there unless both agree. Should a hand-over be reversible within a period (proposed **7 days**,
    started by the giver, confirmed by the receiver; the receiver's agent is archived, the giver's original
    unarchived, memories formed at the receiver stay there unless both agree), reversible by the giver alone, or final
    at once?
13. **Q13 — Copies of mission memories at the borrower.** *Status: entschieden 2026-10-19.* Removed at the borrower by default; only the lender may allow copies, in the offer. After the return, are mission memories removed at the
    borrower by default (proposed), and who may allow the borrower to keep copies: the lender in the offer
    (recommended), the borrower's owner, or both together?
14. **Q14 — Mission scope and visibility.** *Status: entschieden 2026-10-19.* A mission is bound to exactly one borrower project the lender does not see; the lender receives only the redacted mission summary and the mission memories. Is a mission bound to exactly one borrower project that the lender does not
    see (recommended; the lender receives only the redacted mission summary and the mission memories), or may a loan
    also go into a project the borrower shares with the lender, with the lender seeing the project as a guest?
