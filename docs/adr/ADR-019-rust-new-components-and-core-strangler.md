# ADR-019: Rust for new components, and the core's strangler path to Rust

**Status:** Accepted. History:
- 2026-10-30: owner decision, option B (D120).
- 2026-10-31: form decided (D120 Q2).
- 2026-11-07: amended by D129 (no TypeScript fixes; 0.1 ships on Rust) and D131 (the Phase 4 plan's decisions).

**Amends:** ADR-012 §2 (D7). **Supersedes:** RE-D9.

**Plan:** [`2026-11-07-phase4-ts-core-to-rust.md`](../superpowers/plans/2026-11-07-phase4-ts-core-to-rust.md).

## Context

ADR-012 chose TypeScript for the core for three reasons: the engine was Node, and the MCP, ACP and A2A SDKs were TypeScript. None of these reasons holds any longer:
- RE-11 retires the Node engine.
- ACP is hand-written on both sides.
- The channel adapters have no runtime dependencies.
- An official Rust MCP SDK exists.

The owner's original direction was Rust throughout.

On 2026-11-07 (D129) the owner tightened the path:
- The Node engine is frozen.
- Bugs and security issues found in TypeScript code are not fixed in TypeScript. The component is ported to Rust and fixed there.
- The first alpha, 0.1, ships on Rust.

## Decision

1. **New components are Rust.** Every new harness component is written in Rust from its first version. JSON Schema stays the single source of every cross-language type (ADR-012 §2 unchanged).
   - Until the core itself is Rust, the TypeScript core calls such components over the harness RPC as supervised processes (the RE-D1 pattern).
   - Components without secrets start in `plur1bus-tools`, unless isolation justifies a separate process.
2. **The core moves to Rust before 0.1 ("Phase 4"),** subsystem by subsystem, in the order of the Phase 4 plan. The strangler mechanism (D131 Q2–Q4):
   - **Core process:** a separate, privileged `plur1bus-core` process.
   - **Front door:** it takes over the core socket and relays every call it does not yet own to the TypeScript core behind it.
   - **Bridge:** a temporary `x-server: "bridge"` value for the legacy core's calls back into Rust, removed at the cut.
   - Each step is backed by parity gates (contract fixtures, transcripts, system runs).
   - There is no big-bang rewrite and no long dual implementation.
   - Phase 4 runs alongside the Rust engine programme. 0.1 waits for both the Phase 4 cut and RE-11.
3. **No TypeScript fixes (D129).**
   - A defect found in TypeScript core code pulls the component's Phase 4 package forward.
   - Until that package lands, the defect is contained only by configuration, fail-closed behaviour or deletion, never by a TypeScript patch (D131 Q9).
   - TypeScript work that is planned for the core but not yet merged is written in Rust inside the owning Phase 4 package (D131 Q6). This includes the D124 team shell PT-4b, which becomes part of P4-50.
4. **What stays TypeScript:**
   - The web SPA (`packages/web`) and the desktop WebView UI (`apps/desktop/ui`).
   - For 0.1 only, behind the process boundaries they already have (D131 Q1, variant B): the Harness API (`packages/api`) and the offline import. Both move after 0.1.
   - `packages/module-api` stays a published TypeScript SDK for third-party modules (D131 Q7).
   - Local voice and local caption models leave Node only after 0.1, on ONNX Runtime (D131 Q5). 0.1 uses cloud and remote providers for both.
5. **Rust work is done by Claude agents** (D131 Q12). Owner exceptions are recorded per package: Codex for MM, U, TK and the Rust engine package RX; grok for RE-04 and RE-07.

## Consequences

- **Processes:** one more supervised process during the transition (`plur1bus-core` in front of the legacy core).
- **Dependencies:** the dependency policy applies to every new crate.
- **Node at runtime:** for 0.1, Node stays in the payload only for `api.js`, `import.js` and `extension-source.js`. It leaves entirely when the Harness API and import are ported.
- **Pace:** the TypeScript core is frozen for fixes. Features wanted before 0.1 wait for, or are pulled into, their Phase 4 package.
- **RE-12** (forward-porting fixes to the Node engine) is superseded (D131 Q10).
