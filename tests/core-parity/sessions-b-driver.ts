// Session store round trip, parity mode B (P4-K K5a, plan P4-40): the TypeScript side that
// `crates/plur1bus-core/tests/sessions_mode_b.rs` drives.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/sessions-b-driver.ts prepare <dir>
//   node ... tests/core-parity/sessions-b-driver.ts continue <dir>
//   node ... tests/core-parity/sessions-b-driver.ts verify <dir>
//
// `prepare` writes real TypeScript files into <dir>:
//   sessions-v<N>.sqlite     the store at schema version N (1..SCHEMA_VERSION, through the store's own `migrate`) with one session,
//                            one completed turn and two messages written as raw rows (the columns every version has)
//   sessions-ts.sqlite       the latest version written by the product code (sessions, turns, events, offers, summaries, usage)
//   sessions-ref.sqlite      the latest version with no data: the reference for the schema text and the PRAGMAs of a file
//   manifest.json            what the Rust test must find
// The Rust test migrates and writes copies (`sessions-v<N>-rust.sqlite`, `sessions-ts-rust.sqlite`) and creates
// `sessions-fresh-rust.sqlite`. `continue` lets the product code write further into a copy of the fresh Rust file
// (`sessions-fresh-continued.sqlite`) which Rust then reads again. `verify` prints one JSON object.
// Test tooling only; no product code imports it.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreCopy, createStoreAtVersion } from "./store-roundtrip.ts";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../../packages/core/src/session/migrations.ts";
import { SessionStore } from "../../packages/core/src/session/store.ts";

const NOW = Date.UTC(2026, 9, 6, 12);
const ALICE = "user:v1:alice";

function open(path: string, now = NOW, start = 0) {
  let n = start;
  return new SessionStore({ path, clock: () => now, newId: (p) => `${p}_${++n}` });
}

/** What the Rust side must read from every version file. */
function rawContent(path: string, v: number): void {
  const db = new DatabaseSync(path);
  const id = `ses_b${v}`;
  db.prepare("INSERT INTO sessions (id, kind, agent_id, owner, scope, title, created_at, updated_at, last_turn_at, turn_count, last_message_seq, last_event_seq) VALUES (?, 'direct', 'bernd', ?, 'user', ?, ?, ?, ?, 1, 2, 0)").run(id, ALICE, `title v${v}`, NOW, NOW, NOW);
  db.prepare("INSERT INTO turns (id, session_id, seq, state, started_at, ended_at, error, incognito) VALUES (?, ?, 1, 'completed', ?, ?, NULL, 0)").run(`trn_b${v}`, id, NOW, NOW);
  const ins = db.prepare("INSERT INTO messages (id, session_id, turn_id, seq, role, text, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  ins.run(`msg_b${v}a`, id, `trn_b${v}`, 1, "user", `alpha question v${v}`, 4, NOW);
  ins.run(`msg_b${v}b`, id, `trn_b${v}`, 2, "assistant", `beta answer über v${v}`, 5, NOW);
  db.close();
}

function prepare(dir: string): void {
  for (let v = 1; v <= SCHEMA_VERSION; v++) {
    const path = join(dir, `sessions-v${v}.sqlite`);
    createStoreAtVersion({ path, migrations: MIGRATIONS, version: v, migrate });
    rawContent(path, v);
  }
  // The product code fills the latest version.
  const ts = open(join(dir, "sessions-ts.sqlite"));
  const s = ts.createSession({ kind: "direct", agentId: "bernd", owner: ALICE, title: "ts session" });
  const b = ts.beginTurn(s.id, "hello from typescript", 5, {});
  ts.appendEvent(b.turn.id, "delta", { text: "he" });
  ts.completeTurn(b.turn.id, { text: "hi there", tokens: 3, data: { provider: "p", model: "m", usage: { inputTokens: 5, outputTokens: 3 } } });
  ts.rememberToolOffers(s.id, ["file.read", "exec.run"]);
  ts.addSummary({ sessionId: s.id, fromSeq: 1, toSeq: 2, text: "a summary", tokens: 2, tier: 1, state: "applied" });
  ts.setTokenFactor("m", 1.5);
  ts.setToolVisibility(s.id, "r1", true, "old", { mode: "truncate", confidence: 0.5, tokensSaved: 7 });
  ts.close();
  open(join(dir, "sessions-ref.sqlite")).close();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: SCHEMA_VERSION, now: NOW, owner: ALICE, tsSession: s.id, tsTurn: b.turn.id }));
}

/** `sqlite_master` without the rows SQLite generates itself, in a stable order: what the code that made the file produced. */
function schemaOf(copy: StoreCopy): string {
  return JSON.stringify(copy.read("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"));
}

function continueFresh(dir: string): void {
  const out = join(dir, "sessions-fresh-continued.sqlite");
  copyFileSync(join(dir, "sessions-fresh-rust.sqlite"), out);
  const rust = JSON.parse(readFileSync(join(dir, "rust-results.json"), "utf8"));
  const s = open(out, NOW + 1000, 1000);
  const next = s.beginTurn(rust.session, "typescript continues", 4, {});
  s.completeTurn(next.turn.id, { text: "continued", tokens: 2 });
  s.rememberToolOffers(rust.session, ["web.fetch"]);
  s.updateSession(rust.session, { title: "renamed by typescript", pinned: true });
  s.close();
}

function verify(dir: string): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const rust = JSON.parse(readFileSync(join(dir, "rust-results.json"), "utf8"));
  const ref = StoreCopy.open(join(dir, "sessions-ref.sqlite"));
  const refSchema = schemaOf(ref);
  const out: Record<string, unknown> = { refUserVersion: ref.userVersion(), refJournal: ref.check().journalMode };
  const migrated: Record<string, unknown> = {};
  for (let v = 1; v <= SCHEMA_VERSION; v++) {
    const c = StoreCopy.open(join(dir, `sessions-v${v}-rust.sqlite`));
    const chk = c.check();
    // The product code reads what Rust wrote (and migrated), on the copy.
    const s = open(c.path);
    const sessions = s.listSessions({ owner: ALICE, archived: "any", limit: 50 }).sessions;
    const mine = s.getSession(`ses_b${v}`);
    const msgs = s.listMessages(`ses_b${v}`);
    const rustSession = rust.versions[String(v)].session as string;
    migrated[String(v)] = {
      sameSchema: schemaOf(c) === refSchema, userVersion: chk.userVersion, integrity: chk.integrity, fk: chk.foreignKeyViolations, journal: chk.journalMode,
      title: mine?.title, messages: msgs.map((m) => m.text), sessions: sessions.length,
      rustSession: s.getSession(rustSession)?.title, rustTurns: s.listTurns(rustSession).map((t) => t.state),
      rustMessages: s.listMessages(rustSession).map((m) => [m.role, m.text]), rustEvents: s.listEvents(rustSession, 0, 100).map((e) => e.type),
      hits: s.searchMessages({ owner: ALICE, search: "alpha", archived: "any" }).length,
    };
    s.close();
    c.dispose();
  }
  out.migrated = migrated;
  // The file Rust created from nothing.
  const fresh = StoreCopy.open(join(dir, "sessions-fresh-rust.sqlite"));
  const fchk = fresh.check();
  const fs = open(fresh.path);
  out.fresh = {
    sameSchema: schemaOf(fresh) === refSchema, userVersion: fchk.userVersion, integrity: fchk.integrity, journal: fchk.journalMode,
    session: fs.getSession(rust.session)?.title, messages: fs.listMessages(rust.session).map((m) => m.text), offers: fs.toolOffers(rust.session),
    summaries: fs.listSummaries(rust.session).map((x) => x.text), events: fs.listEvents(rust.session, 0, 100).map((e) => e.type),
    rewinds: fs.rewinds(rust.session).length, hits: fs.searchMessages({ owner: ALICE, search: "rust" }).map((h) => h.snippet),
    factor: fs.tokenCalibration("m"), visibility: fs.toolVisibility(rust.session).map((x) => [x.ref, x.hidden, x.mode ?? "drop"]),
  };
  fs.close();
  fresh.dispose();
  // The file TypeScript wrote and Rust wrote into.
  const tsr = StoreCopy.open(join(dir, "sessions-ts-rust.sqlite"));
  const ts = open(tsr.path);
  out.ts = {
    sameSchema: schemaOf(tsr) === refSchema, integrity: tsr.check().integrity, session: ts.getSession(manifest.tsSession)?.title,
    turns: ts.listTurns(manifest.tsSession).map((t) => t.state), messages: ts.listMessages(manifest.tsSession).map((m) => m.text),
    offers: ts.toolOffers(manifest.tsSession), summaries: ts.listSummaries(manifest.tsSession).map((x) => x.text), factor: ts.tokenCalibration("m"),
    visibility: ts.toolVisibility(manifest.tsSession).map((x) => [x.ref, x.hidden, x.mode ?? "drop"]), usage: ts.messageUsage(rust.tsMessage, "m", "hi there") ?? null,
  };
  ts.close();
  tsr.dispose();
  // Rust reads what TypeScript added after Rust wrote.
  const cont = StoreCopy.open(join(dir, "sessions-fresh-continued-rust.sqlite"));
  const cs = open(cont.path);
  out.continued = { turns: cs.listTurns(rust.session).length, title: cs.getSession(rust.session)?.title, integrity: cont.check().integrity };
  cs.close();
  cont.dispose();
  ref.dispose();
  return out;
}

const [command, dir] = process.argv.slice(2);
if (!dir) throw new Error("usage: sessions-b-driver.ts prepare|continue|verify <dir>");
if (command === "prepare") prepare(dir);
else if (command === "continue") continueFresh(dir);
else if (command === "verify") process.stdout.write(JSON.stringify(verify(dir)));
else throw new Error(`unknown command ${command}`);
