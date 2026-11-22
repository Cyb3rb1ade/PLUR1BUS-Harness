// Record the collaboration contract and its refusal paths against the TypeScript implementation.
import { pathToFileURL } from "node:url";
import {
  handoffTicket, prepareHandoff, prepareReturn, validateReturn,
  type Handoff, type HandoffContext, type ReturnEnvelope,
} from "../../packages/core/src/collab/handoff.ts";
import { CollabError } from "../../packages/core/src/collab/errors.ts";
import { exporterMain } from "./lib.mjs";

function contract(): Handoff {
  return {
    schema: "plur1bus.handoff/1", id: "ho_fixture", kind: "delegate",
    from: { agent: "sender", session: "session" }, to: { agent: "receiver" },
    task: { id: "task", project: "project" }, objective: "Check the scheduler",
    doneWhen: ["The scheduler test passes"],
    constraints: { must: [], mustNot: [], scope: { paths: ["src"], tools: ["file.read"] } },
    authority: { mayDecide: [], mustAsk: [], approvalsHeld: [] },
    budget: { tokens: 500, toolCalls: 3, deadline: "2026-10-07T12:00:00Z", modelTier: "standard" },
    returnContract: { format: "plur1bus.return/1", maxTokens: 2000, outputSchema: { type: "string" }, citationsRequired: true },
  };
}

const deadline = Date.parse(contract().budget.deadline);
const baseContext = { person: "member", fromAgent: "sender", sessionId: "session", taskId: "task", projectId: "project" };
const approval = {
  status: "approved", delegable: true, expiresAt: deadline,
  bound: { principal: "member", taskId: "task", sessionId: "session", subject: { kind: "agent", id: "sender" } },
};
const grant = {
  revoked: false, delegable: true, expiresAt: deadline, person: "member", taskId: "task", agent: "sender",
};
const ack = { schema: "plur1bus.ack/1", inReplyTo: "ho_fixture", objective: "Check the scheduler", status: "ok", blockingQuestions: [] };
const report: ReturnEnvelope = {
  schema: "plur1bus.return/1", id: "rt_fixture", inReplyTo: "ho_fixture", status: "done",
  summary: "The test passed", doneWhen: [], changes: [], artifacts: [], concerns: [], blockedBy: null,
  needs: [], assumptionsChecked: [], learned: [], suggestedNext: [],
  usage: { tokens: 3, toolCalls: 1, durationMs: 1 }, output: "pass", citations: ["test:scheduler"],
};

type Step = { op: "ack"; input: unknown } | { op: "start" } | { op: "expire" } | { op: "revoke" };

async function cases() {
  const results: unknown[] = [];
  async function capture(work: () => unknown) {
    try { return { ok: (await work()) ?? null }; }
    catch (e) {
      if (e instanceof CollabError) return { err: { code: e.code, message: e.message, reason: e.reason ?? null } };
      throw e;
    }
  }

  async function prepare(name: string, input: unknown, options: {
    repair?: unknown; history?: boolean; expected?: boolean; record?: unknown; grant?: unknown; until?: number;
  } = {}) {
    const audits: string[] = [];
    let repairs = 0;
    const context = {
      ...baseContext, now: () => options.until ?? deadline - 1, hasHistory: options.history,
      expected: options.expected ? contract() : undefined,
      approvals: { get: () => options.record ?? null }, grants: { get: () => options.grant ?? null },
      audit: e => audits.push(e.reason),
    } as HandoffContext;
    const result = await capture(() => prepareHandoff(input, context, options.repair === undefined ? undefined
      : async () => { repairs++; return options.repair; }));
    results.push({ op: "prepare", name, input: JSON.stringify(input),
      ...(options.repair === undefined ? {} : { repair: JSON.stringify(options.repair) }),
      history: options.history ?? false, expected: options.expected ? JSON.stringify(contract()) : null,
      record: options.record ?? null, grant: options.grant ?? null, now: context.now(), result, audits, repairs });
  }

  const bound = contract();
  bound.authority.approvalsHeld = ["approval-fixture"];
  await prepare("valid", contract());
  await prepare("valid approval", bound, { record: approval });
  await prepare("valid grant", bound, { grant });
  await prepare("unknown authority", bound, { repair: contract() });
  await prepare("approval takes precedence", bound, { record: { ...approval, status: "used" }, grant });
  await prepare("wrong approval person", bound, { record: { ...approval, bound: { ...approval.bound, principal: "other" } } });
  await prepare("wrong approval agent kind", bound, { record: { ...approval, bound: { ...approval.bound, subject: { ...approval.bound.subject, kind: "person" } } } });
  await prepare("wrong approval task", bound, { record: { ...approval, bound: { ...approval.bound, taskId: "other" } } });
  await prepare("wrong approval session", bound, { record: { ...approval, bound: { ...approval.bound, sessionId: "other" } } });
  await prepare("nondelegable approval", bound, { record: { ...approval, delegable: false } });
  await prepare("expired approval", bound, { record: { ...approval, expiresAt: deadline - 1 } });
  await prepare("revoked grant", bound, { grant: { ...grant, revoked: true } });
  await prepare("consumed grant", bound, { grant: { ...grant, consumedAt: 0 } });
  await prepare("expired grant", bound, { grant: { ...grant, expiresAt: deadline - 1 } });
  await prepare("wrong grant agent", bound, { grant: { ...grant, agent: "other" } });
  await prepare("wrong task project", { ...contract(), task: { id: "task", project: "other" } });
  await prepare("expired contract", contract(), { until: deadline });
  await prepare("repair oversized", { ...contract(), objective: "é".repeat(1500) }, { repair: contract() });
  await prepare("repair cannot change scope", {}, { expected: true, repair: {
    ...contract(), constraints: { ...contract().constraints, scope: { paths: ["other"], tools: [] } },
  } });
  await prepare("bad repair", {}, { repair: [] });
  await prepare("history without attempts", contract(), { history: true });
  await prepare("handoff without state", { ...contract(), kind: "handoff" });
  await prepare("no criteria", { ...contract(), doneWhen: [] });
  await prepare("invalid date", { ...contract(), budget: { ...contract().budget, deadline: "n/a" } });
  await prepare("unsupported output schema", { ...contract(), returnContract: { ...contract().returnContract, outputSchema: { $ref: "unsupported" } } });

  async function ticket(name: string, h: Handoff, record: typeof approval | null, steps: Step[]) {
    let now = deadline - 1;
    let active = record;
    const audits: string[] = [];
    const context = {
      ...baseContext, now: () => now, approvals: { get: () => active }, grants: { get: () => null },
      audit: e => audits.push(e.reason),
    } as HandoffContext;
    const t = handoffTicket(h, context);
    const outcomes = [];
    for (const step of steps) {
      outcomes.push(await capture(() => {
        switch (step.op) {
          case "ack": return t.ack(step.input);
          case "start": return t.start(async accepted => accepted.id);
          case "expire": now = deadline; break;
          case "revoke": active = null; break;
        }
      }));
    }
    results.push({ op: "ticket", name, input: JSON.stringify(h), record, now: deadline - 1, deadline, steps, digest: t.digest, outcomes, audits });
  }

  await ticket("ack binding and once-only start", contract(), null, [
    { op: "start" }, { op: "ack", input: {} }, { op: "ack", input: { ...ack, inReplyTo: "other" } },
    { op: "ack", input: { ...ack, status: "blocked" } }, { op: "ack", input: { ...ack, blockingQuestions: ["scope?"] } },
    { op: "start" }, { op: "ack", input: ack }, { op: "start" }, { op: "start" },
  ]);
  await ticket("expires after ack", contract(), null, [{ op: "ack", input: ack }, { op: "expire" }, { op: "start" }]);
  await ticket("revoked after ack", bound, approval, [{ op: "ack", input: ack }, { op: "revoke" }, { op: "start" }]);
  await ticket("consult requires no ack", { ...contract(), kind: "consult" }, null, [{ op: "start" }]);

  for (const [name, input, repair] of [
    ["valid return", report],
    ["wrong return binding", { ...report, inReplyTo: "other" }],
    ["return byte bound", { ...report, summary: "é".repeat(900) }],
    ["missing citations", { ...report, citations: [] }],
    ["output schema mismatch", { ...report, output: 42 }],
    ["partial skips successful output requirements", { ...report, status: "partial", output: null, citations: [] }],
    ["sender repairs return", {}, report],
    ["sender cannot repeatedly repair return", {}, {}],
  ] as const) {
    let repairs = 0;
    const h = contract();
    const result = await capture(() => repair === undefined ? validateReturn(input, h)
      : prepareReturn(input, h, async () => { repairs++; return repair; }));
    results.push({ op: "return", name, contract: JSON.stringify(h), input: JSON.stringify(input),
      ...(repair === undefined ? {} : { repair: JSON.stringify(repair) }), result, repairs });
  }
  return results;
}

export async function buildCollabHandoffVectors() {
  return { handoff: await cases() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "collab", build: buildCollabHandoffVectors });
}
