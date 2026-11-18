// Parity vectors (mode V) for the session store (P4-K K5a, plan P4-40): the real `SessionStore` of
// `packages/core/src/session/store.ts` runs scripted scenarios over a temporary `sessions.sqlite` with a scripted clock and
// scripted ids (`<prefix>_<n>`), and every op's answer is recorded as `{ ok }` or `{ err: { code, reason, message } }`.
// `crates/plur1bus-core/src/sessions/vectors.rs` replays every scenario over its own file and must give the same answers, the
// same stored bytes (raw `sql` ops read the file through a second connection) and the same schema text. The pure helpers
// (`activePath`, `hiddenDigest`, `failedEditCycles`, `ftsQuery`, `TokenMeter`, `catalogWindow`) are recorded case by case.
// Recorded, never edited by hand.
//
// A scenario is `{ name, ops }`. In a chat-page op, `afterLast: true` takes the keyset from the last row of the previous
// page; a `reserve` op names the reservation that a later `reservation` field refers to.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-sessions.ts [--check]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { exporterMain } from "./lib.mjs";
import { SessionStore, ftsQuery } from "../../packages/core/src/session/store.ts";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../../packages/core/src/session/migrations.ts";
import { TokenMeter, catalogWindow } from "../../packages/core/src/session/tokens.ts";
import { activePath, activeSummaries, hiddenDigest } from "../../packages/core/src/session/rewind-path.ts";
import { failedEditCycles } from "../../packages/core/src/session/rewind-cycles.ts";
import { SessionError } from "../../packages/core/src/session/types.ts";

type Op = Record<string, any>;
const errOf = (e: unknown) => e instanceof SessionError
  ? { code: e.code, ...(e.reason !== undefined ? { reason: e.reason } : {}), message: e.message }
  : { name: String((e as any)?.name ?? "Error"), message: String((e as any)?.message) };

/** One scenario over a fresh file. */
function run(name: string, ops: Op[], start = 1_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-sessions-"));
  const path = join(dir, "sessions.sqlite");
  let now = start, n = 0;
  const open = () => new SessionStore({ path, clock: () => now, newId: (p) => `${p}_${++n}` });
  let store = open();
  let raw: DatabaseSync | null = null;
  const rawDb = () => (raw ??= new DatabaseSync(path));
  const reservations = new Map<string, { token: symbol; release(): void }>();
  const archived: string[] = []; let erased = 0;
  const catalog = (models: any[]) => ({ read: () => ({ models }) });
  let lastPage: any = null;
  const steps: unknown[] = [];
  let lastTurn = "", lastSession = "";
  const reservationOf = (o: Op) => (o.reservation ? reservations.get(o.reservation)?.token : undefined);
  const audit = (o: Op, log: unknown[]) => (o.audit === undefined ? undefined : (ev: any) => { log.push(ev); if (o.audit === "fail") throw new Error("audit down"); });
  try {
    for (let op of ops) {
      // `$turn`: the turn the last successful `begin` opened; `$ses`: the session the last successful create/fork made.
      if (op.turnId === "$turn") op = { ...op, turnId: lastTurn };
      if (op.checkpoint?.turnId === "$turn") op = { ...op, checkpoint: { ...op.checkpoint, turnId: lastTurn } };
      if (op.id === "$ses") op = { ...op, id: lastSession };
      if (op.sessionId === "$ses") op = { ...op, sessionId: lastSession };
      let out: unknown;
      try {
        const s = store;
        switch (op.op) {
          case "create": { const r = s.createSession(op.input); lastSession = r.id; out = { ok: r }; break; }
          case "continuation": { const r = s.createContinuation(op.input); lastSession = r.id; out = { ok: r }; break; }
          case "get": out = { ok: s.getSession(op.id) }; break;
          case "activeForChat": out = { ok: s.activeForChat(op.chatKey) }; break;
          case "getOwned": out = { ok: s.getOwned(op.id, op.owner) }; break;
          case "learningSessions": out = { ok: s.learningSessions(op.filter) }; break;
          case "list": out = { ok: s.listSessions(op.filter) }; break;
          case "chatList": {
            const f = { ...op.filter };
            if (op.afterLast && lastPage?.sessions.length) { const l = lastPage.sessions.at(-1); f.after = { pinned: l.pinned, updatedAt: l.updatedAt, id: l.id }; }
            lastPage = s.listChatSessions(f); out = { ok: lastPage }; break;
          }
          case "overview": out = { ok: s.listOverview(op.filter) }; break;
          case "searchMessages": out = { ok: s.searchMessages(op.filter) }; break;
          case "update": out = { ok: s.updateSession(op.id, op.patch) }; break;
          case "archive": out = { ok: s.archiveSession(op.id) }; break;
          case "restore": out = { ok: s.restoreSession(op.id) }; break;
          case "fork": { const r = s.forkSession(op.id, op.options ?? {}); lastSession = r.id; out = { ok: r }; break; }
          case "erase": out = { ok: s.eraseSession(op.id, op.options) }; break;
          case "erasures": out = { ok: s.erasures() }; break;
          case "listen": s.onArchived((id) => { archived.push(id); }); s.onErasure(() => { erased++; }); out = { ok: null }; break;
          case "listened": out = { ok: { archived: [...archived], erased } }; break;
          case "begin": { const b = s.beginTurn(op.sessionId, op.text, op.tokens, op.options ?? {}); lastTurn = b.turn.id; out = { ok: b }; break; }
          case "complete": out = { ok: s.completeTurn(op.turnId, op.input) }; break;
          case "fail": out = { ok: s.failTurn(op.turnId, op.error, op.data) }; break;
          case "recover": out = { ok: s.recoverRunningTurns() }; break;
          case "lastEventSeq": out = { ok: s.lastEventSeq(op.sessionId) }; break;
          case "running": out = { ok: s.runningTurn(op.sessionId) }; break;
          case "getTurn": out = { ok: s.getTurn(op.id) }; break;
          case "turns": out = { ok: s.listTurns(op.sessionId) }; break;
          case "append": out = { ok: s.appendEvent(op.turnId, op.type, op.data) }; break;
          case "events": out = { ok: s.listEvents(op.sessionId, op.after, op.limit) }; break;
          case "toolResult": out = { ok: s.toolResult(op.sessionId, op.callId) }; break;
          case "messages": out = { ok: s.listMessages(op.sessionId, op.query ?? {}) }; break;
          case "harnessTurns": out = { ok: [...s.harnessCommandTurns(op.sessionId)].sort() }; break;
          case "contextMessages": out = { ok: s.contextMessages(op.sessionId, op.options ?? {}) }; break;
          case "rewinds": out = { ok: s.rewinds(op.sessionId) }; break;
          case "summaryRewinds": out = { ok: s.summaryRewinds(op.sessionId) }; break;
          case "freezeMemory": out = { ok: s.freezePromptSnapshot(op.sessionId, op.text) }; break;
          case "freezeCatalogue": out = { ok: s.freezeSkillCatalogue(op.sessionId, op.text) }; break;
          case "skillEvents": out = { ok: s.skillEvents(op.sessionId) }; break;
          case "offers": out = { ok: s.toolOffers(op.sessionId) }; break;
          case "rememberOffers": out = { ok: s.rememberToolOffers(op.sessionId, op.names) ?? null }; break;
          case "modelProfile": out = { ok: s.modelProfile(op.sessionId) }; break;
          case "modelReasoning": out = { ok: s.modelReasoning(op.sessionId) }; break;
          case "setModelProfile": out = { ok: s.setModelProfile(op.sessionId, op.profile, op.revision, op.reasoning, op.person, op.details) }; break;
          case "modelChanges": out = { ok: s.modelChanges(op.sessionId) }; break;
          case "worktree": out = { ok: s.worktree(op.sessionId) }; break;
          case "bindWorktree": out = { ok: s.bindWorktree(op.binding) ?? null }; break;
          case "recordCheckpoint": out = { ok: s.recordCheckpoint(op.checkpoint) ?? null }; break;
          case "checkpoint": out = { ok: s.checkpoint(op.sessionId, op.turnId) }; break;
          case "hasCheckpoints": out = { ok: s.hasCheckpoints() }; break;
          case "checkpoints": out = { ok: s.checkpoints(op.sessionId) }; break;
          case "latestTurnSeq": out = { ok: s.latestTurnSeq(op.sessionId) }; break;
          case "forgetCheckpoint": out = { ok: s.forgetCheckpoint(op.checkpoint) ?? null }; break;
          case "rewindProposal": out = { ok: s.rewindProposal(op.sessionId) }; break;
          case "proposeRewind": out = { ok: s.proposeRewind(op.sessionId, op.proposal) }; break;
          case "planRewind": out = { ok: s.planRewind(op.sessionId, op.to, op.commandTurnId, reservationOf(op)) }; break;
          case "rewind": {
            const log: unknown[] = [];
            try { out = { ok: s.rewindPath(op.sessionId, { toSeq: op.to, lesson: op.lesson, actor: op.actor, trigger: op.trigger, expectedEventSeq: op.expectedEventSeq, audit: audit(op, log), commandTurnId: op.commandTurnId, reservation: reservationOf(op) }), audit: log }; }
            catch (e) { out = { err: errOf(e), audit: log }; }
            break;
          }
          case "undoRewind": {
            const log: unknown[] = [];
            try { out = { ok: s.undoRewind(op.sessionId, op.rewindId, op.actor, audit(op, log), op.commandTurnId), audit: log }; }
            catch (e) { out = { err: errOf(e), audit: log }; }
            break;
          }
          case "reserve": { reservations.set(op.name, s.reserveRewind(op.sessionId, op.commandTurnId)); out = { ok: null }; break; }
          case "release": { reservations.get(op.name)?.release(); out = { ok: null }; break; }
          case "reserved": out = { ok: s.rewindReserved(op.sessionId) }; break;
          case "tokenCalibration": out = { ok: s.tokenCalibration(op.model) }; break;
          case "tokenFactor": out = { ok: s.tokenFactor(op.model) }; break;
          case "setTokenFactor": out = { ok: s.setTokenFactor(op.model, op.factor) ?? null }; break;
          case "meterCount": out = { ok: new TokenMeter(s).count(op.model, op.text, op.measured) }; break;
          case "meterObserve": new TokenMeter(s).observe(op.model, op.estimated, op.measured); out = { ok: s.tokenCalibration(op.model) }; break;
          case "recordUsage": out = { ok: s.recordMessageUsage(op.id, op.model, op.tokens) ?? null }; break;
          case "messageUsage": out = { ok: s.messageUsage(op.id, op.model, op.text) ?? null }; break;
          case "visibility": out = { ok: s.toolVisibility(op.sessionId) }; break;
          case "setVisibility": out = { ok: s.setToolVisibility(op.sessionId, op.ref, op.hidden, op.reason, op.detail) ?? null }; break;
          case "setVisibilities": out = { ok: s.setToolVisibilities(op.sessionId, op.changes) ?? null }; break;
          case "latestAssistant": out = { ok: s.latestAssistantContext(op.sessionId) }; break;
          case "pruneExplanation": out = { ok: s.pruneExplanation(op.sessionId) }; break;
          case "refetch": out = { ok: s.recordToolRefetch(op.sessionId, op.ref) ?? null }; break;
          case "pruneMetrics": out = { ok: s.pruneMetrics(op.sessionId) }; break;
          case "toolEvents": out = { ok: s.toolEvents(op.sessionId) }; break;
          case "contextToolEvents": out = { ok: s.contextToolEvents(op.sessionId) }; break;
          case "addSummary": out = { ok: s.addSummary(op.summary) }; break;
          case "summaries": out = { ok: s.listSummaries(op.sessionId, op.state) }; break;
          case "setSummaryState": out = { ok: s.setSummaryState(op.id, op.state) ?? null }; break;
          case "replaceSummaries": out = { ok: s.replaceSummaries(op.supersede, op.next) }; break;
          case "learningToolErrors": out = { ok: s.learningToolErrors(op.owner, op.window, op.limit) }; break;
          case "learningTranscript": out = { ok: s.learningTranscript(op.sessionId, op.window, op.caps, op.turnIds) }; break;
          case "catalogWindow": out = { ok: catalogWindow(catalog(op.models), op.model) ?? null }; break;
          case "advance": now += op.ms; out = { ok: now }; break;
          case "reopen": s.close(); raw?.close(); raw = null; store = open(); out = { ok: null }; break;
          case "sql": {
            const stmt = rawDb().prepare(op.sql);
            // The `data` column is JSON text whose member order the fixture's canonical form cannot keep: compare it parsed.
            out = { ok: (stmt.all(...(op.args ?? [])) as any[]).map((r) => { const o: any = { ...r }; if (typeof o.data === "string") { try { o.data = JSON.parse(o.data); } catch { /* keep text */ } } return o; }) }; break;
          }
          case "sqlWrite": { rawDb().exec(op.sql); out = { ok: null }; break; }
          default: throw new Error(`unknown op ${op.op}`);
        }
      } catch (e) { out = { err: errOf(e) }; }
      steps.push({ op, ...(out as object) });
    }
  } finally {
    try { store.close(); } catch { /* closed */ }
    try { raw?.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
  return { name, ops: steps };
}

// ---- builders --------------------------------------------------------------------------------------------------------

const direct = (over: Op = {}) => ({ op: "create", input: { kind: "direct", agentId: "bernd", owner: "user:v1:alice", ...over } });
const turn = (sid: string, text: string, completeText?: string, data?: Op): Op[] => [
  { op: "begin", sessionId: sid, text, tokens: Math.ceil(text.length / 4) },
  ...(completeText === undefined ? [] : [{ op: "complete", turnId: "$turn", input: { text: completeText, tokens: Math.ceil(completeText.length / 4), ...(data ? { data } : {}) } }]),
];
/** Resolves `"$turn"` against the id of the last begun turn at build time: ids are scripted, so a counter predicts them. */
function withIds(ops: Op[]): Op[] { return ops; }
const sql = (text: string, ...args: unknown[]): Op => ({ op: "sql", sql: text, args });

// ---- scenarios -------------------------------------------------------------------------------------------------------

function sessionScenarios() {
  const out: unknown[] = [];
  out.push(run("create-and-validate", [
    direct(), direct({ title: "t".repeat(199) + "\u{1F600}x" }), direct({ title: "a".repeat(250) }), direct({ scope: "project-1", origin: "mcp", memoryMode: "incognito" }),
    direct({ origin: "a2a" }), direct({ origin: "acp-agent" }),
    { op: "create", input: { kind: "channel", agentId: "bernd", owner: "u", chatKey: "tg:1" } },
    { op: "create", input: { kind: "channel", agentId: "bernd", owner: "u" } }, { op: "create", input: { kind: "channel", agentId: "bernd", owner: "u", chatKey: "" } },
    direct({ chatKey: "tg:2" }), direct({ chatKey: "" }), direct({ agentId: "" }), direct({ owner: "" }), { op: "create", input: { kind: "card", agentId: "a", owner: "o" } },
    { op: "create", input: { kind: "project", agentId: "a", owner: "o", title: "p" } }, { op: "create", input: { kind: "acp", agentId: "a", owner: "o" } },
    { op: "get", id: "ses_2" }, { op: "get", id: "missing" }, { op: "getOwned", id: "ses_1", owner: "user:v1:alice" }, { op: "getOwned", id: "ses_1", owner: "user:v1:bob" }, { op: "getOwned", id: "nope", owner: "x" },
    sql("SELECT id, kind, agent_id, owner, scope, chat_key, origin, title, pinned, memory_mode, created_at, updated_at, last_turn_at, archived_at, turn_count, last_message_seq, last_event_seq FROM sessions ORDER BY rowid"),
  ]));
  out.push(run("immutability", [
    direct(),
    { op: "sqlWrite", sql: "UPDATE sessions SET kind='card' WHERE id='ses_1'" },
    { op: "sqlWrite", sql: "UPDATE sessions SET agent_id='x' WHERE id='ses_1'" }, { op: "sqlWrite", sql: "UPDATE sessions SET owner='x' WHERE id='ses_1'" },
    { op: "sqlWrite", sql: "UPDATE sessions SET scope='x' WHERE id='ses_1'" }, { op: "sqlWrite", sql: "UPDATE sessions SET chat_key='x' WHERE id='ses_1'" },
    { op: "sqlWrite", sql: "UPDATE sessions SET origin='mcp' WHERE id='ses_1'" }, { op: "sqlWrite", sql: "UPDATE sessions SET origin='nope' WHERE id='ses_1'" },
    { op: "sqlWrite", sql: "UPDATE sessions SET title='raw ok' WHERE id='ses_1'" }, { op: "sqlWrite", sql: "UPDATE sessions SET kind='direct' WHERE id='ses_1'" },
    { op: "sqlWrite", sql: "INSERT INTO sessions(id,kind,agent_id,owner,scope,chat_key,created_at,updated_at) VALUES ('x','direct','a','o','s','k',1,1)" },
    { op: "sqlWrite", sql: "INSERT INTO sessions(id,kind,agent_id,owner,scope,created_at,updated_at) VALUES ('y','channel','a','o','s',1,1)" },
    { op: "sqlWrite", sql: "INSERT INTO sessions(id,kind,agent_id,owner,scope,created_at,updated_at,memory_mode) VALUES ('z','direct','a','o','s',1,1,'bogus')" },
    { op: "update", id: "ses_1", patch: { title: "new title", pinned: true } }, { op: "update", id: "ses_1", patch: { memoryMode: "incognito" } }, { op: "update", id: "ses_1", patch: { title: "z".repeat(300) } },
    { op: "update", id: "ses_1", patch: { title: "\u{1F600}".repeat(150) } }, { op: "update", id: "ses_1", patch: {} }, { op: "update", id: "missing", patch: { title: "x" } },
    { op: "update", id: "ses_1", patch: { kind: "card" } }, { op: "update", id: "ses_1", patch: { owner: "x" } }, { op: "update", id: "ses_1", patch: { title: "ok", agentId: "x" } },
    { op: "archive", id: "ses_1" }, { op: "update", id: "ses_1", patch: { title: "archived" } },
  ]));
  out.push(run("chat-keys", [
    { op: "listen" },
    { op: "create", input: { kind: "channel", agentId: "bernd", owner: "alice", chatKey: "tg:1" } },
    { op: "create", input: { kind: "channel", agentId: "bernd", owner: "alice", chatKey: "tg:1" } },
    { op: "create", input: { kind: "channel", agentId: "bernd", owner: "bob", chatKey: "tg:1", replaceActive: true } },
    { op: "activeForChat", chatKey: "tg:1" }, { op: "activeForChat", chatKey: "tg:none" },
    { op: "create", input: { kind: "channel", agentId: "bernd", owner: "alice", chatKey: "tg:1", replaceActive: true } },
    { op: "activeForChat", chatKey: "tg:1" }, { op: "get", id: "ses_1" },
    { op: "begin", sessionId: "ses_4", text: "hello", tokens: 2 },
    { op: "create", input: { kind: "channel", agentId: "bernd", owner: "alice", chatKey: "tg:1", replaceActive: true } },
    { op: "archive", id: "ses_4" }, { op: "complete", turnId: "$turn", input: { text: "hi", tokens: 1 } }, { op: "archive", id: "ses_4" }, { op: "archive", id: "ses_4" },
    { op: "create", input: { kind: "channel", agentId: "bernd", owner: "alice", chatKey: "tg:1" } },
    { op: "archive", id: "missing" }, { op: "listened" },
    { op: "restore", id: "ses_1" }, { op: "restore", id: "missing" }, { op: "restore", id: "ses_4" },
    direct(), { op: "archive", id: "$ses" }, { op: "restore", id: "$ses" },
    sql("SELECT id, chat_key, archived_at, updated_at FROM sessions ORDER BY rowid"),
  ]));
  out.push(run("archive-fork-erase", [
    { op: "listen" }, direct({ title: "source" }),
    ...turn("ses_1", "first question", "first answer"), ...turn("ses_1", "second question", "second answer"), ...turn("ses_1", "third question", "third answer"),
    { op: "fork", id: "ses_1" }, { op: "fork", id: "ses_1", options: { title: "forked", beforeSeq: 4 } }, { op: "fork", id: "ses_1", options: { beforeSeq: 0 } }, { op: "fork", id: "missing" },
    { op: "create", input: { kind: "card", agentId: "a", owner: "o" } }, { op: "fork", id: "$ses" },
    { op: "messages", sessionId: "$ses" },
    { op: "rewind", sessionId: "ses_1", to: 4, lesson: "do better", actor: "alice", trigger: "user" },
    { op: "fork", id: "ses_1", options: { title: "after rewind" } }, { op: "messages", sessionId: "$ses" },
    { op: "continuation", input: { agentId: "bernd", owner: "alice", title: "cont", context: "quoted context" } }, { op: "continuation", input: { agentId: "bernd", owner: "alice", title: "cont", context: "c".repeat(8001) } },
    { op: "continuation", input: { agentId: "bernd", owner: "alice", title: "cont", context: "\u{1F600}".repeat(4000) } }, { op: "continuation", input: { agentId: "", owner: "alice", title: "cont", context: "x" } },
    { op: "erase", id: "ses_1", options: { actor: "admin", reason: "gdpr" } }, { op: "archive", id: "ses_1" }, { op: "erase", id: "ses_1", options: { actor: "", reason: "r" } },
    { op: "erase", id: "ses_1", options: { actor: "a", reason: "" } }, { op: "erase", id: "ses_1", options: { actor: "admin", reason: "gdpr" } }, { op: "erase", id: "ses_1", options: { actor: "admin", reason: "again" } },
    { op: "erasures" }, { op: "listened" },
    sql("SELECT count(*) AS n FROM messages WHERE session_id='ses_1'"), sql("SELECT count(*) AS n FROM events WHERE session_id='ses_1'"), sql("SELECT count(*) AS n FROM turns WHERE session_id='ses_1'"),
    sql("SELECT count(*) AS n FROM path_rewinds WHERE session_id='ses_1'"), sql("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"first\"'"),
    sql("SELECT id, session_id, agent_id, owner, kind, message_count, erased_at, actor, reason FROM erasures"),
  ]));
  return out;
}

function pageScenarios() {
  const out: unknown[] = [];
  const ops: Op[] = [];
  for (let i = 0; i < 40; i++) ops.push(direct({ agentId: "hidden", title: "match" }));
  for (let i = 0; i < 7; i++) { ops.push(direct({ title: "match" })); if (i === 2) ops.push({ op: "advance", ms: 10 }); }
  ops.push(direct({ owner: "user:v1:bob", title: "match" }));
  ops.push({ op: "update", id: "ses_44", patch: { pinned: true } }, { op: "update", id: "ses_43", patch: { title: "match more" } });
  const base = { owner: "user:v1:alice", allowedAgents: ["bernd"], search: "match", limit: 2 };
  ops.push({ op: "chatList", filter: base });
  for (let i = 0; i < 4; i++) ops.push({ op: "chatList", filter: base, afterLast: true });
  ops.push({ op: "chatList", filter: { ...base, allowedAgents: [] } }, { op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd", "hidden"], limit: 500 } });
  ops.push({ op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], limit: 0 } }, { op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], agentId: "hidden" } });
  ops.push({ op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], archived: "only" } }, { op: "archive", id: "ses_42" });
  ops.push({ op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], archived: "only" } }, { op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], archived: "any", limit: 3 } });
  ops.push({ op: "chatList", filter: { ...base, search: "   " } }, { op: "chatList", filter: { ...base, search: "mat\"ch" } });
  ops.push({ op: "list", filter: { owner: "user:v1:alice", limit: 3 } }, { op: "list", filter: { owner: "user:v1:alice", limit: 1000 } }, { op: "list", filter: { owner: "user:v1:alice", kind: "card" } });
  ops.push({ op: "list", filter: { owner: "user:v1:alice", agentId: "bernd", archived: "any", limit: 5 } }, { op: "list", filter: { owner: "user:v1:alice", search: "match", limit: 2 } });
  out.push(run("chat-pages", ops));
  // Ties: the same updated_at everywhere, so the id order alone decides (ids compare as text: ses_10 < ses_9).
  const ties: Op[] = [];
  for (let i = 0; i < 12; i++) ties.push(direct({ title: "tie" }));
  ties.push({ op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], limit: 5 } });
  for (let i = 0; i < 3; i++) ties.push({ op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], limit: 5 }, afterLast: true });
  ties.push({ op: "update", id: "ses_5", patch: { pinned: true } }, { op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], limit: 4 } }, { op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], limit: 4 }, afterLast: true });
  ties.push({ op: "list", filter: { owner: "user:v1:alice", limit: 4 } });
  out.push(run("chat-page-ties", ties));
  // list order: pinned first, then newest turn.
  const order: Op[] = [direct({ title: "a" }), { op: "advance", ms: 10 }, direct({ title: "b" }), { op: "advance", ms: 10 }, direct({ title: "c", agentId: "other" }), { op: "advance", ms: 10 }, direct({ title: "d" })];
  order.push(...turn("ses_1", "q", "a"), { op: "advance", ms: 5 }, ...turn("ses_2", "q", "a"), { op: "update", id: "ses_3", patch: { pinned: true } });
  order.push({ op: "list", filter: { owner: "user:v1:alice" } }, { op: "list", filter: { owner: "user:v1:alice", limit: 2 } }, { op: "list", filter: { owner: "user:v1:alice", agentId: "other" } });
  order.push({ op: "overview", filter: { owner: "user:v1:alice" } }, { op: "overview", filter: { owners: ["user:v1:alice"], limit: 2 } }, { op: "overview", filter: { owners: [] } }, { op: "overview", filter: {} }, { op: "overview", filter: { owner: "nobody" } });
  order.push({ op: "learningSessions", filter: { owner: "user:v1:alice", from: 0, to: 9_999_999, limit: 10 } }, { op: "learningSessions", filter: { owner: "user:v1:alice", from: 0, to: 9_999_999, limit: 100, offset: 1 } },
    { op: "learningSessions", filter: { owner: "user:v1:alice", agentId: "bernd", from: 0, to: 9_999_999, limit: 0 } }, { op: "learningSessions", filter: { owner: "user:v1:alice", projectId: "user", from: 0, to: 9_999_999, limit: 2 } });
  out.push(run("list-order-and-overview", order));
  return out;
}

function turnScenarios() {
  const out: unknown[] = [];
  out.push(run("turn-lifecycle", [
    direct(), direct({ memoryMode: "incognito" }),
    { op: "begin", sessionId: "ses_1", text: "hello", tokens: 2 }, { op: "begin", sessionId: "ses_1", text: "again", tokens: 1 }, { op: "begin", sessionId: "missing", text: "x", tokens: 1 },
    { op: "running", sessionId: "ses_1" }, { op: "lastEventSeq", sessionId: "ses_1" }, { op: "lastEventSeq", sessionId: "missing" },
    { op: "append", turnId: "trn_3", type: "delta", data: { text: "he" } }, { op: "append", turnId: "trn_3", type: "tool.call", data: { id: "c1", name: "file.read", args: { path: "a" } } },
    { op: "append", turnId: "nope", type: "delta", data: {} }, { op: "events", sessionId: "ses_1" }, { op: "events", sessionId: "ses_1", after: 1, limit: 1 }, { op: "events", sessionId: "ses_1", after: 0, limit: 0 }, { op: "events", sessionId: "ses_1", after: 0, limit: 99999 },
    { op: "complete", turnId: "trn_3", input: { text: "world", tokens: 3, data: { provider: "p", model: "m", usage: { inputTokens: 5, outputTokens: 7 }, "2": "two", "1": "one", turnId: "override" } } },
    { op: "complete", turnId: "trn_3", input: { text: "again", tokens: 1 } }, { op: "complete", turnId: "nope", input: { text: "x", tokens: 1 } }, { op: "fail", turnId: "trn_3", error: "late" },
    { op: "append", turnId: "trn_3", type: "delta", data: {} },
    { op: "begin", sessionId: "ses_2", text: "private", tokens: 2 }, { op: "fail", turnId: "trn_12", error: "boom", data: { code: "E_X", error: "overridden" } }, { op: "fail", turnId: "trn_12", error: "again" },
    { op: "begin", sessionId: "ses_1", text: "third", tokens: 1, options: { harnessCommand: true, channelOrigin: { channel: "telegram", chat: "1", z: 1, a: 2 } } },
    { op: "begin", sessionId: "ses_2", text: "fourth", tokens: 1 }, { op: "recover" }, { op: "recover" },
    { op: "getTurn", id: "trn_3" }, { op: "getTurn", id: "none" }, { op: "turns", sessionId: "ses_1" }, { op: "turns", sessionId: "ses_2" }, { op: "harnessTurns", sessionId: "ses_1" },
    { op: "messages", sessionId: "ses_1" }, { op: "contextMessages", sessionId: "ses_1" }, { op: "contextMessages", sessionId: "ses_1", options: { afterSeq: 2 } },
    { op: "archive", id: "ses_1" }, { op: "begin", sessionId: "ses_1", text: "late", tokens: 1 },
    sql("SELECT session_id, seq, turn_id, type, data, at FROM events ORDER BY session_id, seq"),
    sql("SELECT id, session_id, turn_id, seq, role, text, tokens, created_at FROM messages ORDER BY rowid"),
    sql("SELECT id, session_id, seq, state, started_at, ended_at, error, incognito FROM turns ORDER BY rowid"),
    sql("SELECT id, turn_count, last_message_seq, last_event_seq, last_turn_at, updated_at FROM sessions ORDER BY rowid"),
  ]));
  const msgs: Op[] = [direct()];
  for (let i = 0; i < 6; i++) msgs.push(...turn("ses_1", `question ${i}`, `answer ${i}`));
  msgs.push({ op: "messages", sessionId: "ses_1" }, { op: "messages", sessionId: "ses_1", query: { limit: 3 } }, { op: "messages", sessionId: "ses_1", query: { limit: 3, keep: "oldest" } },
    { op: "messages", sessionId: "ses_1", query: { beforeSeq: 7, limit: 3 } }, { op: "messages", sessionId: "ses_1", query: { beforeSeq: 1, limit: 3 } }, { op: "messages", sessionId: "ses_1", query: { afterSeq: 5, beforeSeq: 9 } },
    { op: "messages", sessionId: "ses_1", query: { afterSeq: 5, limit: 2, keep: "oldest" } }, { op: "messages", sessionId: "ses_1", query: { limit: 0 } }, { op: "messages", sessionId: "ses_1", query: { limit: 1000000 } },
    { op: "messages", sessionId: "none" }, { op: "toolResult", sessionId: "ses_1", callId: "c1" });
  out.push(run("message-paging", msgs));
  return out;
}

const WORDS = ["alpha beta", "Alpha-Beta gamma", "über Straße naïve", "日本語 テキスト", "emoji \u{1F600} party", "she said \"hi\" there", "AND OR NOT NEAR", "a*b c:d (e) ^f", "foo.bar baz_qux", "alpha", "BETA beta Beta", "x ".repeat(40) + "alpha"];

function ftsScenarios() {
  const out: unknown[] = [];
  const ops: Op[] = [direct({ title: "Alpha release notes" }), direct({ title: "über uns" }), direct({ owner: "user:v1:bob", title: "alpha bob" }), direct({ kind: "card", title: "card alpha" })];
  WORDS.forEach((w, i) => ops.push(...turn(`ses_${(i % 3) + 1}`, w, `reply ${w}`)));
  const searches = ["alpha", "Alpha", "beta", "alpha beta", "über", "uber", "Straße", "日本語", "\u{1F600}", "\"hi\"", "hi\"", "AND", "OR", "NOT", "NEAR", "a*b", "c:d", "(e)", "^f", "foo.bar", "foo", "bar", "baz_qux", "reply", "x", "nope", "alpha  beta", " alpha ", "alpha beta", "alpha\u0085beta", "﻿alpha", "ALPHA", "al", "alpha OR beta", "-alpha", "title:alpha", "\"alpha beta\"", "alpha\tbeta\n"];
  for (const q of searches) {
    ops.push({ op: "list", filter: { owner: "user:v1:alice", search: q } }, { op: "searchMessages", filter: { owner: "user:v1:alice", search: q } });
  }
  ops.push({ op: "searchMessages", filter: { owner: "user:v1:alice", search: "alpha", limit: 2 } }, { op: "searchMessages", filter: { owner: "user:v1:alice", search: "alpha", kind: "card" } }, { op: "searchMessages", filter: { owner: "user:v1:alice", search: "alpha", agentId: "other" } },
    { op: "searchMessages", filter: { owner: "user:v1:bob", search: "alpha" } }, { op: "searchMessages", filter: { owner: "user:v1:alice", search: "" } }, { op: "searchMessages", filter: { owner: "user:v1:alice", search: " \t " } },
    { op: "overview", filter: { owner: "user:v1:alice", search: "alpha" } }, { op: "chatList", filter: { owner: "user:v1:alice", allowedAgents: ["bernd"], search: "über" } },
    { op: "archive", id: "ses_1" }, { op: "searchMessages", filter: { owner: "user:v1:alice", search: "alpha" } }, { op: "searchMessages", filter: { owner: "user:v1:alice", search: "alpha", archived: "any" } }, { op: "searchMessages", filter: { owner: "user:v1:alice", search: "alpha", archived: "only" } },
    { op: "update", id: "ses_2", patch: { title: "renamed gamma" } }, { op: "list", filter: { owner: "user:v1:alice", search: "gamma" } }, { op: "list", filter: { owner: "user:v1:alice", search: "über" } });
  for (const m of ["alpha", "\"alpha\" \"beta\"", "alpha*", "NEAR(alpha beta)", "über", "uber", "straße", "strasse", "日本語"]) {
    ops.push(sql("SELECT rowid, bm25(messages_fts) AS rank, snippet(messages_fts, 0, '[', ']', '…', 12) AS snip, highlight(messages_fts, 0, '<', '>') AS hl FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank, rowid", m));
  }
  ops.push(sql("SELECT rowid, title FROM sessions_fts WHERE sessions_fts MATCH '\"alpha\"' ORDER BY rowid"), sql("SELECT name, sql FROM sqlite_master WHERE name LIKE '%fts%' ORDER BY name"));
  out.push(run("fts", ops));
  const tokens = ["", " ", "a", " a b ", "a\"b", "\"", "\"\"", "a b", "a﻿b", "a\u0085b", "a b c", "a　b", "a​b", "\t\n", "x  y   z", "à é", "\ud83d"];
  return [...out, { name: "fts-query", cases: tokens.map((t) => { try { return { text: t, ok: ftsQuery(t) }; } catch (e) { return { text: t, err: errOf(e) }; } }) }];
}

function offerScenarios() {
  const out: unknown[] = [];
  const first = Array.from({ length: 127 }, (_, i) => `fixture.tool-${i}`);
  out.push(run("tool-offers", [
    direct(), direct({ owner: "other", agentId: "other" }),
    { op: "offers", sessionId: "ses_1" }, { op: "rememberOffers", sessionId: "ses_1", names: ["file.read", "exec.run", "file.read"] }, { op: "rememberOffers", sessionId: "ses_1", names: ["web.fetch", "exec.run", "sys.startupItems"] }, { op: "offers", sessionId: "ses_1" },
    ...["", "Tool.upper", "tool with space", "tool/path", "tool\nname", "x".repeat(65), "x".repeat(64), "sys.startupitems", "1abc", "a", "a-b_c.d", "ünï"].map((name) => ({ op: "rememberOffers", sessionId: "ses_1", names: ["valid.tool", name] })),
    { op: "offers", sessionId: "ses_1" }, { op: "rememberOffers", sessionId: "ses_2", names: ["private.lookup"] }, { op: "offers", sessionId: "ses_2" }, { op: "offers", sessionId: "missing" }, { op: "rememberOffers", sessionId: "missing", names: ["a"] },
    { op: "rememberOffers", sessionId: "ses_2", names: first }, { op: "rememberOffers", sessionId: "ses_2", names: [first[0], "last.accepted", "overflow.rejected"] }, { op: "rememberOffers", sessionId: "ses_2", names: ["another.rejected"] }, { op: "offers", sessionId: "ses_2" },
    { op: "reopen" }, { op: "offers", sessionId: "ses_2" },
    sql("SELECT session_id, name, ordinal FROM session_tool_offers WHERE session_id='ses_1' ORDER BY ordinal"),
    { op: "sqlWrite", sql: "INSERT INTO session_tool_offers(session_id,name,ordinal) VALUES ('ses_1','Bad',50)" }, { op: "sqlWrite", sql: "INSERT INTO session_tool_offers(session_id,name,ordinal) VALUES ('ses_1','ok.name',128)" },
    { op: "sqlWrite", sql: "INSERT INTO session_tool_offers(session_id,name,ordinal) VALUES ('ses_1','ok.name',2)" },
    { op: "archive", id: "ses_1" }, { op: "erase", id: "ses_1", options: { actor: "a", reason: "r" } }, sql("SELECT count(*) AS n FROM session_tool_offers WHERE session_id='ses_1'"),
  ]));
  return out;
}

function overlayScenarios() {
  const out: unknown[] = [];
  const base = (): Op[] => [direct(), ...turn("ses_1", "q1", "a1"), ...turn("ses_1", "q2", "a2"), ...turn("ses_1", "q3", "a3")];
  out.push(run("rewind", [
    ...base(),
    { op: "planRewind", sessionId: "ses_1", to: 2 }, { op: "planRewind", sessionId: "ses_1", to: "last" }, { op: "planRewind", sessionId: "ses_1", to: 0 }, { op: "planRewind", sessionId: "ses_1", to: 99 }, { op: "planRewind", sessionId: "ses_1", to: -1 }, { op: "planRewind", sessionId: "missing", to: 1 },
    { op: "rewind", sessionId: "ses_1", to: 2, lesson: "lesson one", actor: "alice", trigger: "user", audit: "record" },
    { op: "contextMessages", sessionId: "ses_1" }, { op: "rewinds", sessionId: "ses_1" }, { op: "summaryRewinds", sessionId: "ses_1" },
    { op: "rewind", sessionId: "ses_1", to: 2, lesson: "x", actor: "alice", trigger: "agent", expectedEventSeq: 1 }, { op: "rewind", sessionId: "ses_1", to: "last", lesson: "newer lesson", actor: "bot", trigger: "agent", audit: "fail" },
    { op: "rewind", sessionId: "ses_1", to: "last", lesson: "", actor: "bot", trigger: "agent" }, { op: "rewind", sessionId: "ses_1", to: "last", lesson: "   ", actor: "bot", trigger: "agent" }, { op: "rewind", sessionId: "ses_1", to: "last", lesson: "l".repeat(1601), actor: "bot", trigger: "agent" },
    { op: "rewind", sessionId: "ses_1", to: "last", lesson: "l".repeat(1600), actor: "", trigger: "agent" },
    { op: "rewind", sessionId: "ses_1", to: 1, lesson: "\u{1F600} lesson", actor: "alice", trigger: "user" }, { op: "rewinds", sessionId: "ses_1" },
    { op: "contextMessages", sessionId: "ses_1" }, { op: "undoRewind", sessionId: "ses_1", rewindId: "rew_20", actor: "alice", audit: "record" }, { op: "undoRewind", sessionId: "ses_1", rewindId: "rew_20", actor: "alice" },
    { op: "undoRewind", sessionId: "ses_1", rewindId: "nope", actor: "alice" }, { op: "undoRewind", sessionId: "ses_1", rewindId: "rew_20", actor: "" }, { op: "contextMessages", sessionId: "ses_1" }, { op: "summaryRewinds", sessionId: "ses_1" }, { op: "rewinds", sessionId: "ses_1" },
    { op: "searchMessages", filter: { owner: "user:v1:alice", search: "q1" } }, { op: "searchMessages", filter: { owner: "user:v1:alice", search: "lesson" } },
    { op: "reserve", name: "r1", sessionId: "ses_1" }, { op: "reserved", sessionId: "ses_1" }, { op: "reserve", name: "r2", sessionId: "ses_1" }, { op: "begin", sessionId: "ses_1", text: "blocked", tokens: 1 },
    { op: "planRewind", sessionId: "ses_1", to: 1 }, { op: "planRewind", sessionId: "ses_1", to: 1, reservation: "r1" }, { op: "release", name: "r2" }, { op: "reserved", sessionId: "ses_1" }, { op: "release", name: "r1" }, { op: "reserved", sessionId: "ses_1" },
    ...turn("ses_1", "q4"), { op: "planRewind", sessionId: "ses_1", to: 1 }, { op: "reserve", name: "r3", sessionId: "ses_1" }, { op: "planRewind", sessionId: "ses_1", to: 1, commandTurnId: "trn_30" },
    { op: "archive", id: "ses_1" }, { op: "planRewind", sessionId: "ses_1", to: 1 },
    sql("SELECT id, session_id, parent_seq, hidden_from_seq, hidden_to_seq, lesson_message_id, hidden_digest, trigger, actor, created_at, undone_at FROM path_rewinds ORDER BY rowid"),
    sql("SELECT session_id, seq, turn_id, type, data FROM events WHERE type LIKE 'session.rewind%' ORDER BY seq"),
  ]));
  const cycles = (n: number): Op[] => {
    const ops: Op[] = [];
    for (let i = 0; i < n; i++) {
      ops.push({ op: "begin", sessionId: "ses_1", text: `edit ${i}`, tokens: 1 });
    }
    return ops;
  };
  void cycles;
  return out;
}

function rewindProposalScenario() {
  // A failed-check streak built from tool events: edit ok, check fails, three times.
  const ops: Op[] = [direct()];
  let turnN = 0;
  let nextId = 2; // ses_1 took 1; every begin takes a turn id and a message id
  const tool = (turnId: string, id: string, name: string, args: Op, result: Op) => [
    { op: "append", turnId, type: "tool.call", data: { id, name, args } },
    { op: "append", turnId, type: "tool.result", data: { id, output: JSON.stringify({ value: result, isError: result.isError ?? false }), ...(result.isError ? { isError: true } : {}) } },
  ];
  for (let i = 0; i < 4; i++) {
    const turnId = `trn_${nextId}`; nextId += 2; turnN++;
    ops.push({ op: "begin", sessionId: "ses_1", text: `step ${i}`, tokens: 1 });
    ops.push(...tool(turnId, `e${i}`, "file.edit", { path: "a.ts" }, { ok: true, isError: false }));
    ops.push(...tool(turnId, `c${i}`, "exec.run", { argv: ["pnpm", "test"] }, { exitCode: 1, isError: false }));
    ops.push({ op: "complete", turnId, input: { text: `done ${i}`, tokens: 1 } }); nextId += 1;
    ops.push({ op: "rewindProposal", sessionId: "ses_1" });
  }
  ops.push({ op: "proposeRewind", sessionId: "ses_1", proposal: { parentSeq: 2, failedCycles: 3, lastCheckSeq: 3, agentId: "bernd" } });
  ops.push({ op: "contextToolEvents", sessionId: "ses_1" }, { op: "toolEvents", sessionId: "ses_1" });
  ops.push({ op: "rewindProposal", sessionId: "ses_1" }, { op: "proposeRewind", sessionId: "ses_1", proposal: { parentSeq: 2, failedCycles: 3, lastCheckSeq: 3, agentId: "bernd" } });
  ops.push(sql("SELECT type, data FROM events WHERE type='session.rewind.proposed'"));
  void turnN;
  return run("rewind-proposal", ops);
}

function miscScenarios() {
  const out: unknown[] = [];
  out.push(run("calibration-and-usage", [
    direct(), ...turn("ses_1", "hello world", "reply"),
    { op: "tokenCalibration", model: "m" }, { op: "tokenFactor", model: "m" }, { op: "meterCount", model: "m", text: "abcd" }, { op: "meterCount", model: "m", text: "abcde" }, { op: "meterCount", model: "m", text: "" }, { op: "meterCount", model: "m", text: "\u{1F600}\u{1F600}" },
    { op: "meterCount", model: "m", text: "abcd", measured: 7 }, { op: "meterCount", model: "m", text: "abcd", measured: 0 }, { op: "meterCount", model: "m", text: "abcd", measured: -1 }, { op: "meterCount", model: "m", text: "abcd", measured: 1.5 }, { op: "meterCount", model: "m", text: "abcd", measured: 9007199254740992 },
    { op: "meterObserve", model: "m", estimated: 100, measured: 150 }, { op: "meterObserve", model: "m", estimated: 100, measured: 90 }, { op: "meterObserve", model: "m", estimated: 100, measured: 1 }, { op: "meterObserve", model: "m", estimated: 1, measured: 1000 },
    { op: "meterObserve", model: "", estimated: 1, measured: 2 }, { op: "meterObserve", model: "n", estimated: 0, measured: 2 }, { op: "meterObserve", model: "n", estimated: -3, measured: 2 }, { op: "meterObserve", model: "n", estimated: 3, measured: 0 }, { op: "meterObserve", model: "n", estimated: 3, measured: 2.5 },
    { op: "meterObserve", model: "n", estimated: 3, measured: 7 }, { op: "meterObserve", model: "n", estimated: 7, measured: 3 }, { op: "meterObserve", model: "n", estimated: 3, measured: 3 },
    { op: "meterCount", model: "m", text: "a".repeat(1001) }, { op: "meterCount", model: "n", text: "a".repeat(333) }, { op: "meterCount", model: "n", text: "a".repeat(3) },
    { op: "setTokenFactor", model: "x", factor: 0.1 }, { op: "setTokenFactor", model: "x", factor: 3 }, { op: "tokenCalibration", model: "x" }, { op: "meterCount", model: "x", text: "a".repeat(4 * 10) },
    { op: "recordUsage", id: "msg_3", model: "m", tokens: 11 }, { op: "recordUsage", id: "msg_3", model: "m", tokens: 12 }, { op: "recordUsage", id: "nope", model: "m", tokens: 1 }, { op: "messageUsage", id: "msg_3", model: "m", text: "hello world" }, { op: "messageUsage", id: "msg_3", model: "m", text: "other" }, { op: "messageUsage", id: "msg_3", model: "z", text: "hello world" },
    sql("SELECT model, factor, typeof(factor) AS t FROM token_calibration ORDER BY model"), sql("SELECT message_id, model, tokens FROM message_usage"),
    { op: "catalogWindow", models: [{ provider: "p", id: "m", contextWindow: 1000 }], model: { provider: "p", model: "m" } },
    ...[0, -5, 1.5, 9007199254740992, 9007199254740991].map((w) => ({ op: "catalogWindow", models: [{ provider: "p", id: "m", contextWindow: w }], model: { provider: "p", model: "m" } })),
    { op: "catalogWindow", models: [{ provider: "p", id: "m" }], model: { provider: "p", model: "m" } }, { op: "catalogWindow", models: [{ provider: "p", id: "x", contextWindow: 5 }], model: { provider: "p", model: "m" } },
    { op: "catalogWindow", models: [{ provider: "p", id: "m", contextWindow: 7 }, { provider: "p", id: "m", contextWindow: 9 }], model: { provider: "p", model: "m" } },
  ]));
  out.push(run("visibility-and-summaries", [
    direct(), ...turn("ses_1", "q", "a"), { op: "visibility", sessionId: "ses_1" },
    { op: "setVisibility", sessionId: "ses_1", ref: "r1", hidden: true, reason: "old" }, { op: "setVisibility", sessionId: "ses_1", ref: "r2", hidden: false, reason: "keep", detail: { mode: "truncate", confidence: 0.75, tokensSaved: 40 } },
    { op: "setVisibility", sessionId: "ses_1", ref: "r1", hidden: true, reason: "again", detail: { mode: "drop", confidence: 0.5, tokensSaved: 10 } }, { op: "setVisibility", sessionId: "nope", ref: "r1", hidden: true, reason: "x" },
    { op: "visibility", sessionId: "ses_1" }, { op: "pruneExplanation", sessionId: "ses_1" }, { op: "refetch", sessionId: "ses_1", ref: "r1" }, { op: "refetch", sessionId: "ses_1", ref: "r1" }, { op: "refetch", sessionId: "ses_1", ref: "none" }, { op: "pruneMetrics", sessionId: "ses_1" }, { op: "pruneMetrics", sessionId: "empty" },
    { op: "setVisibilities", sessionId: "ses_1", changes: [{ ref: "r3", hidden: true, reason: "p", turnId: "trn_2", detail: { mode: "truncate", confidence: 0.9, tokensSaved: 5 } }, { ref: "r4", hidden: false, reason: "plain" }] },
    { op: "setVisibilities", sessionId: "ses_1", changes: [{ ref: "r5", hidden: true, reason: "p", turnId: "trn_2", detail: { mode: "drop", confidence: 1, tokensSaved: 1 } }, { ref: "r6", hidden: true, reason: "bad", turnId: "nope", detail: { mode: "drop", confidence: 1, tokensSaved: 1 } }] },
    { op: "visibility", sessionId: "ses_1" }, { op: "events", sessionId: "ses_1", after: 3 }, { op: "pruneExplanation", sessionId: "ses_1" },
    { op: "addSummary", summary: { sessionId: "ses_1", fromSeq: 1, toSeq: 2, text: "sum one", tokens: 3, tier: 1, state: "prepared" } }, { op: "addSummary", summary: { sessionId: "ses_1", fromSeq: 1, toSeq: 2, text: "sum two", tokens: 3, tier: 2, state: "applied" } },
    { op: "addSummary", summary: { sessionId: "ses_1", fromSeq: 0, toSeq: 1, text: "sum three", tokens: 1, tier: 1, state: "applied" } }, { op: "addSummary", summary: { sessionId: "nope", fromSeq: 1, toSeq: 2, text: "x", tokens: 1, tier: 1, state: "applied" } },
    { op: "summaries", sessionId: "ses_1" }, { op: "summaries", sessionId: "ses_1", state: "applied" }, { op: "setSummaryState", id: "sum_20", state: "superseded" }, { op: "setSummaryState", id: "none", state: "applied" },
    { op: "replaceSummaries", supersede: ["sum_21", "sum_22"], next: { sessionId: "ses_1", fromSeq: 0, toSeq: 2, text: "merged", tokens: 2, tier: 3, state: "applied" } }, { op: "summaries", sessionId: "ses_1" },
    { op: "replaceSummaries", supersede: [], next: { sessionId: "nope", fromSeq: 0, toSeq: 2, text: "bad", tokens: 2, tier: 3, state: "applied" } }, { op: "summaries", sessionId: "ses_1", state: "prepared" },
    sql("SELECT ref, hidden, reason, mode, typeof(confidence) AS ct, confidence, tokens_saved, refetches FROM tool_visibility ORDER BY ref"),
  ]));
  out.push(run("snapshots-profiles-worktrees-checkpoints", [
    direct(), direct({ memoryMode: "incognito" }), direct({ kind: "card" }),
    { op: "freezeMemory", sessionId: "ses_1", text: "first memory" }, { op: "freezeMemory", sessionId: "ses_1", text: "second memory" }, { op: "freezeMemory", sessionId: "ses_2", text: "private" }, { op: "freezeMemory", sessionId: "ses_2", text: "private two" }, { op: "freezeMemory", sessionId: "none", text: "x" },
    { op: "freezeCatalogue", sessionId: "ses_1", text: "cat A" }, { op: "freezeCatalogue", sessionId: "ses_1", text: "cat B" }, { op: "freezeCatalogue", sessionId: "ses_2", text: "cat C" }, sql("SELECT session_id, memory FROM prompt_snapshots"), sql("SELECT session_id, catalogue FROM skill_catalogue_snapshots"),
    { op: "modelProfile", sessionId: "ses_1" }, { op: "modelReasoning", sessionId: "ses_1" }, { op: "setModelProfile", sessionId: "ses_1", profile: "fast", revision: 1 }, { op: "setModelProfile", sessionId: "ses_1", profile: "fast", revision: 0 },
    { op: "modelProfile", sessionId: "ses_1" }, { op: "setModelProfile", sessionId: "ses_1", profile: "deep", revision: 1, reasoning: "high", person: "alice", details: { model: "m-deep", displayName: "Deep", effectiveReasoning: "high" } },
    { op: "setModelProfile", sessionId: "ses_1", profile: "deep2", revision: 2 }, { op: "modelReasoning", sessionId: "ses_1" }, { op: "setModelProfile", sessionId: "ses_1", profile: "deep3", revision: 3, reasoning: null }, { op: "modelReasoning", sessionId: "ses_1" },
    { op: "setModelProfile", sessionId: "ses_1", profile: "p4", revision: 4, details: { model: "m4", displayName: "", effectiveReasoning: "" } }, { op: "setModelProfile", sessionId: "ses_3", profile: "x", revision: 0 }, { op: "setModelProfile", sessionId: "none", profile: "x", revision: 0 },
    { op: "modelChanges", sessionId: "ses_1" }, { op: "modelProfile", sessionId: "ses_1" },
    { op: "begin", sessionId: "ses_1", text: "busy", tokens: 1 }, { op: "setModelProfile", sessionId: "ses_1", profile: "x", revision: 5 }, { op: "bindWorktree", binding: { sessionId: "ses_1", root: "/w", projectId: "p", cardId: "c", createdBy: "alice" } },
    { op: "complete", turnId: "$turn", input: { text: "ok", tokens: 1 } },
    { op: "worktree", sessionId: "ses_1" }, { op: "bindWorktree", binding: { sessionId: "ses_1", root: "/w", projectId: "p", cardId: "c", createdBy: "alice" } }, { op: "worktree", sessionId: "ses_1" },
    { op: "bindWorktree", binding: { sessionId: "ses_1", root: "/w", projectId: "p", cardId: "c", createdBy: "alice" } }, { op: "bindWorktree", binding: { sessionId: "ses_1", root: "/other", projectId: "p", cardId: "c", createdBy: "alice" } },
    { op: "bindWorktree", binding: { sessionId: "ses_1", root: "/w", projectId: null, cardId: null, createdBy: "alice" } }, { op: "bindWorktree", binding: { sessionId: "ses_2", root: "/w2", projectId: null, cardId: null, createdBy: "bob" } }, { op: "worktree", sessionId: "ses_2" },
    { op: "bindWorktree", binding: { sessionId: "none", root: "/w", projectId: null, cardId: null, createdBy: "bob" } }, { op: "sqlWrite", sql: "UPDATE session_worktrees SET root='/z'" },
    { op: "bindWorktree", binding: { sessionId: "ses_3", root: "/w3", projectId: "p", cardId: null, createdBy: "bob" } },
    { op: "begin", sessionId: "ses_3", text: "cp turn", tokens: 1 },
    { op: "recordCheckpoint", checkpoint: { sessionId: "ses_3", turnId: "$turn", projectId: "p", cardId: "c", root: "/w3", commonGitDir: "/w3/.git", ref: "refs/x", tree: "t1", commitId: "c1" } },
    { op: "recordCheckpoint", checkpoint: { sessionId: "ses_3", turnId: "$turn", projectId: "p", cardId: "c", root: "/w3", commonGitDir: "/w3/.git", ref: "refs/x", tree: "t1", commitId: "c2" } },
    { op: "recordCheckpoint", checkpoint: { sessionId: "ses_1", turnId: "$turn", projectId: "p", cardId: "c", root: "/w3", commonGitDir: "/g", ref: "r", tree: "t", commitId: "c" } }, { op: "recordCheckpoint", checkpoint: { sessionId: "ses_3", turnId: "none", projectId: "p", cardId: "c", root: "/w3", commonGitDir: "/g", ref: "r", tree: "t", commitId: "c" } },
    { op: "hasCheckpoints" }, { op: "checkpoint", sessionId: "ses_3", turnId: "$turn" }, { op: "checkpoint", sessionId: "ses_3", turnId: "none" }, { op: "checkpoints" }, { op: "checkpoints", sessionId: "ses_3" }, { op: "checkpoints", sessionId: "ses_1" },
    { op: "sqlWrite", sql: "UPDATE session_checkpoints SET tree='x'" }, { op: "latestTurnSeq", sessionId: "ses_3" }, { op: "latestTurnSeq", sessionId: "none" },
    { op: "forgetCheckpoint", checkpoint: { sessionId: "ses_3", turnId: "$turn", projectId: "p", cardId: "c", root: "/w3", commonGitDir: "/g", ref: "r", tree: "t", commitId: "other" } }, { op: "hasCheckpoints" },
    { op: "forgetCheckpoint", checkpoint: { sessionId: "ses_3", turnId: "$turn", projectId: "p", cardId: "c", root: "/w3", commonGitDir: "/g", ref: "r", tree: "t", commitId: "c1" } }, { op: "hasCheckpoints" },
    { op: "archive", id: "ses_3" }, { op: "erase", id: "ses_3", options: { actor: "a", reason: "r" } }, { op: "worktree", sessionId: "ses_3" },
  ]));
  return out;
}

function skillScenario() {
  const ops: Op[] = [direct()];
  let id = 2;
  const turnOf = (n: number) => { const t = `trn_${id}`; id += 2; ops.push({ op: "begin", sessionId: "ses_1", text: `turn ${n}`, tokens: 1 }); return t; };
  const call = (t: string, cid: string, name: string, args: Op) => ops.push({ op: "append", turnId: t, type: "tool.call", data: { id: cid, name, args } });
  const res = (t: string, cid: string, value: Op, extra: Op = {}) => ops.push({ op: "append", turnId: t, type: "tool.result", data: { id: cid, output: JSON.stringify({ isError: false, tool: "skill.load", value, ...extra }) } });
  const skill = (n: string, text = `text of ${n}`) => ({ name: n, text, files: ["a", "b"] });
  const finish = (t: string) => { ops.push({ op: "complete", turnId: t, input: { text: "done", tokens: 1 } }); id += 1; };
  let t = turnOf(1);
  call(t, "k1", "skill.load", { name: "alpha" }); res(t, "k1", skill("alpha"));
  call(t, "k2", "skill.load", { name: "beta" }); res(t, "k2", skill("beta"));
  ops.push({ op: "append", turnId: t, type: "skills.selected", data: { names: ["alpha", "beta"] } });
  finish(t);
  t = turnOf(2);
  call(t, "k3", "skill.load", { name: "alpha" }); res(t, "k3", skill("alpha", "newer alpha"));
  call(t, "k4", "skill.load", { name: "gamma" }); res(t, "k4", skill("gamma"), { truncated: true });
  call(t, "k5", "skill.load", { name: "delta" }); res(t, "k5", skill("delta"), { isError: true });
  call(t, "k6", "skill.load", { name: "eps" }); res(t, "k6", { name: "other", text: "x", files: [] });
  call(t, "k7", "skill.load", { name: "zeta" }); res(t, "k7", { name: "zeta", text: "x", files: [1] });
  call(t, "k8", "skill.load", { name: "eta" }); res(t, "k8", { name: "eta", text: "x", files: ["x".repeat(16385)] });
  call(t, "k9", "skill.load", { name: "theta" }); res(t, "k9", { name: "theta", text: "x", files: ["x".repeat(16384)] });
  call(t, "k10", "skill.load", { name: 5 }); res(t, "k10", skill("iota"));
  ops.push({ op: "append", turnId: t, type: "tool.result", data: { id: "k11", output: "not json" } }, { op: "append", turnId: t, type: "tool.result", data: { id: "k1", output: JSON.stringify({ isError: false, value: skill("alpha", "orphan") }), isError: true } });
  finish(t);
  t = turnOf(3);
  call(t, "k12", "skill.load", { name: "kappa" }); res(t, "k12", skill("kappa"));
  ops.push({ op: "fail", turnId: t, error: "boom" }); id += 0;
  ops.push({ op: "skillEvents", sessionId: "ses_1" }, { op: "toolEvents", sessionId: "ses_1" }, { op: "contextToolEvents", sessionId: "ses_1" });
  ops.push({ op: "toolResult", sessionId: "ses_1", callId: "k3" }, { op: "toolResult", sessionId: "ses_1", callId: "k1" }, { op: "toolResult", sessionId: "ses_1", callId: "none" });
  ops.push({ op: "rewind", sessionId: "ses_1", to: 2, lesson: "back to turn one", actor: "a", trigger: "user" }, { op: "skillEvents", sessionId: "ses_1" }, { op: "contextToolEvents", sessionId: "ses_1" });
  ops.push({ op: "undoRewind", sessionId: "ses_1", rewindId: "rew_53", actor: "a" }, { op: "skillEvents", sessionId: "ses_1" });
  return run("skill-events", ops);
}

function learningScenario() {
  const ops: Op[] = [direct(), direct({ memoryMode: "incognito" }), direct({ owner: "user:v1:bob" })];
  let id = 4;
  const turnOf = (sid: string, text: string, ms = 100): string => { const t = `trn_${id}`; id += 2; ops.push({ op: "advance", ms }, { op: "begin", sessionId: sid, text, tokens: 1 }); return t; };
  let t = turnOf("ses_1", "first");
  ops.push({ op: "append", turnId: t, type: "tool.result", data: { id: "c1", output: "x", learnTool: { version: 1, tool: "exec.run", code: "E_X" } } }, { op: "append", turnId: t, type: "tool.result", data: { id: "c2", output: "y", learnTool: { version: 2 } } }, { op: "append", turnId: t, type: "delta", data: { text: "d" } });
  ops.push({ op: "complete", turnId: t, input: { text: "r1", tokens: 1 } }); id += 1;
  t = turnOf("ses_1", "second");
  ops.push({ op: "append", turnId: t, type: "tool.result", data: { id: "c3", output: "z", learnTool: { version: 1, tool: "file.read" } } }, { op: "fail", turnId: t, error: "boom" }); id += 0;
  t = turnOf("ses_2", "incognito");
  ops.push({ op: "append", turnId: t, type: "tool.result", data: { id: "c4", output: "z", learnTool: { version: 1, tool: "x" } } }, { op: "complete", turnId: t, input: { text: "r", tokens: 1 } }); id += 1;
  t = turnOf("ses_3", "bob");
  ops.push({ op: "append", turnId: t, type: "tool.result", data: { id: "c5", output: "z", learnTool: { version: 1, tool: "x" } } }, { op: "complete", turnId: t, input: { text: "r", tokens: 1 } }); id += 1;
  const w = { from: 0, to: 99_999_999 };
  ops.push({ op: "learningSessions", filter: { owner: "user:v1:alice", ...w, limit: 10 } }, { op: "learningSessions", filter: { owner: "user:v1:bob", ...w, limit: 10 } }, { op: "learningSessions", filter: { owner: "user:v1:alice", from: 0, to: 1, limit: 10 } },
    { op: "learningToolErrors", owner: "user:v1:alice", window: w }, { op: "learningToolErrors", owner: "user:v1:alice", window: w, limit: 1 }, { op: "learningToolErrors", owner: "user:v1:alice", window: w, limit: 99999 }, { op: "learningToolErrors", owner: "user:v1:alice", window: { from: 0, to: 1 } },
    { op: "learningTranscript", sessionId: "ses_1", window: w, caps: { messages: 10, events: 10 } }, { op: "learningTranscript", sessionId: "ses_1", window: w, caps: { messages: 1, events: 2 } }, { op: "learningTranscript", sessionId: "ses_1", window: w, caps: { messages: 10, events: 10 }, turnIds: ["trn_4"] },
    { op: "learningTranscript", sessionId: "ses_1", window: w, caps: { messages: 10, events: 10 }, turnIds: [] }, { op: "learningTranscript", sessionId: "ses_1", window: w, caps: { messages: 10, events: 10 }, turnIds: Array.from({ length: 101 }, (_, i) => `t${i}`) },
    { op: "learningTranscript", sessionId: "ses_2", window: w, caps: { messages: 10, events: 10 } }, { op: "toolResult", sessionId: "ses_1", callId: "c1" });
  return run("learning", ops);
}

// ---- pure helpers ----------------------------------------------------------------------------------------------------

function pureCases() {
  const m = (seq: number, id: string, text = `t${seq}`) => ({ id, seq, text });
  const msgs = [1, 2, 3, 4, 5, 6].map((n) => m(n, `m${n}`));
  const rw = (from: number, to: number, undoneAt: number | null, lesson?: string | null) => ({ hiddenFromSeq: from, hiddenToSeq: to, undoneAt, ...(lesson !== undefined ? { lessonMessageId: lesson } : {}) });
  const paths = [[], [rw(3, 4, null)], [rw(3, 4, 5)], [rw(3, 4, 5, "m6")], [rw(3, 4, null, "m6")], [rw(2, 2, null), rw(4, 5, null)], [rw(1, 6, null)], [rw(2, 3, 9, "m1"), rw(5, 9, null)], [rw(4, 3, null)]];
  const sums = [{ fromSeq: 1, toSeq: 2 }, { fromSeq: 2, toSeq: 4 }, { fromSeq: 5, toSeq: 6 }, { fromSeq: 3, toSeq: 3 }];
  const digests = [[], [{ id: "a", text: "x" }], [{ id: "a", text: "x" }, { id: "b", text: "y\n\"z\"" }], [{ id: "ä", text: "\u{1F600}   \u0000 \u001f" }], [{ id: "a", text: "" }], [{ id: "a", text: "\u007f\u0080 ﻿" }]];
  const ev = (seq: number, turnId: string | null, type: string, data: Op) => ({ sessionId: "s", turnId, seq, type, data, at: 1 });
  const call = (seq: number, t: string, id: any, name: string, args: Op = {}) => ev(seq, t, "tool.call", { id, name, args });
  const result = (seq: number, t: string, id: any, output: unknown, extra: Op = {}) => ev(seq, t, "tool.result", { id, output, ...extra });
  const env = (value: Op, isError = false) => JSON.stringify({ value, isError });
  const seqs: any[][] = [
    [],
    [call(1, "t1", "a", "file.edit"), result(2, "t1", "a", env({ ok: true }), { isError: false }), call(3, "t1", "b", "exec.run", { argv: ["pnpm", "test"] }), result(4, "t1", "b", env({ exitCode: 1 }))],
    [call(1, "t1", "a", "file.write"), result(2, "t1", "a", env({}), { isError: false }), call(3, "t1", "b", "code.check"), result(4, "t1", "b", env({ ok: false })), call(5, "t2", "c", "file.edit"), result(6, "t2", "c", env({}), { isError: false }), call(7, "t2", "d", "coding_complete"), result(8, "t2", "d", env({ exitCode: 2 })), call(9, "t3", "e", "file.edit"), result(10, "t3", "e", env({}), { isError: false }), call(11, "t3", "f", "exec.run", { argv: ["vitest"] }), result(12, "t3", "f", env({ ok: false }))],
    [call(1, "t1", "a", "file.edit"), result(2, "t1", "a", env({}), { isError: false }), call(3, "t1", "b", "code.check"), result(4, "t1", "b", env({ ok: true })), call(5, "t1", "c", "code.check"), result(6, "t1", "c", env({ ok: false }))],
    [call(1, "t1", "a", "file.edit"), result(2, "t1", "a", env({ ok: true }, true), { isError: true }), call(3, "t1", "b", "code.check"), result(4, "t1", "b", "not json")],
    [call(1, "t1", "a", "file.edit"), result(2, "t1", "a", JSON.stringify({ ok: true, isError: false })), call(3, "t1", "b", "exec.run", { argv: ["--test=x"] }), result(4, "t1", "b", JSON.stringify({ exitCode: 3 }))],
    [call(1, "t1", 7, "file.edit"), result(2, "t1", 7, { value: { isError: false } }, { isError: false }), call(3, "t1", [1, 2], "exec.run", { argv: ["go-test"] }), result(4, "t1", [1, 2], JSON.stringify({ value: null, exitCode: 1 })), call(5, null, null, "exec.run", { argv: ["test:unit"] }), result(6, null, null, JSON.stringify({ ok: false }))],
    ...["--test", "--test=a b", "--test=a\nb", "test", "test:", "test:a b", "test:ab", "pytest", "jest", "mocha", "ctest", "go-test", "TEST", "testx", "--tests", " test"].map((arg) => [call(1, "t1", "a", "file.write"), result(2, "t1", "a", env({}), { isError: false }), call(3, "t1", "b", "exec.run", { argv: [arg] }), result(4, "t1", "b", env({ ok: false }))]),
    [call(1, "t1", "a", "file.edit"), result(2, "t1", "a", env({}), { isError: false }), call(3, "t1", "b", "exec.run", { argv: "pnpm test" }), result(4, "t1", "b", env({ ok: false })), call(5, "t1", "c", "exec.run", { argv: [5, null, "jest"] }), result(6, "t1", "c", env({ ok: false })), call(7, "t1", "d", "exec.run", "x"), result(8, "t1", "d", env({ ok: false }))],
  ];
  const windows = [[{ provider: "p", id: "m", contextWindow: 100 }]];
  void windows;
  return {
    activePath: paths.map((r) => ({ messages: msgs, rewinds: r, result: activePath(msgs, r as any) })),
    activeSummaries: paths.map((r) => ({ summaries: sums, rewinds: r, result: activeSummaries(sums, r as any) })),
    hiddenDigest: digests.map((d) => ({ messages: d, digest: hiddenDigest(d) })),
    failedEditCycles: seqs.map((events) => ({ events, result: failedEditCycles(events as any) })),
  };
}

function schemaCases() {
  const rows = (db: DatabaseSync) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => ({ ...r }));
  const fresh = (version: number) => { const db = new DatabaseSync(":memory:"); migrate(db, MIGRATIONS.slice(0, version)); const out = rows(db); db.close(); return out; };
  const migratedFrom = (version: number) => { const db = new DatabaseSync(":memory:"); migrate(db, MIGRATIONS.slice(0, version)); migrate(db); const out = rows(db); const v = (db.prepare("PRAGMA user_version").get() as any).user_version; db.close(); return { out, v }; };
  const full = fresh(SCHEMA_VERSION);
  const migrated: Record<string, unknown> = {};
  for (let v = 1; v <= SCHEMA_VERSION; v++) { const m = migratedFrom(v); if (JSON.stringify(m.out) !== JSON.stringify(full) || m.v !== SCHEMA_VERSION) throw new Error(`migrating from v${v} differs from a fresh file`); migrated[String(v)] = m.v; }
  const prefixes: Record<string, unknown> = {};
  for (let v = 1; v <= SCHEMA_VERSION; v++) prefixes[String(v)] = fresh(v);
  // A file one version newer than this core is refused.
  const newer = new DatabaseSync(":memory:"); newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  let refusal: unknown; try { migrate(newer); } catch (e) { refusal = errOf(e); }
  return { version: SCHEMA_VERSION, migrations: [...MIGRATIONS], schema: full, prefixes, migratedUserVersions: migrated, newerRefusal: refusal };
}

/** JSON cannot hold a lone surrogate: such a string becomes `{ "$u16": [units] }`, which the replay revives. */
function encodeLone(v: unknown): unknown {
  if (typeof v === "string") return v.isWellFormed() ? v : { $u16: Array.from({ length: v.length }, (_, i) => v.charCodeAt(i)) };
  if (Array.isArray(v)) return v.map(encodeLone);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeLone(x)]));
  return v;
}

export async function buildSessionVectors() {
  return encodeLone(await build()) as any;
}

async function build() {
  return {
    schema: schemaCases(),
    pure: pureCases(),
    sessions: [...sessionScenarios(), ...pageScenarios()],
    turns: [...turnScenarios(), skillScenario(), learningScenario()],
    fts: [...ftsScenarios(), ...offerScenarios()],
    overlays: [...overlayScenarios(), rewindProposalScenario(), ...miscScenarios()],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "sessions", build: buildSessionVectors });
}
