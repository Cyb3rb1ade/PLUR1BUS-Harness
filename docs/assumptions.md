# Assumptions and open questions

Kept current throughout the project. Each entry: what we assume, why, and what would change it. Owner decisions are recorded in `docs/phase0/brief.md` and the ADRs.

## Assumptions (Phase 0)

| ID | Assumption | Basis | Would change if |
|----|------------|-------|-----------------|
| A1 | PLUR1BUS can be split into a host-neutral engine and an OpenClaw adapter without behaviour change, verified by the existing test suite. | Owner decision D2; PLUR1BUS already ships `docs/compatibility-openclaw.md` and a host-compat audit, i.e. the host surface is enumerable. | `docs/host-contract.md` finds engine logic that depends on OpenClaw runtime objects in ways that cannot be abstracted. |
| A2 | Node ≥ 24 is the floor for engine, harness and CLI (PLUR1BUS 7.15.x already requires `>=24.16 <25 || >=26.1`). | `package.json` of `@cyb3rb1ade/plur1bus-memory` 7.15.4. | Owner wants a lower floor; a required native module lacks Node-24 prebuilds on a target. |
| A3 | Local embedding and reranking via Transformers.js/ONNX runs on all five targets (macOS arm64, Windows x64/arm64, Linux x64/arm64). | To be verified in `docs/platform-matrix.md`. | No `onnxruntime-node` prebuild for Windows arm64 → degrade to remote embedding on that target and record as K3-style finding. |
| A4 | Coding CLIs are attached primarily through ACP (Agent Client Protocol); a PTY/JSON fallback covers the rest. | Owner decision D5. | ACP adoption among the named CLIs turns out too thin — then the PTY adapter becomes the primary path. |
| A5 | Two repositories: PLUR1BUS (engine + OpenClaw adapter) and PLUR1BUS-Harness (host, CLI, API, UI). | Owner decision D3 default. | ADR-002 shows the engine API churn during M1 makes a monorepo cheaper. |
| A6 | Documentation in English, owner conversation in German. | Owner decision D10. | — |

## Open questions

Defaults apply until answered; each is asked before the phase that depends on it.

| ID | Question | Default | Ask before |
|----|----------|---------|------------|
| Q1 | macOS x64: required or best-effort? | Best-effort. | M8 |
| Q2 | Subscription logins with policy `restricted`: opt-in with risk notice, or omit? | Opt-in with notice (owner leaned this way earlier). | M2 |
| Q3 | Should one bot connection be able to route to several agents? | Support both; routing is lower priority. | M4 |
| Q4 | Role model: full (Owner/Admin/Operator/Member/Viewer) or slim (Owner/Admin/Member)? | Full, object-level rights on agents and projects. | M3 |
| Q5 | Monorepo vs two repos for engine and harness. | Two repos (A5). | End of Phase 0 (ADR-002) |
| Q6 | Which coding CLIs must work at M6 acceptance (minimum set)? | claude-code, codex, opencode, kimi; others best-effort. | M6 |
