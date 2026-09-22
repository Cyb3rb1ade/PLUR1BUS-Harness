# Architecture Decision Records

One file per decision: `ADR-NNN-<slug>.md`. Status flow: Proposed → Accepted (by the owner, Christian) → Superseded/Deprecated. All eleven Phase 0 ADRs were **Accepted** by the owner on 2026-09-22 (`docs/phase0/decisions-for-owner.md`, "Owner answers 2026-09-22"); ADR-003, ADR-005 and ADR-009 carry owner amendments D14, D12–D13 and D15 respectively.

Rules (from `docs/phase0/brief.md`):
- Every factual claim about a provider, protocol, SDK, binary or PLUR1BUS internal carries a source: URL with check date, or `file:line @ commit`. Research notes live in `docs/phase0/research/`; cite them by section, and cite the primary source they cite.
- If evidence contradicts the brief, the ADR says so in a **"Conflicts with the brief"** section with options — it never deviates silently.
- Options are named and compared; the recommendation is explicit; consequences include what becomes harder.
- No code beyond identifiers and interface sketches.

## Template

```markdown
# ADR-NNN: Title

**Status:** Proposed · **Date:** YYYY-MM-DD · **Deciders:** Christian (owner) · **Inputs:** docs/phase0/research/<file>.md §…

## Context
What is the situation, which forces and constraints from the brief apply, what the research found (with sources).

## Decision
The recommendation, stated in one paragraph, then the details.

## Options considered
### Option A: Name
| Dimension | Assessment |
|---|---|
| Complexity | Low/Med/High |
| Fit with brief D1–D11 | … |
| Cross-platform risk | … |
| Maintenance burden | … |
| Latency / token cost | … |
**Pros:** … **Cons:** …
### Option B: …

## Trade-off analysis
## Consequences
- Easier: …
- Harder: …
- Revisit when: …

## Conflicts with the brief
(only if any) Finding · Source · Options · Recommended resolution

## Open questions for the owner
## Action items
1. [ ] …
```

## Index

| ADR | Title | File | Status |
|-----|-------|------|--------|
| 001 | Base architecture: TypeScript monorepo (Variant B) vs Hermes distribution (Variant A) | `ADR-001-base-architecture.md` | Accepted (2026-09-22) |
| 002 | PLUR1BUS engine extraction and the harness as native host | `ADR-002-plur1bus-engine-and-host.md` | Accepted (2026-09-22) |
| 003 | Agent model, collaboration, group vs 1:1 behaviour | `ADR-003-agent-model-and-collaboration.md` | Accepted (2026-09-22, amendment D14) |
| 004 | Harness API and web UI | `ADR-004-harness-api-and-web-ui.md` | Accepted (2026-09-22) |
| 005 | Authentication policy and secret storage | `ADR-005-auth-policy-and-secrets.md` | Accepted (2026-09-22, amendments D12–D13) |
| 006 | Embedding and reranking service | `ADR-006-embedding-and-reranking.md` | Accepted (2026-09-22) |
| 007 | Users, roles, identity linking | `ADR-007-users-roles-identity.md` | Accepted (2026-09-22) |
| 008 | Protocols — MCP, ACP, A2A | `ADR-008-protocols-mcp-acp-a2a.md` | Accepted (2026-09-22) |
| 009 | Dreaming scheduler | `ADR-009-dreaming-scheduler.md` | Accepted (2026-09-22, amendment D15) |
| 010 | Latency and caching | `ADR-010-latency-and-caching.md` | Accepted (2026-09-22) |
| 011 | External coding agents | `ADR-011-external-coding-agents.md` | Accepted (2026-09-22) |

## Open-question numbering

Canonical numbering for owner questions is **`docs/assumptions.md` Q1–Q11** (Q1–Q5 follow the original commission §13; Q6+ were added on 2026-09-22). An ADR that also numbers its *own* open questions (ADR-001, ADR-002, ADR-009, ADR-010 …) numbers them locally and says so; a reference to a canonical question always cites `docs/assumptions.md`. The Phase-0 review consolidates both sets in `docs/phase0/decisions-for-owner.md`.
