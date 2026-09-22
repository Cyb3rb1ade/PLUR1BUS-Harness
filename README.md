# PLUR1BUS Harness

PLUR1BUS Harness is a self-hosted, multi-user multi-agent harness built **around PLUR1BUS as its fixed memory core**, with a feature scope in the order of Hermes Agent and a web UI in PLUR1BUS optics. PLUR1BUS is not a swappable memory provider: the harness grows out of it. PLUR1BUS gains a host-neutral engine with its own API, the harness is that engine's primary native host, and the existing OpenClaw plugin becomes a secondary adapter. Identities come from the core (agent = PLUR1BUS `agentId`, project = PLUR1BUS workspace, human = one canonical principal), embedding and reranking are mandatory core capabilities, and dreaming — light / REM / deep sleep, on the harness's own scheduler, never a host cron — must demonstrably work and be visible in the UI. No cloud component, no telemetry, no re-implementation of PLUR1BUS logic in another language.

**Status: Phase 0 — analysis complete, awaiting owner approval. No product code yet.**

Phase 0 produced analysis and decision records only. Nothing here is implemented; the eleven ADRs are all *Proposed* and become *Accepted* only on the owner's sign-off.

## Document map

| Document | What it is |
|---|---|
| [`docs/phase0/brief.md`](docs/phase0/brief.md) | The binding Phase-0 brief: decisions D1–D11, the deliverable list, the working rules |
| [`docs/phase0/auftrag-original-2026-09-21.md`](docs/phase0/auftrag-original-2026-09-21.md) | The original commission (German), superseded in part by the brief |
| [`docs/assumptions.md`](docs/assumptions.md) | Assumptions A1–A8 and the canonical open questions **Q1–Q11** |
| [`docs/adr/README.md`](docs/adr/README.md) | ADR index, template and rules — ADR-001 … ADR-011 |
| [`docs/host-contract.md`](docs/host-contract.md) | Every OpenClaw host surface PLUR1BUS uses today, with `file:line`, semantics and time budget, mapped onto the future engine API |
| [`docs/engine-extraction.md`](docs/engine-extraction.md) | What is engine, adapter and UI; package boundaries; the PR-01…PR-15 plan for the PLUR1BUS repo; the behaviour-neutrality gate |
| [`docs/learnings-hermes-openclaw.md`](docs/learnings-hermes-openclaw.md) | What Hermes and OpenClaw do well, what we take as design ideas, what we deliberately do differently |
| [`docs/provider-matrix.md`](docs/provider-matrix.md) | Chat / embedding / rerank per provider: wire format, auth, caching, policy status, source and check date |
| [`docs/platform-matrix.md`](docs/platform-matrix.md) | Native binaries per target, CI runner labels, Node-24 startup techniques |
| [`docs/import.md`](docs/import.md) | OpenClaw and Hermes source formats and their mapping onto the harness |
| [`docs/milestones.md`](docs/milestones.md) | M0–M8 re-cut for Variant B: scope, acceptance, effort, risks, test plan |
| [`docs/phase0/research/`](docs/phase0/research/) | Research notes — **inputs**, not deliverables; the verification log of hands-on checks lives here |
| [`docs/phase0/review-report.md`](docs/phase0/review-report.md) | Independent Phase-0 review: citation spot-check, consistency findings, residual risks, verdict |
| [`docs/phase0/decisions-for-owner.md`](docs/phase0/decisions-for-owner.md) | The consolidated list of decisions the owner must take to release Phase 0 and start M1 |

## Relationship to the PLUR1BUS repository

PLUR1BUS ([`Cyb3rb1ade/openclaw-plur1bus-memory`](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory), npm `@cyb3rb1ade/plur1bus-memory`) is the memory core, not a dependency this project may fork. Every engine change — host-neutral extraction, the principal model, multi-identity recall, the Windows port, the socket-to-named-pipe move — lands as a pull request **in the PLUR1BUS repository**, so the OpenClaw plugin receives it too. The harness holds no divergent copy of the memory logic and consumes the engine as a pinned dependency. Two repositories are the default; the trigger for revisiting that is recorded in ADR-002.

## Language

Documentation and code comments are in English; conversation with the owner is in German (brief D10).

## Licence

MIT — see [`LICENSE`](LICENSE). Adapted OpenClaw design tokens carry OpenClaw's own MIT attribution header verbatim (ADR-004).
