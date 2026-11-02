/** CLI-1: coding changes only the static operating section and offered tools, never live D109 authority. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { sessionRoleFactory } from "../../src/session/maintenance.ts";
import { createCacheTelemetry } from "../../src/prompt/telemetry.ts";
import { CODING_INSTRUCTIONS, CODING_TOOL_NAMES, composeCodingTools } from "../../src/coding/profile.ts";
import type { TurnProviderOptions } from "../../src/composition/provider.ts";
import type { ChatRequest } from "../../src/session/provider.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";

test("the coding operating section is static; normal, summarize and voice-profile requests keep their contracts", async () => {
  const built: TurnProviderOptions[] = [],
    requests: ChatRequest[] = [];
  const factory = sessionRoleFactory(
    (options) => {
      built.push(options);
      return {
        id: "captured",
        telemetry: createCacheTelemetry(),
        async *stream(req) {
          requests.push(req);
          yield { type: "delta", text: "ok" };
        },
      };
    },
    defaults(),
    {
      coding: {
        enabled: (req) => req.sessionId.startsWith("code") && !req.role,
        prepare: async (req) => (req.sessionId.startsWith("code") ? { ...req, projectId: "verified-project" } : req),
      },
    },
  );
  const provider = factory({
    profiles: {},
    registry: {} as never,
    grants: {} as never,
    approval: {} as never,
    budget: {} as never,
    log() {},
    resultStore: {
      async put() {
        throw new Error("tools-disabled");
      },
    },
    system: ["PERSONA", "SOUL"],
    profile: "chosen",
  });
  const turnProfile = { marker: "same-voice-budget" } as never;
  const request = (sessionId: string): ChatRequest => ({
    sessionId,
    agentId: "a",
    principal: "p",
    summaries: [],
    memory: "frozen snapshot",
    messages: [{ role: "user", text: "task" }],
    signal: new AbortController().signal,
    turnProfile,
  });
  for await (const _ of provider.stream(request("chat"))) {
    /* drain */
  }
  for await (const _ of provider.stream(request("code-one"))) {
    /* drain */
  }
  for await (const _ of provider.stream(request("code-two"))) {
    /* drain */
  }
  for await (const _ of provider.stream({ ...request("code-one"), role: "decision" })) {
    /* drain */
  }
  assert.deepEqual(built[0]!.system, ["PERSONA", "SOUL"]);
  assert.deepEqual(built[1]!.system, ["PERSONA", "SOUL", CODING_INSTRUCTIONS]);
  assert.equal(built.length, 2, "no per-session root or identifier creates another static profile");
  assert.equal(requests[1]!.memory, "frozen snapshot");
  assert.equal(requests[1]!.turnProfile, turnProfile);
  assert.equal(requests[1]!.projectId, "verified-project");
  assert.equal(requests[3]!.role, "decision");
  assert.equal(requests[3]!.projectId, "verified-project", "background roles retain the card's project budget scope");
  assert.equal(provider.defaultModelProfile?.("a"), "chosen");
  assert.ok(CODING_TOOL_NAMES.includes("file.edit") && CODING_TOOL_NAMES.includes("file.write"));
  assert.ok(CODING_TOOL_NAMES.includes("code.check") && !CODING_TOOL_NAMES.includes("code.session.check"));
});

test("a virtual coding cwd resolves relative paths but stays outside configured roots for D109", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "coding-root-policy-"));
  const home = join(dir, "home"),
    configured = join(dir, "workspace"),
    root = join(dir, "repo");
  for (const path of [home, configured, root]) mkdirSync(path);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = await composeCodingTools(
    {
      home,
      roots: [{ id: "workspace", path: configured }],
      grants: { list: () => [], get: () => undefined },
      audit: memoryAuditSink(),
    },
    { sessionId: "s", agentId: "a", summaries: [], memory: "", messages: [], signal: new AbortController().signal },
    root,
  );
  const classification = await registry.get("file.write")!.classify!({ path: "new.ts", content: "code" });
  assert.equal(classification.flags?.outsideRoots, true, "binding must not become permission");
  assert.equal(classification.flags?.denyListHit, false);
  assert.equal(classification.targets?.[0], join(realpathSync.native(root), "new.ts"));
  const same = await composeCodingTools(
    {
      home,
      roots: [{ id: "worktree", path: root }],
      grants: { list: () => [], get: () => undefined },
      audit: memoryAuditSink(),
    },
    { sessionId: "s", agentId: "a", summaries: [], memory: "", messages: [], signal: new AbortController().signal },
    root,
  );
  assert.equal(
    (await same.get("file.write")!.classify!({ path: "new.ts", content: "code" })).flags?.outsideRoots,
    false,
  );
});
