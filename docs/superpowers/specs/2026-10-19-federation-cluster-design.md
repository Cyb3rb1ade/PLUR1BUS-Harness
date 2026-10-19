# Federation: full protocol control and clusters of PLUR1BUS instances — design

**Status:** Draft for owner review (phase 1: specification and plan, no product code) · **Date:** 2026-10-19 ·
**Owner:** Christian (Cyb3rb1ade) · **Track:** F (federation), new; target **Beta 2**, after v0.1.0 · **Plan:**
[`2026-10-19-federation-cluster.md`](../plans/2026-10-19-federation-cluster.md)

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
   peer's model and budget) or **joins** it into a shared session (it then follows the whole session context).
5. **Orchestration.** The project owner's instance orchestrates: work is **split** across agents or done **in parallel**
   and merged, using the M5 consult/delegate machinery, the D104 hand-off format and one trace across instances.
6. **Context-window safety.** When an agent joins a session, the harness determines the smallest usable context window of
   all participants, compacts the running session at once if it does not fit, and from then on compacts ahead of every
   turn at a configurable share (default **80 %**) of that smallest window.

**Non-goals (this design).**

- Not part of **v0.1.0**. Federation needs M3 remote access, M5 and the M6 protocol work on `main` first (§3). Target is
  the second beta after v0.1.0 ("Beta 2", owner question Q1).
- No shared database, no replicated memory store, no consensus protocol. Each instance stays the only writer of its own
  state; a shared project has exactly one **home instance** (the owner's).
- No memory sharing by default. No secret ever crosses the link (§11.3).
- No public exposure. The federation listener rides the existing `remote.publish` levels (`tailnet`, `network`); `local`
  admits only peers on the same machine. Funnel stays forbidden at every level.
- No automatic discovery in v1 (no mDNS, no tailnet scan). A peer is added by address or by a pairing link.
- No transitive federation: B never forwards A's project to C (§8.4).
- No remote administration. `admin.*`, `humanOnly` actions, configuration writes and process control are never
  reachable by a peer, and "full control" for MCP/ACP clients does not widen them (§4.4).
- No transplanting of a peer's agent definition into the home instance in v1 (variant b2 in §7.1).

**Relation to earlier decisions.** ADR-008 already plans an MCP server, an ACP client and an A2A 1.0.0 client and server
with peers registered by URL, a trust level, an allowlist and a budget. ADR-003 Q4 (external agents stateless) and Q5
(depth 1) hold across instances. This design adds: a peer identity and pairing (instead of bearer keys typed into a peer
table), a PLUR1BUS control profile on the three protocols, project sharing, the join mode and the context-window
negotiation. It needs a new D number on acceptance (Q1).

## 2. Decisions at a glance

| # | Topic | Decision (recommendation) | Main alternative, why not |
|---|---|---|---|
| F-R1 | Peer-to-peer protocol | **A2A 1.0.0 (JSON-RPC + SSE) with a PLUR1BUS federation extension** for agent work between instances; the extension adds project, context and window methods. | A private `federation.*` RPC: duplicates task lifecycle, streaming and cancel that A2A already defines; peers of other vendors could never take part. |
| F-R2 | "Full control" for clients | **One schema-derived control profile**: MCP tools `plur1bus_<method>` and ACP extension methods `_plur1bus/<method>`, both generated from `rpc.schema.json` with the WebMCP provider's derivation and forbidden set. | A hand-kept tool list per protocol: drifts from the RPC schema, as ADR-008 already warns for MCP descriptors. |
| F-R3 | Peer identity | **Ed25519 instance key** per installation, fingerprint `sha256:` like device keys; per-connection challenge signature (the F44 `DeviceStore.connect` pattern) on top of TLS. Optional mTLS on a direct `network` listener. | mTLS only: `tailscale serve` terminates TLS, so a client certificate never reaches the harness on the `tailnet` level. |
| F-R4 | Trust bootstrap | **Federation invite**: eight-character code, 10 minutes, one use (identity/pairing code rules), link carries origin, TLS pin and instance fingerprint; **both owners confirm** a short authentication string. | Bearer keys typed into a peer table (today's A2A server): no mutual identity, no revocation story, keys in chat messages. |
| F-R5 | Transport | **LAN or tailnet**, through the existing exposure levels. Tailscale is optional: a peer address is a MagicDNS name or tailnet IP the owner enters; no tsnet in v1. | tsnet in-process (Q6): a second Tailscale node per instance, Go dependency, larger change. |
| F-R6 | Peer principal | New principal kind **`peer`** (`peer:<id>`), no role, **scopes only**, deny by default; `humanOnly` refuses it like an agent. | Mapping a peer to a harness user: a remote installation would hold a local account and its role. |
| F-R7 | Sharing unit | **One project**, level `read` or `contribute`; shared: project brief, board, trace (redacted), selected artifacts. **Not shared by default:** memories, worktree files, chats outside the project. | Sharing an agent or a whole instance: far wider than the request ("einzelne lokale Projekte"). |
| F-R8 | Contributing an agent | **(a) Agent as a service is the default**: the agent runs at its owner's instance with its owner's model, budget and approvals. **(b) Join** is offered for session work; execution still stays at the peer. | Running the peer's agent on the home instance: the peer's local model is unavailable there, and its persona would leave its machine. |
| F-R9 | Orchestrator | **The home instance** (project owner's lead agent) orchestrates; peers execute contracts. | Symmetric orchestration: two writers of one board and session, conflict resolution, no single trace root. |
| F-R10 | Context on join | **Context package**: project brief + compaction summary + newest turns that fit + referenced excerpts; redacted, tainted. Full transcript only by explicit owner choice per join. | Raw history by default: leaks more than needed and usually does not fit the smaller window anyway. |
| F-R11 | Window negotiation | Effective window = **min over participants of the window available for shared context**; runtime compaction on join; pre-turn policy **compact at 80 %** (configurable); join refused below a minimum. | Truncating per participant: every agent sees a different history, and the shared summary diverges. |
| F-R12 | Privacy | Sharing with a peer **is data leaving the machine**: explicit confirmation per share; under `privacy.localOnly` only peers that count as local. | Treating a peer like a web tool (egress only): `privacy.localOnly` exists to stop exactly this kind of outflow to models elsewhere. |
| F-R13 | Switch | `federation.enabled` **false** by default; nothing listens and no peer can pair until an Owner turns it on. | On by default: new attack surface on every install. |

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
work without it); P6–P9 gate the security acceptance, not the first prototype.

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
| Federation | the set of instances paired with each other; in v1 every pair is explicit (A–B, A–C), there is no group object (Q4) |
| Home instance | the instance that owns a shared project; it holds the board, the shared session and the trace root |
| Guest | a peer that has been given access to a shared project |

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
- **Tailscale stays optional.** The harness needs only an address; `detectTailscale` is used to show status and to fill
  in the MagicDNS name, never required. No Tailscale API key, no tsnet (Q6).
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

Agent work itself (consults, delegations, join turns) uses the standard A2A `message/send|stream`, `tasks/get|cancel`
with the D104 contract in a `data` part and the W3C `traceparent` in message metadata.

## 6. Peer principal and scopes

- `peer:<peer id>` with `kind: "peer"`; it is neither a person nor an agent. `authorize()` refuses every `humanOnly` action
  (the check is "not explicitly a person", so this already holds), every role-based grant (a peer has no role) and every
  action outside its scopes.
- **Scopes** (closed list, granted per peer and narrowed per share): `federation.card.read`, `project.read`,
  `project.contribute`, `agent.offer`, `agent.join`, `agent.serve` (the home may call the guest's offered agent).
- A request from a peer may carry an **acting-person assertion** (an opaque, peer-signed id of the remote person who
  triggered it). It is recorded in audit and trace for attribution only; it never authorises anything locally.
- Peers never reach the control profile, `memory.*`, `secret.*`, `config.*`, `admin.*`, `identity.*`, `device.*`, chats or
  agents outside a share.

## 7. Contributing agents

### 7.1 Variants

| | (a) Agent as a service (**default**) | (b) Join into the session | (b2) Transplant (not in v1) |
|---|---|---|---|
| What happens | the home orchestrator sends a D104 contract to the peer's agent; it runs at the peer and returns `plur1bus.return/1` | the peer's agent becomes a **participant** of the shared session and takes turns with the full shared context; it still runs at the peer | the agent's definition is copied to the home and runs on the home's models |
| Where the model runs | at the peer (its local model stays local) | at the peer | at the home |
| Data that leaves the home | the contract (≤ 2 k tokens) + context excerpts the contract names | the context package (§9), then every new session event | the peer's persona, instructions and skills leave the peer |
| Who pays | the peer, from its own budget | the peer, per turn | the home |
| Privacy | minimal; peer sees only the task | the peer sees the whole shared session (redacted) | the peer's private configuration leaves its machine |
| Fits | split tasks, reviews, independent sub-problems | pair work, long design sessions, "beide arbeiten im selben Verlauf" | — (the owner's example has a local model on each side, which a transplant cannot use) |
| Window negotiation (§10) | per contract: the package must fit the peer's window | **mandatory** for the whole session | — |

**Recommendation:** (a) as the default for every offered agent, because the local model stays with its owner and the
outflow is bounded per task. (b) is available per share when the home owner allows `agent.join`; the guest owner decides
per agent whether it may be joined. (b2) is recorded as an alternative only (Q2).

### 7.2 Agent as a service in the M5 model

- A peer's offered agent appears on the home as a **remote project member** `peer:<id>/agent:<agentId>` with display name,
  skills and window claim. It is a `DelegationTarget` of a new kind `peer` (today `local | external | a2a`); M5 keeps a
  single `delegate_task` and one ticket path, as `target.ts` requires.
- On the guest, the incoming task runs as a **project session** owned by `collab-peer:<home peer id>:<projectId>`, inside
  the agent's own `AgentScope`, with the guest's tools, D109 decisions, approvals and budget. The guest owner can require
  approval for every incoming task (`federation.serve.requireApproval`, default `true`).
- The guest's agent recalls nothing from its owner's memories into the shared work unless its owner turned that on for
  the share (`share.guestMemory: none | agent-private-read`, default `none`); nothing it learns is captured into its store
  from shared content without that switch. ADR-003 Q4 (stateless external agents) is the default.

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
  peer cannot be delegated to a third instance (**no transitivity**).
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
4. If the current view exceeds `compactAtRatio × W'`, the home compacts **before** sending the package (§10.3).
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
  confirmation. Both `x-restart: live`, `x-tier: advanced`.
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

### 11.2 Egress

All outbound peer calls go through `egress.request` with the per-peer address exception (§5.3). A peer cannot make the
home fetch anything else: URIs in peer content are stored, never fetched (as the A2A server already does for file
parts).

### 11.3 Secrets

The secret store is not addressable by any federation method. API keys, OAuth tokens, device tokens and the instance
private key never enter a package, a return, a trace or a log. The redactor runs on every outbound payload; a test feeds
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

### 11.5 Revocation and audit

- Revoking a peer (either side) ends live connections and joins, cancels running tasks (partials kept), stops
  subscriptions and marks the record `revoked`. Revoking a share does the same for that project only.
- Data already sent cannot be recalled. A well-behaved guest deletes cached shared content on revocation
  (`federation.share.revoked` received); the UI says plainly that the home cannot enforce this.
- Audit events (no keys, codes or content): `federation.enabled|disabled`, `federation.invite.created|redeemed|failed`,
  `federation.peer.paired|confirmed|suspended|revoked|key-rotated`, `federation.share.created|changed|revoked`,
  `federation.join.requested|accepted|refused|left`, `federation.task.received|refused|finished`,
  `federation.window.changed`, `federation.compaction.forced`.

## 12. Configuration (proposed keys)

| Key | Type | Default | `x-restart` | `x-tier` | Meaning |
|---|---|---|---|---|---|
| `federation.enabled` | boolean | `false` | `core` | `advanced` | mount the federation endpoints and allow pairing |
| `federation.displayName` | string | host name | `live` | `basic` | name shown to peers |
| `federation.serve.requireApproval` | boolean | `true` | `live` | `advanced` | each incoming peer task waits for owner approval |
| `federation.parallelEnabled` | boolean | `false` | `live` | `advanced` | parallel mode across instances (also needs `collaboration.fanoutEnabled`) |
| `federation.context.compactAtRatio` | number | `0.8` | `live` | `advanced` | compact shared sessions at this share of the effective window |
| `federation.context.minWindowTokens` | integer | `16384` | `live` | `advanced` | refuse joins below this usable window |
| `federation.context.warnWindowTokens` | integer | `32768` | `live` | `advanced` | confirmation below this usable window |
| `federation.context.joinSummaryWaitMs` | integer | `20000` | `live` | `advanced` | how long a join waits for an LLM summary before using the digest |
| `federation.limits.*` | object | A2A defaults | `live` | `advanced` | per-peer request, task and stream limits |

Peers, shares and offers are **state** (`state/peers.json`, the collab store), not configuration. All keys are written by
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
- **Transplant join (b2)** — rejected for v1 (§7.1).

## 15. Owner questions

1. **Q1 — Placement and number.** Confirm the target "Beta 2" (the second beta release after v0.1.0) and a new D number
   for this feature; `docs/milestones.md` has no release train after v0.1.0 yet, so Track F is recorded outside the
   v0.1.0 total.
2. **Q2 — Default contribution mode.** Agent as a service (a) as the default with join (b) opt-in per share and per agent,
   as recommended — or join as the default? Should transplant (b2) ever be offered?
3. **Q3 — What a share may contain.** Memories: never, or explicitly per item (copied, tainted, revocable on a
   well-behaved guest)? Worktree files: not in v1, or a read-only git bundle as an explicit share item?
4. **Q4 — More than two instances in v1.** Pairwise federation with any number of peers per project (recommended), or
   strictly two instances in the first version? A named group object ("cluster") later?
5. **Q5 — Full control over MCP/ACP.** Accept that "all functions" means the schema-derived control profile **minus**
   WebMCP's forbidden set (`admin.*`, `humanOnly`, configuration writes, lifecycle), or should Owners be able to open
   further families to their own personal tokens?
6. **Q6 — Tailscale depth.** v1 with "enter a tailnet address" plus status detection only (recommended), or a deeper
   integration (tsnet node per instance, Tailscale identity as an extra peer factor)?
7. **Q7 — Window policy defaults.** `compactAtRatio` 0.8, minimum usable window 16 k and warning at 32 k tokens — keep, or
   other values? Should the home ever compact a running session without asking when a join forces it?
8. **Q8 — Costs and approvals for served tasks.** Keep "approval for every incoming peer task" as the default, or allow
   auto-accept for paired peers within a daily token cap?
