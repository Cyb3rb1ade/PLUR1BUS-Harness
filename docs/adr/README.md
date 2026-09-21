# Architecture Decision Records

One file per decision: `ADR-NNN-<slug>.md`. Status flow: Proposed → Accepted (by the owner, Christian) → Superseded/Deprecated. Phase 0 ADRs are all **Proposed** until the Phase 0 review.

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

| ADR | Title | Status |
|-----|-------|--------|
| 001 | Base architecture: TypeScript monorepo (Variant B) vs Hermes distribution (Variant A) | Proposed |
| 002 | PLUR1BUS engine extraction and the harness as native host | Proposed |
| 003 | Agent model, collaboration, group vs 1:1 behaviour | Proposed |
| 004 | Harness API and web UI | Proposed |
| 005 | Authentication policy and secret storage | Proposed |
| 006 | Embedding and reranking service | Proposed |
| 007 | Users, roles, identity linking | Proposed |
| 008 | Protocols: MCP, ACP, A2A | Proposed |
| 009 | Dreaming scheduler | Proposed |
| 010 | Latency and caching | Proposed |
| 011 | External coding agents | Proposed |
