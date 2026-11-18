// Collaboration store round trip, parity mode B (P4-K K6a, plan P4-50): the TypeScript side that
// `crates/plur1bus-core/tests/collab_mode_b.rs` drives.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/collab-b-driver.ts prepare <dir>
//   node ... tests/core-parity/collab-b-driver.ts verify <dir>
//
// `prepare` writes real TypeScript files into <dir>:
//   collab-v<N>.sqlite   the store at schema version N (1..SCHEMA_VERSION, through the store's own `migrate`) with one project,
//                        one member and one agent written as raw rows (the columns every version has)
//   collab-ts.sqlite     the latest version written by the product code (project, board card, trace, span, task, artifact, worktree)
//   manifest.json        what the Rust test must find
// The Rust test opens copies (`collab-v<N>-rust.sqlite`, `collab-ts-rust.sqlite`), which migrates them, and writes through its
// public methods. `verify` reads those copies with the product code and prints one JSON object that the Rust test compares.
// Test tooling only; no product code imports it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreCopy, createStoreAtVersion } from "./store-roundtrip.ts";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../../packages/core/src/collab/migrations.ts";
import { CollabStore } from "../../packages/core/src/collab/store.ts";

const NOW = Date.UTC(2026, 10, 18, 12);

function open(path: string, now = NOW, start = 0) {
  let n = start;
  return new CollabStore({ path, clock: () => now, newId: (p) => `${p}_${++n}` });
}

/** What the Rust side must read from every version file: columns every schema version has. */
function rawContent(path: string, v: number): void {
  const db = new DatabaseSync(path);
  const id = `prj_b${v}`;
  db.prepare("INSERT INTO projects (id, name, owner, settings, created_at, updated_at, archived_at) VALUES (?, ?, 'u-owner', '{}', ?, ?, NULL)").run(id, `project v${v}`, NOW, NOW);
  db.prepare("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, 'u-owner', 'lead', ?)").run(id, NOW);
  db.prepare("INSERT INTO project_agents (project_id, agent_id, added_at) VALUES (?, 'agent-old', ?)").run(id, NOW);
  db.close();
}

function prepare(dir: string): void {
  for (let v = 1; v <= SCHEMA_VERSION; v++) {
    const path = join(dir, `collab-v${v}.sqlite`);
    createStoreAtVersion({ path, migrations: MIGRATIONS, version: v, migrate });
    rawContent(path, v);
  }
  const ts = open(join(dir, "collab-ts.sqlite"));
  const p = ts.createProject({ name: "ts project", owner: "u-owner" });
  ts.addAgent(p.id, "agent-a");
  ts.addMember(p.id, "u-two", "member");
  const card = ts.board.createCard(p.id, { title: "from typescript", columnId: `${p.id}:backlog` }, { kind: "person", id: "u-owner" });
  ts.insertTrace({ traceId: "t1", projectId: p.id, rootAgent: "agent-a", rootSpanId: "s1" });
  ts.insertSpan({ spanId: "s1", traceId: "t1", parentSpanId: null, agentId: "agent-a", kind: "consult", inputPreview: "question" });
  ts.finishSpan("s1", { status: "succeeded", outputPreview: "answer", inputTokens: 3, outputTokens: 4 });
  ts.insertTask({ id: "k1", projectId: p.id, traceId: "t1", spanId: "s1", parentTaskId: null, fromAgent: "agent-a", toAgent: "agent-b", kind: "delegate", status: "running", task: "do it", acceptance: "done", path: ["agent-a", "agent-b"] });
  const art = ts.putArtifact(p.id, "full body", "text/plain");
  ts.insertWorktree({ projectId: p.id, rootId: p.id, cardId: card.id, branch: "b1", path: "/w/1", baseSha: "abc" });
  ts.close();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: SCHEMA_VERSION, now: NOW, project: p.id, card: card.id, artifact: art.id }));
}

/** `sqlite_master` without the rows SQLite generates itself, in a stable order. */
function schemaOf(copy: StoreCopy): unknown {
  return copy.read("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
}

function verify(dir: string): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const out: Record<string, unknown> = {};
  const versions: Record<string, unknown> = {};
  for (let v = 1; v <= SCHEMA_VERSION; v++) {
    const copy = StoreCopy.open(join(dir, `collab-v${v}-rust.sqlite`));
    try {
      const check = copy.check();
      const schema = schemaOf(copy);
      const s = open(copy.path, NOW + 1000, 1000);
      try {
        const old = s.getProject(`prj_b${v}`);
        const mine = s.getProject(`prj_rust${v}`);
        versions[String(v)] = {
          check, schema,
          old: old && { name: old.name, members: old.members, agents: old.agents },
          mine: mine && { name: mine.name, members: mine.members, agents: mine.agents },
          cards: mine ? s.board.cards(mine.id, {}).cards.map((c: any) => c.title) : null,
        };
      } finally { s.close(); }
    } finally { copy.dispose(); }
  }
  out.versions = versions;
  const copy = StoreCopy.open(join(dir, "collab-ts-rust.sqlite"));
  try {
    const s = open(copy.path, NOW + 1000, 1000);
    try {
      const p = s.getProject(manifest.project);
      out.ts = {
        check: copy.check(),
        project: p && { name: p.name, members: p.members, agents: p.agents },
        cards: s.board.cards(manifest.project, {}).cards.map((c: any) => c.title),
        trace: s.getTrace("t1")?.spans.map((x: any) => [x.spanId, x.status]),
        task: s.getTask("k1")?.status,
        artifact: s.getArtifact(manifest.artifact)?.body,
        worktree: s.liveWorktree(manifest.project, manifest.card)?.path,
      };
    } finally { s.close(); }
  } finally { copy.dispose(); }
  return out;
}

const [command, dir] = process.argv.slice(2);
if (!dir) throw new Error("usage: collab-b-driver.ts prepare|verify <dir>");
if (command === "prepare") prepare(dir);
else if (command === "verify") process.stdout.write(`${JSON.stringify(verify(dir))}\n`);
else throw new Error(`unknown command ${command}`);
