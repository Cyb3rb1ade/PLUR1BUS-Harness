// Record the service's repository binding and transcript replay against the TypeScript implementation.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CollabError } from "../../packages/core/src/collab/errors.ts";
import { createCollab } from "../../packages/core/src/collab/service.ts";
import { exporterMain } from "./lib.mjs";

const lead = { userId: "lead", kind: "person", role: "owner" } as const;
const member = { userId: "member", kind: "person", role: "member", projectRights: { project: "member" } } as const;
const traceId = "00000000000000000000000000000001";
const spanId = "0000000000000001";
const sessionId = "session";
const marker = "[fixture-private]";
const redactText = (s: string) => s.replaceAll(marker, "[masked]").replaceAll(traceId, "[masked]").replaceAll(spanId, "[masked]");

function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactText(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)]));
  return v;
}

function outcome(run: () => unknown) {
  try { return { ok: run() }; }
  catch (error) {
    if (error instanceof CollabError) return { err: { code: error.code, reason: error.reason ?? null, message: error.message } };
    throw error;
  }
}

function repoVectors() {
  const root = mkdtempSync(join(tmpdir(), "p4k-collab-binding-"));
  try {
    const home = join(root, "home"), repo = join(root, "repo"), nested = join(repo, "sub");
    const inside = join(home, "private"), bare = join(root, "bare"), file = join(root, "file");
    for (const dir of [nested, inside, bare]) mkdirSync(dir, { recursive: true });
    writeFileSync(file, "");
    const canon = realpathSync.native(repo), bareCanon = realpathSync.native(bare);
    const calls: string[][] = [];
    const service = createCollab({ path: ":memory:", home, clock: () => 1, newId: () => "project", git: {
      run(args, cwd) {
        calls.push([...args]);
        if (args[1] === "--is-bare-repository") return cwd === bareCanon ? "true\n" : "false\n";
        if (args[1] === "--show-toplevel") return canon;
        if (args[1] === "--verify" && args.at(-1) === "refs/heads/main") return "commit\n";
        throw new Error("unknown branch");
      },
    } });
    try {
      const p = service.createProject(lead, { name: "Fixture" });
      service.addMember(lead, p.id, member.userId, "member");
      const cases = [];
      for (const [name, who, where, path, branch] of [
        ["member", member, "repo", repo, "main"],
        ["agent", { ...lead, kind: "agent" } as const, "repo", repo, "main"],
        ["empty branch", lead, "repo", repo, ""],
        ["unsafe branch", lead, "repo", repo, "feature/-option"],
        ["branch traversal", lead, "repo", repo, "feature/../main"],
        ["long branch", lead, "repo", repo, "b".repeat(129)],
        ["inside home", lead, "inside", inside, "main"],
        ["missing directory", lead, "missing", join(root, "missing"), "main"],
        ["regular file", lead, "file", file, "main"],
        ["bare repository", lead, "bare", bare, "main"],
        ["nested directory", lead, "nested", nested, "main"],
        ["missing branch", lead, "repo", repo, "missing"],
        ["bind", lead, "repo", repo, "main"],
      ] as const) {
        const result = outcome(() => {
          const bound = service.bindRepo(who, p.id, path, branch).repo;
          return { canonical: bound?.repoPath === canon, branch: bound?.baseBranch };
        });
        cases.push({ name, who: who.kind === "agent" ? "agent" : who.userId, where, branch, result, calls: calls.splice(0) });
      }
      cases.push({ name: "unbind", result: outcome(() => service.unbindRepo(lead, p.id).repo ?? null) });
      return cases;
    } finally { service.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function replayVectors() {
  let owner = "collab-project:project", scope = "project", session: string | null = sessionId;
  const messages = [{ id: "message", sessionId, turnId: "turn", seq: 1, role: "user", text: marker, tokens: 1, createdAt: 1 }];
  const data = [
    { provenance: { traceId, spanId, nested: { traceId, spanId }, detail: marker }, text: marker },
    { provenance: { traceId: marker, spanId } },
    { traceId, spanId, provenance: [traceId, spanId] },
    { provenance: null, text: marker },
  ];
  const events = data.map((entry, index) => ({ sessionId, turnId: "turn", seq: index + 1, type: "tool.result", at: 1, data: entry }));
  const reads: string[] = [];
  const service = createCollab({ path: ":memory:", clock: () => 1, newId: () => "project",
    redact: { text: redactText, value: redactValue },
    sessions: () => ({
      getSession: id => { reads.push("session"); return id === session ? { id, scope, owner } : null; },
      listMessages: () => { reads.push("messages"); return messages; },
      listEvents: () => { reads.push("events"); return events; },
    }),
  });
  try {
    const p = service.createProject(lead, { name: "Fixture" });
    service.worktreeStore.insertTrace({ traceId, projectId: p.id, rootAgent: "sender", rootSpanId: spanId });
    service.worktreeStore.insertSpan({ traceId, spanId, parentSpanId: null, agentId: "receiver", kind: "delegate" });
    service.worktreeStore.bindSession(spanId, sessionId);
    const cases = [];
    for (const [name, who, span] of [["outsider", member, spanId], ["wrong span", lead, "missing"], ["wrong scope", lead, spanId],
      ["wrong owner", lead, spanId], ["missing session", lead, spanId], ["replay", lead, spanId]] as const) {
      scope = name === "wrong scope" ? "other" : "project";
      owner = name === "wrong owner" ? "collab-project:other" : "collab-project:project";
      session = name === "missing session" ? null : sessionId;
      cases.push({ name, who: who.userId, span, owner, scope, session, result: outcome(() => service.replay(who, traceId, span)),
        reads: reads.splice(0) });
    }
    return { traceId, spanId, sessionId, marker, messages, events, cases };
  } finally { service.close(); }
}

export function buildCollabServiceVectors() {
  return { "repo-binding": repoVectors(), replay: replayVectors() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "collab", build: buildCollabServiceVectors });
}
