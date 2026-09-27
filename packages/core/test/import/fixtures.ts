// Synthetic source installations for the importer tests (docs/import.md §6.1): hand-built OpenClaw and Hermes
// homes, no real data. Two markers must never appear in any report: FAKE_TOKEN (planted in every secret file and
// secret-shaped config value) and CONTENT_MARKER (planted in memory rows, the embedding cache's debug_text and skill
// bodies).
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadLanceDb } from "../../src/import/readonly.ts";
import { CATALOG } from "../../src/import/catalog.ts";
import { tempDir } from "../helpers/temp-dir.ts";

export const FAKE_TOKEN = "sk-fixture-NOT-REAL-9f8e7d";
export const CONTENT_MARKER = "CONTENT-MARKER-do-not-report";
export const E5 = "intfloat/multilingual-e5-small";
export const NANO = "jinaai/jina-embeddings-v5-text-nano-retrieval";
export const SHARED_KEY = `w-${"ab".repeat(31)}`;

export function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

export function skill(dir: string, name: string, description: string, body = `# ${name}\n${CONTENT_MARKER}\n`): void {
  write(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n---\n${body}`);
}

async function lanceStore(partition: string, dims: number, rows: number, extra: Record<string, unknown> = {}): Promise<void> {
  const lancedb = (await loadLanceDb())!;
  mkdirSync(partition, { recursive: true });
  const db = await lancedb.connect(partition) as any;
  const data = Array.from({ length: rows }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, text: `${CONTENT_MARKER} ${i}`, vector: Array.from({ length: dims }, (_, j) => (j === i ? 1 : 0)), ...extra }));
  await db.createTable("memories", data);
  db.close();
}

function cacheDb(path: string, groups: { provider: string; model: string; dimensions: number; n: number }[]): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE embeddings (key_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL,
    scope_id TEXT NOT NULL, cache_version TEXT NOT NULL, text_hash TEXT NOT NULL, vector BLOB NOT NULL, debug_text TEXT, created_at INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
  const ins = db.prepare("INSERT INTO embeddings VALUES (?, ?, ?, ?, 'alpha', 'v2', ?, ?, ?, 0, 0, 0)");
  let k = 0;
  for (const g of groups) for (let i = 0; i < g.n; i++, k++) ins.run(`k${k}`, g.provider, g.model, g.dimensions, `t${k}`, Buffer.alloc(4), `${CONTENT_MARKER} ${FAKE_TOKEN}`);
  return db;
}

export interface OpenclawFixture { base: string; root: string; outside: string; extraSkills: string; cacheWriter: DatabaseSync; close(): void }

/**
 * An OpenClaw state dir with the PLUR1BUS plugin: agent `alpha` (384-d store, embedding cache showing two identities),
 * agent `beta` (768-d store, nothing else known), one shared workspace pool, a Cohere reranker, an E5 model cache,
 * secrets carrying FAKE_TOKEN, and skills: a plain one, one with a script, one with a symlink escape and a .env,
 * a managed `conflict` skill, an extra-dir skill, a workshop skill and a second `notes` in beta's workspace.
 * The embedding cache stays open in WAL mode (a live source) until close().
 */
export async function openclawFixture(): Promise<OpenclawFixture> {
  const base = tempDir("p1b-imp-oc-");
  const root = join(base, ".openclaw");
  const outside = join(base, "outside-secret.txt");
  const extraSkills = join(base, "extra-skills");
  write(outside, `${FAKE_TOKEN}\n`);
  write(join(root, "openclaw.json"), `// synthetic fixture
{
  meta: { lastTouchedVersion: "2026.9.5" },
  agents: { list: [ { id: "alpha", workspace: "${join(root, "ws-alpha")}" }, { id: "beta" } ] },
  skills: { load: { extraDirs: ["${extraSkills}"] } },
  models: { providers: { "anthropic:default": { provider: "anthropic", mode: "api_key", apiKey: "${FAKE_TOKEN}" }, "openai:env": { apiKey: "\${OPENAI_API_KEY}" } } },
  plugins: {
    entries: {
      "memory-lancedb-namespaced": {
        enabled: true,
        config: {
          embedding: { provider: "local-transformers", local: { model: "${E5}", dimensions: 384 } },
          reranker: { enabled: true, provider: "cohere", apiKey: "${FAKE_TOKEN}" },
        },
      },
    },
  },
}
`);
  mkdirSync(join(root, "state"), { recursive: true });
  const sdb = new DatabaseSync(join(root, "state", "openclaw.sqlite"));
  sdb.exec("CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER); INSERT INTO schema_meta VALUES ('primary', 'primary', 17); CREATE TABLE cron_jobs (id TEXT); INSERT INTO cron_jobs VALUES ('j1');");
  sdb.close();
  write(join(root, "extensions", PLUGIN_DIR, "package.json"), JSON.stringify({ name: "@cyb3rb1ade/plur1bus-memory", version: "7.16.11" }));
  write(join(root, ".env"), `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\nexport OPENAI_API_KEY=${FAKE_TOKEN}\n`);
  write(join(root, "credentials", "telegram.json"), JSON.stringify({ token: FAKE_TOKEN }));
  write(join(root, "agents", "alpha", "agent", "auth-profiles.json"), JSON.stringify({ key: FAKE_TOKEN }));
  write(join(root, "agents", "beta", "agent", "openclaw-agent.sqlite"), `SQLite format 3\0${FAKE_TOKEN}`);
  const store = join(root, "memory", "lancedb-namespaced");
  await lanceStore(join(store, "alpha"), 384, 3);
  await lanceStore(join(store, "beta"), 768, 2);
  await lanceStore(join(store, ".plur1bus-shared", "workspaces", SHARED_KEY), 384, 1);
  const cacheWriter = cacheDb(join(store, "embedding-cache-v2", "alpha.db"), [
    { provider: "local-transformers", model: E5, dimensions: 384, n: 2 },
    { provider: "local-transformers", model: NANO, dimensions: 768, n: 1 },
  ]);
  write(join(root, "models", "plur1bus", ...E5.split("/"), CATALOG[E5]!.revision, "onnx", "model.onnx"), "fake-onnx");
  // Workspaces and skills.
  write(join(root, "ws-alpha", "SOUL.md"), `${CONTENT_MARKER}\n`);
  write(join(root, "ws-alpha", "MEMORY.md"), `${CONTENT_MARKER}\n`);
  skill(join(root, "ws-alpha", "skills", "notes"), "notes", "Take meeting notes");
  skill(join(root, "ws-alpha", "skills", "runner"), "runner", "Runs a helper script");
  write(join(root, "ws-alpha", "skills", "runner", "scripts", "run.sh"), "#!/bin/sh\necho hi\n", 0o755);
  skill(join(root, "ws-alpha", "skills", "escape"), "escape", "Has a symlink that escapes");
  symlinkSync(outside, join(root, "ws-alpha", "skills", "escape", "leak.txt"));
  symlinkSync("SKILL.md", join(root, "ws-alpha", "skills", "escape", "alias.md"));
  write(join(root, "ws-alpha", "skills", "escape", ".env"), `SECRET=${FAKE_TOKEN}\n`);
  skill(join(root, "skills", "conflict"), "conflict", "Installed skill that clashes with the harness");
  skill(join(extraSkills, "extra-one"), "extra-one", "From an extra dir");
  skill(join(root, "agents", "alpha", "agent", "workshop-skills", "ws-made"), "ws-made", "Workshop-authored");
  skill(join(root, "workspace-beta", "skills", "notes"), "notes", "Beta's own notes skill", `# other notes\n${CONTENT_MARKER} beta\n`);
  return { base, root, outside, extraSkills, cacheWriter, close: () => cacheWriter.close() };
}
const PLUGIN_DIR = "memory-lancedb-namespaced";

export interface HermesFixture { base: string; root: string; external: string }

/** A Hermes home (config version 45, sessions schema 30) with a `work` profile, skills incl. one with a script, an
 *  external skills dir, `.env`/`auth.json` carrying FAKE_TOKEN, SOUL.md, memory files and cron jobs. */
export function hermesFixture(): HermesFixture {
  const base = tempDir("p1b-imp-hm-");
  const root = join(base, ".hermes");
  const external = join(base, "hermes-ext");
  write(join(root, "config.yaml"), `_config_version: 45
model:
  provider: openrouter
  api_key: "${FAKE_TOKEN}"
memory:
  memory_enabled: true
  provider: ""
skills:
  external_dirs:
    - ${external}
`);
  write(join(root, ".env"), `OPENROUTER_API_KEY=${FAKE_TOKEN}\nTELEGRAM_BOT_TOKEN=${FAKE_TOKEN}\n`);
  write(join(root, "auth.json"), JSON.stringify({ token: FAKE_TOKEN }));
  const db = new DatabaseSync(join(root, "state.db"));
  db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (30); CREATE TABLE messages (content TEXT);");
  db.prepare("INSERT INTO messages VALUES (?)").run(`${CONTENT_MARKER} ${FAKE_TOKEN}`);
  db.close();
  write(join(root, "SOUL.md"), `${CONTENT_MARKER}\n`);
  write(join(root, "memories", "MEMORY.md"), `${CONTENT_MARKER}\n§\nsecond\n`);
  write(join(root, "cron", "jobs.json"), JSON.stringify({ jobs: [{ id: "c1" }] }));
  write(join(root, "skills", "productivity", "meeting-notes", "SKILL.md"), `---
name: meeting-notes
description: Turn raw meeting notes into action items
version: 1.0.0
author: fixture
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [notes]
---
# Meeting notes
${CONTENT_MARKER}
`);
  skill(join(root, "skills", "devops", "deploy"), "deploy", "Deploy helper");
  write(join(root, "skills", "devops", "deploy", "scripts", "deploy.py"), "print('x')\n");
  write(join(root, "skills", ".curator_state"), "{}");
  write(join(root, "profiles", "work", "config.yaml"), "_config_version: 44\n");
  write(join(root, "profiles", "work", "SOUL.md"), `${CONTENT_MARKER}\n`);
  skill(join(root, "profiles", "work", "skills", "research", "lit-review"), "lit-review", "Literature review");
  skill(join(external, "ext-skill"), "ext-skill", "From an external dir");
  return { base, root, external };
}

/** A harness home whose skill store already holds `conflict` (different content) and `notes`-free index. */
export function harnessHome(): string {
  const home = tempDir("p1b-imp-home-");
  skill(join(home, "skills", "conflict"), "conflict", "The harness's own conflict skill", "# harness version\n");
  write(join(home, "skills", "index.json"), JSON.stringify({ version: 1, skills: [{ id: "conflict", source: "local", sourcePath: "/nowhere", sha256: "sha256:placeholder", enabled: true, importedAt: "2026-09-01T00:00:00.000Z", note: "kept" }] }));
  return home;
}
