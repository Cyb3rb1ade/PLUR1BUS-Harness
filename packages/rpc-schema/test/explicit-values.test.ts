// The TypeScript side of #405's codegen gaps (the Rust side: crates/plur1bus-rpc/tests/generative.rs). The generated types are
// plain JSON shapes, so an optional field keeps three states without help: missing (`undefined`, not written by JSON.stringify),
// `null` and `[]`. A pinned value (`const`) is a literal type, and a property named `format` is a field. `pnpm typecheck` checks
// the type assertions below; the runtime part checks that the schema accepts what the types allow.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateParams, validateResult } from "../src/index.ts";
import type { AgentCloseResult, CoreShutdownResult, MediaGenerateParams, ProjectCardUpdateParams, ProjectColumnUpdateParams } from "../src/index.ts";

describe("generated TS types keep explicit values", () => {
  it("keeps missing, null and [] apart in update params", () => {
    const clear: ProjectCardUpdateParams = { projectId: "p", cardId: "c", dueAt: null, labels: [], links: [] };
    const leave: ProjectCardUpdateParams = { projectId: "p", cardId: "c" };
    const column: ProjectColumnUpdateParams = { projectId: "p", columnId: "c", wipLimit: null };
    for (const p of [clear, leave]) assert.deepEqual(validateParams("project.card.update", p), { ok: true });
    assert.deepEqual(validateParams("project.column.update", column), { ok: true });
    assert.deepEqual(JSON.parse(JSON.stringify(clear)), { projectId: "p", cardId: "c", dueAt: null, labels: [], links: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(leave)), { projectId: "p", cardId: "c" });
  });

  it("types a pinned value as its literal and keeps a property named format", () => {
    const accepted: CoreShutdownResult = { accepted: true };
    // @ts-expect-error a const true refuses false
    const refused: CoreShutdownResult = { accepted: false };
    const closed: AgentCloseResult = { agentId: "a1", open: false };
    const media: MediaGenerateParams = { agentId: "a1", request: { prompt: "x", format: "webp" } };
    assert.deepEqual(validateResult("core.shutdown", accepted), { ok: true });
    assert.notDeepEqual(validateResult("core.shutdown", refused), { ok: true });
    assert.deepEqual(validateResult("agent.close", closed), { ok: true });
    assert.deepEqual(validateParams("media.generate", media), { ok: true });
  });
});
