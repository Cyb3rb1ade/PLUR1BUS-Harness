import { it } from "node:test";
import assert from "node:assert/strict";
import { AgentCard, generateAgentCardSignature, SendMessageRequest } from "@a2a-js/sdk";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { currentAgentScope, runWithAgentScope, scopeFor } from "../../src/agents/scope.ts";
import { defaults } from "@plur1bus/config-schema";
import type { A2aPeer } from "../../src/a2a/peer-store.ts";
import { createPermissionRuntime } from "../../src/approvals/runtime.ts";
import { staticKeySource } from "../../src/approvals/keys.ts";
import { createCallBudget } from "../../src/budget/calls.ts";
import { composeA2a } from "../../src/composition/a2a.ts";
import { composedAgentRunner } from "../../src/composition/collaboration.ts";
import { createCollab } from "../../src/collab/service.ts";
import { alsAgentScopePort } from "../../src/collab/scope.ts";
import { returnFromText } from "../../src/collab/handoff.ts";
import { createEgress } from "../../src/egress/service.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { ROLES, type Principal } from "../../src/rbac/types.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { collaborationTools } from "../../src/tools/collaboration.ts";
import { fakeSecretService } from "../composition/helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const owner: Principal = { kind: "person", role: "owner", userId: "owner" };
const CARD = "FOREIGN-CARD-TEXT-99112233", TOKEN = "FOREIGN-BEARER-99112233", ANSWER = "FOREIGN-ANSWER-99112233";

async function fixture(options: { echo?: boolean; token?: string; structured?: boolean } = {}) {
  const token = options.token ?? TOKEN;
  const home = tempDir("a2a-integration-");
  const keys = generateKeyPairSync("ed25519");
  let card: Record<string, unknown> = {}, tamper = false, badReply = false;
  const calls: string[] = [], wireErrors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") { calls.push("card"); res.end(JSON.stringify(tamper ? { ...card, description: "TAMPERED-CARD-99112233" } : card)); return; }
      let body = ""; for await (const part of req) body += part;
      const rpc = JSON.parse(body);
      assert.equal(rpc.method, "SendMessage");
      const input = SendMessageRequest.fromJSON(rpc.params);
      assert.equal(input.configuration?.returnImmediately, false);
      assert.deepEqual(input.configuration?.acceptedOutputModes, ["text/plain"]);
      const prompt = JSON.parse(rpc.params.message.parts[0].text);
      assert.deepEqual(prompt.handoff.authority.approvalsHeld, []);
      const ack = prompt.instruction.startsWith("Acceptance check"); calls.push(ack ? "ack" : "run");
      let text = ack ? JSON.stringify({ schema: "plur1bus.ack/1", inReplyTo: prompt.handoff.id, objective: options.echo ? `${prompt.handoff.objective} ${token}` : prompt.handoff.objective, status: "ok", blockingQuestions: [] }) : options.echo ? `${ANSWER} ${token} ${Buffer.from(token).toString('base64')}` : ANSWER;
      if (ack && options.echo) text = text.replaceAll(token, [...token].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
      if (!ack && options.structured) {
        text = JSON.stringify(returnFromText(prompt.handoff, `${ANSWER} ${token}`, { tokens: 1, toolCalls: 1, durationMs: 1 }));
        text = text.replaceAll(token, [...token].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
      }
      const result = { task: { id: "task", contextId: "ctx", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: "reply", parts: [{ text }] }] } };
      res.end(JSON.stringify(badReply ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "REMOTE-ERROR-99112233" } } : { jsonrpc: "2.0", id: rpc.id, result }));
    } catch (error) { wireErrors.push(error); res.statusCode = 500; res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const signed = await generateAgentCardSignature(keys.privateKey, { alg: "EdDSA", typ: "JWT", kid: "peer-key" })(AgentCard.fromJSON({ name: CARD, description: CARD, version: "1", supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0", url: `${origin}/a2a` }], capabilities: { streaming: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [{ id: "chat", name: "Chat", description: "Chat" }] }));
  card = AgentCard.toJSON(signed) as Record<string, unknown>;
  const config = defaults(); config.a2aClient!.enabled = true; config.privacy.localOnly = true;
  config.egress = { allowHosts: ["127.0.0.1"], allowPorts: [address.port], allowLoopback: true };
  const audit = memoryAuditSink();
  const policyAudit = createPolicyAudit({ sink: audit, clock: { now: Date.now } });
  const permissions = createPermissionRuntime({ dbPath: join(home, "approvals.sqlite"), keys: staticKeySource(randomBytes(32)), clock: { now: Date.now }, audit: policyAudit, events: { emit(name, payload) {
    if (name === "approval.requested" && "approval" in payload) {
      const decision = permissions.current()!.service.decideForSession({ requestId: payload.approval.id, person: owner.userId, surface: 3, decision: "approve" });
      assert.equal(decision.ok, true);
    }
  } } });
  const budget = createCallBudget({ path: join(home, "state", "budget.sqlite"), clock: { now: Date.now } });
  const secrets = fakeSecretService({ "peer-token": token });
  const egress = createEgress({ config: () => config.egress });
  const composed = composeA2a({ home, config: () => config, egress: { ...egress, async decide(raw, options) { assert.equal(currentAgentScope(), undefined, 'foreign I/O has no local agent-store authority'); return egress.decide(raw, options); } }, permissions, audit, clock: Date.now, secrets: secrets.service, signal: new AbortController().signal, surfaceOf: () => 3 }, budget, () => {});
  let principal = owner;
  const rpc = guardMethods(composed.methods, { resolve: () => principal, audit, now: Date.now });
  let sequence = 0;
  const invoke = (method: string, params: object) => rpc[method]!(params, { requestId: `rpc-${++sequence}`, connectionId: "owner-connection", signal: new AbortController().signal });
  const added = await invoke("a2a.peer.add", { id: "peer", kid: "peer-key", cardUrl: `${origin}/card`, publicKey: keys.publicKey.export({ format: "jwk" }), credentialSecret: "peer-token" }) as A2aPeer;
  const collab = createCollab({ path: join(home, "collab.sqlite"), runner: composedAgentRunner({ id: "local", async *stream() { throw new Error("must not invoke a local provider"); } }, alsAgentScopePort(), home, [composed.client.target]), directory: { get: id => composed.client.hasAgent(id) ? { id, state: "active", targetKind: "external" } : id === "main" ? { id, state: "active" } : null } });
  const project = collab.createProject(owner, { name: "Remote project", settings: { repeatWindowMs: 0 } });
  collab.addAgent(owner, project.id, "main"); collab.addAgent(owner, project.id, "a2a:peer");
  async function tool(name: string, options: { headless?: boolean; turn?: string } = {}) {
    const turnId = options.turn ?? `turn-${++sequence}`;
    const req = { sessionId: "root-session", turnId, agentId: "main", principal: owner.userId, projectId: project.id, summaries: [], memory: "", messages: [], signal: new AbortController().signal, ...(options.headless ? { headlessJobId: "job" } : {}) };
    const opened = await permissions.open();
    const registry = new ToolRegistry();
    for (const definition of collaborationTools({ collab, enabled: () => true, principal: () => principal, authority: { approvals: opened.stores.approvals, grants: opened.grants, now: Date.now, audit() {} } }, req)) registry.register(definition);
    const dispatcher = new ToolDispatcher({ registry, approvals: opened.service, grants: opened.grants, grantUse: opened.grants, audit: policyAudit, clock: { now: Date.now }, policyContext: ctx => ({ ...opened.service.policyContext()(ctx), ...(options.headless ? { headless: { jobId: "job" } } : {}) }) });
    return dispatcher.call({ id: `tool-${sequence}`, name, args: { projectId: project.id, toAgent: "a2a:peer", objective: "Review a stable sort", doneWhen: ["Advice returned"] } }, { agentId: "main", principal: owner.userId, sessionId: req.sessionId, turnId, surface: 3, signal: req.signal });
  }
  return { home, added, composed, collab, project, audit, calls, wireErrors, config, secrets, invoke, tool, principal: (p: Principal) => { principal = p; }, tamper: () => { tamper = true; }, badReply: () => { badReply = true; }, trust: () => invoke("a2a.peer.trust", { id: added.id, fingerprint: added.fingerprint, revision: added.revision }), async close() { await collab.shutdown(); composed.close(); budget.close(); await permissions.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it("uses real signed discovery, explicit TOFU and D104 ack through consult_agent and delegate_task", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.calls, []); assert.equal(f.added.state, "pending");
    assert.equal((await f.tool("consult_agent")).isError, true); assert.deepEqual(f.calls, []);
    const trusted = await f.trust() as A2aPeer; assert.equal(trusted.state, "trusted"); assert.equal(f.composed.client.hasAgent("a2a:peer"), true);
    const consult = await runWithAgentScope(scopeFor("main", f.home), () => f.tool("consult_agent")); assert.equal(consult.isError, false, JSON.stringify(consult));
    assert.match(JSON.stringify(consult), new RegExp(ANSWER)); assert.match(JSON.stringify(consult), /"origin":"a2a"/); assert.match(JSON.stringify(consult), /"targetKind":"external"/);
    const delegated = await f.tool("delegate_task"); assert.equal(delegated.isError, false, JSON.stringify(delegated));
    assert.deepEqual(f.calls, ["card", "card", "run", "card", "ack", "card", "run"]);
    assert.match(JSON.stringify(delegated), /"origin":"a2a"/);
    const traces = f.collab.listTraces(owner, f.project.id); assert.ok(traces.some(t => t.spans.some(s => s.origin === "a2a" && s.targetKind === "external")));
    assert.equal(existsSync(join(f.home, "agents", "a2a:peer")), false);
    assert.equal(f.audit.events.filter(e => e.action === "a2a.call").length, f.calls.length);
    for (const marker of [CARD, TOKEN, ANSWER]) assert.ok(!JSON.stringify(f.audit.events).includes(marker), marker);
    assert.equal(f.secrets.leases.length, f.calls.length); assert.equal(f.secrets.revoked.length, f.calls.length);
    assert.deepEqual(f.wireErrors, []);
  } finally { await f.close(); }
});

it("rejects every agent role and every non-Owner person on peer RPC, including reads", async () => {
  const f = await fixture();
  try {
    for (const kind of ["agent", "person"] as const) for (const role of ROLES) {
      if (kind === "person" && role === "owner") continue;
      f.principal({ kind, role, userId: "other", tokenScopes: ["a2a.peers.manage"] });
      for (const method of ["a2a.peer.add", "a2a.peer.list", "a2a.peer.remove", "a2a.peer.trust"]) await assert.rejects(Promise.resolve().then(() => f.invoke(method, { id: "peer" })), { error: "E_DENIED" });
    }
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

it("headless calls, changed signatures and remote errors cannot leak peer data", async () => {
  const f = await fixture();
  try {
    await f.trust();
    const before = f.calls.length;
    assert.equal((await f.tool("consult_agent", { headless: true })).isError, true); assert.equal(f.calls.length, before);
    f.badReply(); const remote = await f.tool("consult_agent"); assert.equal(remote.isError, true); assert.ok(!JSON.stringify(remote).includes("REMOTE-ERROR"));
    f.tamper(); const changed = await f.tool("consult_agent"); assert.equal(changed.isError, true); assert.ok(!JSON.stringify(changed).includes("TAMPERED"));
    assert.equal(f.calls.at(-1), "card");
    for (const marker of [CARD, TOKEN, ANSWER, "REMOTE-ERROR", "TAMPERED"]) assert.ok(!JSON.stringify(f.audit.events).includes(marker), marker);
  } finally { await f.close(); }
});

it("redacts successful credential reflections before consult/delegate results and persisted traces", async () => {
  for (const token of [TOKEN, "ABC"]) for (const structured of [false, true]) {
    const f = await fixture({ echo: true, token, structured });
    try {
      await f.trust();
      for (const name of ["consult_agent", "delegate_task"]) {
        const result = await f.tool(name); assert.equal(result.isError, false, name);
        assert.ok(!JSON.stringify(result).includes(token), `${name} exposes no leased credential`);
        if (token.length >= 8) assert.ok(!JSON.stringify(result).includes(Buffer.from(token).toString('base64')));
        assert.match(JSON.stringify(result), new RegExp(ANSWER));
      }
      const traces = f.collab.listTraces(owner, f.project.id);
      assert.ok(!JSON.stringify(traces).includes(token));
      assert.ok(!JSON.stringify(f.audit.events).includes(token));
      const db = new DatabaseSync(join(f.home, "collab.sqlite"), { readOnly: true });
      try { assert.ok(!JSON.stringify(db.prepare("SELECT result_capped FROM tasks").all()).includes(token)); }
      finally { db.close(); }
    } finally { await f.close(); }
  }
});
