import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardMethods } from "../../src/rbac/guard.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { Handler, CallContext } from "../../src/rpc/server.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { buildIdentitySurface } from "../../src/rpc/identity-surface.ts";
import { createCollab } from "../../src/collab/service.ts";
import { buildCollabSurface } from "../../src/rpc/collab-surface.ts";
import { createMediaSurface } from "../../src/rpc/media-surface.ts";
import { OutputStore, type ImageAdapter } from "../../../media/src/index.ts";
import { createCallBudget, PriceBook } from "../../src/budget/index.ts";
const owner: Principal = {
  userId: "local-owner",
  role: "owner",
  kind: "person",
};
const ctx: CallContext = {
  requestId: "r",
  connectionId: "c",
  signal: new AbortController().signal,
};
const wrap = (
  methods: Record<string, Handler>,
  principal: Principal | null = owner,
) => guardMethods(methods, { resolve: () => principal, now: () => 0 });
const call = (
  methods: Record<string, Handler>,
  method: string,
  params: object = {},
) => methods[method]!(params, ctx);

test("identity surfaces: code once, self-only, approve/decline/remove, canonical union, agents denied", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "identity-surface-"));
  const s = createIdentityService({
    dbPath: join(scratch, "identity.sqlite"),
    clock: () => 100,
    audit: () => {},
  });
  const actor = {
    user: owner.userId,
    host: "test",
    kind: "person" as const,
    role: "owner" as const,
  };
  try {
    const human = s.createHuman({ displayName: "Synthetic" }, actor),
      other = s.createHuman({ displayName: "Other" }, actor);
    const p = { ...owner, userId: human.id };
    const methods = wrap(
      buildIdentitySurface(() => s),
      p,
    );
    const issued = (await call(methods, "identity.link.request", {
      channel: "telegram",
    })) as { id: string; code: string };
    assert.equal(issued.code.length, 8);
    const listed = (await call(methods, "identity.link.list")) as {
      pairings: unknown[];
    };
    assert.equal(JSON.stringify(listed).includes(issued.code), false);
    s.claim({
      code: issued.code,
      identity: { channel: "telegram", accountId: "bot", userId: "42" },
    });
    await call(methods, "identity.link.approve", { pairingId: issued.id });
    const linked = (await call(methods, "identity.link.list")) as {
      links: { id: string }[];
    };
    assert.equal(linked.links.length, 1);
    const union = (await call(methods, "identity.principals")) as {
      principals: string[];
    };
    assert.equal(union.principals[0], deriveUserPrincipal(human.id));
    assert.equal(union.principals.length, 2);
    await assert.rejects(() =>
      call(methods, "identity.link.approve", { pairingId: issued.id }),
    );
    await call(methods, "identity.link.remove", {
      linkId: linked.links[0]!.id,
    });
    assert.equal(
      ((await call(methods, "identity.principals")) as { principals: string[] })
        .principals.length,
      1,
    );
    const next = (await call(methods, "identity.link.request", {
      channel: "telegram",
    })) as { id: string; code: string };
    s.claim({
      code: next.code,
      identity: { channel: "telegram", accountId: "bot", userId: "43" },
    });
    await call(methods, "identity.link.decline", { pairingId: next.id });
    const member = wrap(
      buildIdentitySurface(() => s),
      { ...p, role: "member" },
    );
    await assert.rejects(
      () => call(member, "identity.link.list", { humanId: other.id }),
      { error: "E_DENIED" },
    );
    for (const method of Object.keys(methods)) {
      await assert.rejects(
        () =>
          call(
            wrap(
              buildIdentitySurface(() => s),
              { ...p, kind: "agent" },
            ),
            method,
            { channel: "telegram" },
          ),
        { error: "E_DENIED" },
      );
      await assert.rejects(
        () =>
          call(wrap(buildIdentitySurface(() => null)), method, {
            channel: "telegram",
          }),
        { error: "E_NOT_AVAILABLE" },
      );
    }
  } finally {
    s.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("project surfaces: CRUD, persisted lead/member rights, agent rights, redacted traces and cancellation", async () => {
  const s = createCollab({ path: ":memory:" });
  try {
    const methods = wrap(buildCollabSurface(() => s));
    const project = (await call(methods, "project.create", {
      name: "Synthetic",
    })) as { id: string };
    const projectId = project.id;
    assert.equal(
      ((await call(methods, "project.get", { projectId })) as { name: string })
        .name,
      "Synthetic",
    );
    assert.equal(
      ((await call(methods, "project.list")) as { projects: unknown[] })
        .projects.length,
      1,
    );
    await call(methods, "project.update", { projectId, name: "Renamed" });
    await call(methods, "project.member.add", {
      projectId,
      userId: "member",
      role: "member",
    });
    const member = wrap(
      buildCollabSurface(() => s),
      {
        userId: "member",
        kind: "person",
        role: "member",
        agentRights: { a: "use", b: "use" },
      },
    );
    await call(member, "project.agent.add", { projectId, agentId: "a" });
    await call(member, "project.agent.add", { projectId, agentId: "b" });
    await assert.rejects(() => call(member, "project.archive", { projectId }), {
      error: "E_DENIED",
    });
    const answer = await s.consult({
      principal: owner,
      projectId,
      fromAgent: "a",
      toAgent: "b",
      question: "Synthetic question",
      context: "",
    });
    assert.equal(
      (
        (await call(member, "collab.trace.get", {
          traceId: answer.traceId,
        })) as { traceId: string }
      ).traceId,
      answer.traceId,
    );
    assert.equal(
      (
        (await call(methods, "collab.trace.list", { projectId })) as {
          traces: unknown[];
        }
      ).traces.length,
      1,
    );
    await call(member, "collab.chain.cancel", { traceId: answer.traceId });
    await call(methods, "project.member.role", {
      projectId,
      userId: "member",
      role: "lead",
    });
    await call(member, "project.update", { projectId, name: "By lead" });
    await call(member, "project.agent.remove", { projectId, agentId: "a" });
    await call(methods, "project.member.remove", {
      projectId,
      userId: "member",
    });
    await assert.rejects(() => call(member, "project.get", { projectId }), {
      error: "E_DENIED",
    });
    await call(methods, "project.archive", { projectId });
    await assert.rejects(() =>
      call(methods, "project.update", { projectId, name: "No" }),
    );
    for (const method of Object.keys(methods))
      await assert.rejects(
        () => call(wrap(buildCollabSurface(() => null)), method),
        { error: "E_NOT_AVAILABLE" },
      );
  } finally {
    s.close();
  }
});

test("media surfaces: fake adapter -> durable store -> gallery result, budget/policy gates, metadata and CRUD", async () => {
  const home = await mkdtemp(join(tmpdir(), "media-surface-"));
  const budget = createCallBudget({
    path: join(home, "budget.sqlite"),
    clock: { now: () => 1000 },
    prices: new PriceBook([{ version: "fake", effectiveFrom: 0, models: {} }]),
  });
  const ac = new AbortController();
  let invoked = 0;
  const adapter: ImageAdapter = {
    id: "fake",
    capabilities: () => ({ generate: true, edit: true, inpaint: true }),
    async generate() {
      invoked++;
      return {
        files: [{ bytes: Buffer.from("synthetic-image"), format: "png" }],
        metadata: { adapter: "fake", model: "fake", durationMs: 1, costUsd: 0 },
      };
    },
    async edit(r, c) {
      return this.generate(r, c);
    },
  };
  const events: { method: string; audience: readonly string[] | undefined }[] =
    [];
  const surface = createMediaSurface({
    home,
    adapters: [adapter],
    store: new OutputStore(join(home, "outputs")),
    budget,
    signal: ac.signal,
    policy: async () => {},
    notify: (method, _params, o) =>
      events.push({ method, audience: o.audience }),
  });
  try {
    const methods = wrap(surface.methods);
    await call(methods, "media.preferences.set", { embedMetadata: false });
    assert.equal(
      ((await call(methods, "media.preferences.get")) as { global: boolean })
        .global,
      false,
    );
    const queued = (await call(methods, "media.generate", {
      agentId: "main",
      request: { prompt: "Forest" },
    })) as { jobId: string };
    await surface.close();
    assert.equal(invoked, 1);
    const job = (await call(methods, "media.job.get", {
      id: queued.jobId,
    })) as { state: string };
    assert.equal(job.state, "succeeded");
    assert.equal(JSON.stringify(job).includes("referenceImages"), false);
    assert.equal(
      ((await call(methods, "media.job.list")) as { jobs: unknown[] }).jobs
        .length,
      1,
    );
    const outputs = (await call(methods, "media.output.list")) as {
      outputs: { id: string }[];
    };
    assert.equal(outputs.outputs[0]!.id, queued.jobId);
    const output = (await call(methods, "media.output.get", {
      id: queued.jobId,
      file: 0,
    })) as { data: string; canShare: boolean };
    assert.equal(
      Buffer.from(output.data, "base64").toString(),
      "synthetic-image",
    );
    assert.equal(output.canShare, false);
    assert.ok(events.some((e) => e.method === "media.job.finished"));
    assert.ok(events.every((e) => e.audience?.[0] === "c"));
    const edited = (await call(methods, "media.edit", {
      agentId: "main",
      request: { prompt: "Edit", referenceIds: [queued.jobId] },
    })) as { jobId: string };
    await surface.close();
    await call(methods, "media.job.cancel", { id: edited.jobId });
    await call(methods, "media.output.delete", { id: queued.jobId });
    await assert.rejects(
      () => call(methods, "media.output.get", { id: queued.jobId }),
      { error: "E_NOT_FOUND" },
    );
    assert.equal(
      ((await call(methods, "media.adapters.list")) as { adapters: unknown[] })
        .adapters.length,
      1,
    );
    await assert.rejects(
      () =>
        call(methods, "media.edit", {
          agentId: "main",
          request: { prompt: "No reference" },
        }),
      { error: "E_INVALID_PARAMS" },
    );
    await assert.rejects(
      () =>
        call(
          wrap(surface.methods, {
            userId: "m",
            role: "member",
            kind: "person",
          }),
          "media.generate",
          { agentId: "main", request: { prompt: "Denied" } },
        ),
      { error: "E_DENIED" },
    );
    for (const method of [
      "media.job.get",
      "media.job.cancel",
      "media.output.get",
      "media.output.delete",
    ])
      await assert.rejects(
        () =>
          call(methods, method, { id: "00000000-0000-4000-8000-000000000000" }),
        { error: "E_NOT_FOUND" },
      );
    const denied = createMediaSurface({
      home,
      adapters: [adapter],
      store: new OutputStore(join(home, "outputs")),
      budget,
      signal: ac.signal,
      policy: async () => {
        throw new (await import("../../src/rpc/errors.ts")).RpcError(
          "E_DENIED",
          "policy",
        );
      },
      notify: () => {},
    });
    const before = invoked;
    await assert.rejects(
      () =>
        call(wrap(denied.methods), "media.generate", {
          agentId: "main",
          request: { prompt: "Denied" },
        }),
      { error: "E_DENIED" },
    );
    assert.equal(invoked, before);
    budget.setLimit({
      scope: "global",
      id: "",
      period: "day",
      metric: "cost",
      hard: 0,
    });
    await assert.rejects(
      () =>
        call(methods, "media.generate", {
          agentId: "main",
          request: { prompt: "Unpriced" },
        }),
      { error: "E_DENIED" },
    );
    assert.equal(invoked, before);
  } finally {
    ac.abort();
    await surface.close();
    budget.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("media cancellation is accepted immediately, before the runner installs its own controller", async () => {
  const home = await mkdtemp(join(tmpdir(), "media-cancel-"));
  const budget = createCallBudget({
    path: join(home, "budget.sqlite"),
    clock: { now: Date.now },
    prices: new PriceBook([
      { version: "fixture", effectiveFrom: 0, models: {} },
    ]),
  });
  const adapter: ImageAdapter = {
    id: "fake",
    capabilities: () => ({ generate: true, edit: false, inpaint: false }),
    async generate(_request, context) {
      await new Promise<void>((_resolve, reject) => {
        if (context?.signal?.aborted) reject(new Error("aborted"));
        else
          context?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
      });
      throw new Error("unreachable");
    },
    async edit() {
      throw new Error("unsupported");
    },
  };
  const ac = new AbortController(),
    surface = createMediaSurface({
      home,
      adapters: [adapter],
      store: new OutputStore(join(home, "outputs")),
      budget,
      signal: ac.signal,
      policy: async () => {},
      notify: () => {},
    });
  try {
    const methods = wrap(surface.methods),
      job = (await call(methods, "media.generate", {
        agentId: "main",
        request: { prompt: "Cancel" },
      })) as { jobId: string };
    await call(methods, "media.job.cancel", { id: job.jobId });
    await surface.close();
    assert.equal(
      (
        (await call(methods, "media.job.get", { id: job.jobId })) as {
          state: string;
        }
      ).state,
      "cancelled",
    );
  } finally {
    ac.abort();
    await surface.close();
    budget.close();
    await rm(home, { recursive: true, force: true });
  }
});
