// Record native coding-session and ACP presence behavior through the actual TypeScript class.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodingSessions } from "../../packages/core/src/coding/sessions.ts";
import { SessionStore } from "../../packages/core/src/session/store.ts";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { exporterMain } from "./lib.mjs";

const owner = { kind: "person", role: "owner", userId: "owner" } as const;
const caller = { channel: "cli", accountId: "host", userId: "owner" } as const;
const connection = { connectionId: "fixture", surface: 1 as const };

async function record(name: string, root: string, home: string) {
  let includeRoot = !["no grant", "interactive request"].includes(name);
  const ended: string[] = [], audit: string[] = [];
  let asked = 0, afterClose: boolean | null = null;
  let active: (() => boolean) | null = null;
  let ids = 0;
  const store = new SessionStore({ path: ":memory:", clock: () => 100, newId: prefix => prefix + "_" + ++ids });
  const coding = new CodingSessions({
    home, store: () => store, storeFor: () => store, ephemeral: () => store,
    agents: { workspaceOf: (id: string) => id === "worker" ? root : undefined } as never,
    roots: () => includeRoot ? [{ id: "workspace", path: root }] : [],
    grants: { list: () => [], get: () => undefined }, clock: () => 100,
    audit: { append(event) { audit.push(event.action); } },
    requestFolder(input) {
      asked++;
      active = input.sessionActive;
      return { id: "folder-fixture", status: "pending" } as never;
    },
    cancelFolder() {}, endTask: id => ended.push(id), resolvePerson: id => id === owner.userId ? owner : null,
  });
  const params = { caller, agentId: "worker", root };
  const approver = (id: string, conn = connection.connectionId) => coding.approver(conn, id, { person: owner.userId, surface: 1 });
  let result;
  try {
    if (name.startsWith("prepare ")) {
      const session = store.createSession({ kind: "acp", agentId: params.agentId, owner: deriveUserPrincipal(owner.userId) });
      await coding.open({ ...params, sessionId: session.id, interactive: false }, owner, connection);
      if (name === "prepare closed") coding.connectionClosed(connection.connectionId);
      if (name === "prepare revoked") includeRoot = false;
      const req = {
        sessionId: session.id, agentId: "worker",
        principal: name === "prepare wrong owner" ? deriveUserPrincipal("other") : session.owner,
        caller, approver: approver(session.id), role: name === "prepare role" ? "engine" as const : undefined,
        summaries: [], memory: "", messages: [], signal: new AbortController().signal,
      };
      const prepared = await coding.prepare(req);
      result = { ok: { coding: coding.enabled(prepared), project: prepared.projectId ?? null } };
    } else if (name === "ACP mode"
 || name === "different connection" || name === "grant revoked") {
      const session = store.createSession({ kind: "acp", agentId: params.agentId, owner: deriveUserPrincipal(owner.userId) });
      const bound = await coding.open({ ...params, sessionId: session.id, interactive: false }, owner, connection);
      const before = approver(session.id);
      if (name === "grant revoked") includeRoot = false;
      const next = await coding.setMode({ caller, sessionId: session.id, mode: "chat" }, owner,
        name === "different connection" ? { ...connection, connectionId: "other" } : connection);
      const after = approver(session.id);
      coding.connectionClosed(connection.connectionId);
      result = { ok: { state: bound.state, changed: next.changed, mode: next.mode,
        before: before.codingMode ?? null, surface: before.surface,
        after: after.codingMode ?? null, taskAlive: coding.hasTask(before.taskId!, session.id, owner.userId),
        taskEnded: ended.includes(before.taskId!) } };
    } else if (name === "foreign source") {
      const session = store.createSession({ kind: "direct", agentId: params.agentId, owner: deriveUserPrincipal("other") });
      await coding.open({ ...params, sessionId: session.id }, owner, connection);
      result = { ok: true };
    } else {
      const open = await coding.open({ ...params, interactive: name === "interactive request" }, owner, connection);
      if (open.state === "grant-required") {
        const before = active?.() ?? false;
        coding.connectionClosed(connection.connectionId);
        afterClose = active?.() ?? null;
        result = { ok: { state: open.state, grant: open.grant.approvalId, before, afterClose } };
      } else {
        const resumed = await coding.open({ ...params, sessionId: open.session.id }, owner, connection);
        result = { ok: { state: open.state, kind: open.session.kind, sameSession: resumed.session.id === open.session.id,
          matchesRoot: store.worktree(open.session.id)?.root === root } };
      }
    }
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    result = { err: { code: e.error, reason: e.reason ?? null, message: e.message } };
  }
  const output = { name, result, asked, audit: [...audit], ended: ended.length };
  coding.close(); store.close();
  return output;
}

export async function buildCodingSessionVectors() {
  const dir = mkdtempSync(join(tmpdir(), "p4k-coding-sessions-"));
  try {
    const tmp = realpathSync.native(dir);
    const home = join(tmp, "core-home"), root = join(tmp, "work");
    mkdirSync(home); mkdirSync(root);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull });
    execFileSync("git", ["init", "--template=", "-q", root], { env, stdio: "pipe" });
    const sessions = [];
    for (const name of ["direct", "no grant", "interactive request", "ACP mode", "different connection", "grant revoked", "foreign source",
      "prepare coding", "prepare role", "prepare closed", "prepare revoked", "prepare wrong owner"]) {
      sessions.push(await record(name, root, home));
    }
    return { sessions };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildCodingSessionVectors });
}
