// Parity sequences (ruling R9 of P4-12, "sequences for stateful code") for the card sensitivity store and service (task 7):
// every method of `MemorySensitivityStore` and `MemorySensitivityService` driven against a temporary
// `memory-sensitivity.sqlite`. `crates/plur1bus-core/src/exposure/sensitivity_vectors.rs` replays every step and compares the
// result or error and the content of the table after it. Recorded, never edited by hand.
//
// CLOCK. `store.ts` reads `Date.now()` where a method is called without `nowMs` (lines 77 and 103) and the service never passes
// one (inventory 13). The exporter does not touch the source: for the time of the build it replaces `Date.now` with the scripted
// clock of the world (`w.t`, advanced by the scenario between steps) and restores it in a `finally`. Every step records `at`,
// the value the clock returns during that step. A store step may pass `nowMs`; without it the Rust replay passes `at`.
//
// FORMAT. `scenarios.json`: `{ scenarios: [{ name, steps }] }`. A step is one JSON text (one line of the fixture):
// `{ op, args, at, out: { ok } | { err }, seen?, tables? }`. `tables.card_sensitivity` is the content (`SELECT * ORDER BY 1`,
// rows as arrays in column order) when it differs from the step before. `err` is `{ sqlite: <extended result code> }` for an
// error SQLite raised that the store lets through. `seen` lists the `[text, summary | null]` pairs the scripted local-model
// hook received during the step.
// Ops: `seed` and `sql` run a statement on a separate connection (a file an older layout left behind, a direct edit), `pragma`
// reads one on a separate connection, `open` / `close` the store and service, `model` scripts the local-model hook, `store.*`
// the store, the other names the service.
// `schema.json`: `sqlite_master`, the pragmas of the connection of a store that has just been created (read through the
// connection the store opened: its `exec` is wrapped for the moment of the construction only) and the column order of the table.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-sensitivity.ts [--check]
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MemorySensitivityStore } from "../../packages/core/src/memory-sensitivity/store.ts";
import { MemorySensitivityService } from "../../packages/core/src/memory-sensitivity/service.ts";
import { exporterMain } from "./lib.mjs";

type Json = any;
const T0 = 1_760_000_000_000;
const MIN = 60_000;
const TABLE = "card_sensitivity";

function errorOf(e: unknown): Json {
  const errcode = (e as { errcode?: unknown })?.errcode;
  if (typeof errcode === "number") return { sqlite: errcode };
  throw e; // anything else is a scenario the typed Rust API cannot express
}
const clone = (v: unknown): Json => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

class World {
  readonly steps: string[] = [];
  t = T0;
  store: MemorySensitivityStore | null = null;
  svc: MemorySensitivityService | null = null;
  private model: Json = null;
  private seen: Json[] = [];
  private last = "[]";
  readonly file: string;
  constructor(file: string) { this.file = file; mkdirSync(path.dirname(file), { recursive: true }); }

  private withDb<T>(f: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.file);
    try { return f(db); } finally { db.close(); }
  }

  private dump(): Json[][] | null {
    if (!existsSync(this.file)) return null;
    try {
      const rows = this.withDb((db) => db.prepare(`SELECT * FROM ${TABLE} ORDER BY 1`).all() as Record<string, unknown>[]).map((r) => Object.values(r));
      const text = JSON.stringify(rows);
      if (text === this.last) return null;
      this.last = text;
      return rows;
    } catch { return null; } // no table yet
  }

  private async call(op: string, a: Json): Promise<unknown> {
    switch (op) {
      case "seed": case "sql": this.withDb((db) => db.exec(a.text)); return undefined;
      case "pragma": return this.withDb((db) => Object.values(db.prepare(`PRAGMA ${a.name}`).get() as Record<string, unknown>)[0]);
      case "model": this.model = a.model; return undefined;
      case "open": {
        this.store = new MemorySensitivityStore({ path: this.file });
        this.svc = new MemorySensitivityService({
          store: this.store,
          ...(a.model ? { localModelClassifier: async (text: string, summary?: string) => {
            this.seen.push([text, summary ?? null]);
            if (!this.model) return [];
            if (this.model.throws) throw new Error("model down");
            return [...this.model.cats];
          } } : {}),
        });
        return undefined;
      }
      case "close": this.svc!.close(); this.svc = null; this.store = null; return undefined;
      case "store.get": return this.store!.get(a.cardId);
      case "store.getByHash": return this.store!.getByHash(a.contentHash);
      case "store.set": return this.store!.set(a.cardId, a.categories, a.source, a.contentHash, a.nowMs);
      case "store.clear": return this.store!.clear(a.cardId, a.category, a.nowMs);
      case "store.hasManualCategories": return this.store!.hasManualCategories(a.categories);
      case "assessCard": return await this.svc!.assessCard(a.card);
      case "assessAggregate": return await this.svc!.assessAggregate(a.text, a.summary);
      case "setSensitivity": return this.svc!.setSensitivity(a.cardId, a.categories, a.card);
      case "clearSensitivity": return this.svc!.clearSensitivity(a.cardId, a.category);
      case "hasManualCategories": return this.svc!.hasManualCategories(a.categories);
      case "getSensitivity": return this.svc!.getSensitivity(a.cardId);
      default: throw new Error(`unknown op ${op}`);
    }
  }

  private async step(op: string, args: Json): Promise<{ ok?: Json; err?: Json }> {
    this.seen = [];
    let out: { ok?: Json; err?: Json };
    try { out = { ok: clone(await this.call(op, args)) }; } catch (e) { out = { err: errorOf(e) }; }
    const rows = this.dump();
    this.steps.push(JSON.stringify({ op, args: clone(args), at: this.t, out, ...(this.seen.length ? { seen: this.seen } : {}), ...(rows ? { tables: { [TABLE]: rows } } : {}) }));
    return out;
  }
  /** Runs a step that must succeed and returns its result. */
  async ok(op: string, args: Json = {}): Promise<Json> {
    const out = await this.step(op, args);
    if (out.err) throw new Error(`${op} ${JSON.stringify(args)}: expected a result, got ${JSON.stringify(out.err)}`);
    return out.ok;
  }
  /** Runs a step that must fail with an error SQLite raised. */
  async sqlite(op: string, args: Json): Promise<Json> {
    const out = await this.step(op, args);
    if (!out.err) throw new Error(`${op} ${JSON.stringify(args)}: expected a SQLite error, got ${JSON.stringify(out)}`);
    return out.err;
  }
}

const HEALTH = "Diagnose: Typ-2-Diabetes. Behandlung mit Metformin.";
const FINANCE = "Please transfer the monthly salary to IBAN DE89370400440532013000.";
const CARD_NO = "Pay with 4111 1111 1111 1111 please";
const CRED = "The staging API key is sk-ant-api03-1234567890abcdef1234567890.";
const BEARER = "curl -H 'Authorization: Bearer abc.def-ghi'";
const IDENT = "Reisepass Nummer C01X00T4L ausgestellt in Berlin.";
const PERSONAL = "Geburtsdatum: 14.05.1988, Privatadresse: Musterstraße 12, Köln.";
const PLAIN = "Remember to water the plants on Friday.";
const ALL = [HEALTH, FINANCE, CRED, IDENT, PERSONAL].join("\n");

const SCENARIOS: Record<string, (w: World) => Promise<void>> = {
  async "classify-cache-change"(w) {
    await w.ok("open");
    await w.ok("assessCard", { card: { id: "c1", text: HEALTH } }); // first sight: classified, stored as a rule record
    w.t += MIN;
    await w.ok("assessCard", { card: { id: "c1", text: HEALTH } }); // same hash: answered from the record, nothing written
    await w.ok("getSensitivity", { cardId: "c1" });
    w.t += MIN;
    await w.ok("assessCard", { card: { id: "c2", text: HEALTH } }); // another card, same content: copied by hash
    await w.ok("assessCard", { card: { id: "c3", text: `  ${HEALTH}\n\n` } }); // trim() makes the hash equal
    w.t += MIN;
    await w.ok("assessCard", { card: { id: "c1", text: FINANCE } }); // content change of a rule record: classified again
    await w.ok("getSensitivity", { cardId: "c1" });
    await w.ok("assessCard", { card: { id: "c4", text: PLAIN, summary: IDENT } }); // the summary is scanned too
    await w.ok("assessCard", { card: { id: "c4", text: PLAIN, summary: "" } }); // an empty summary is an absent one: same hash
    await w.ok("assessCard", { card: { id: "c4", text: PLAIN } });
    await w.ok("assessCard", { card: { id: "c5", text: PLAIN } }); // nothing found: an empty record, which is a cache hit
    await w.ok("assessCard", { card: { id: "c6", text: PLAIN } });
    await w.ok("assessCard", { card: { id: "c7", text: "" } });
    await w.ok("assessCard", { card: { id: "c8", text: CARD_NO } });
    await w.ok("assessCard", { card: { id: "c9", text: CRED } });
    await w.ok("assessCard", { card: { id: "c10", text: BEARER } });
    await w.ok("assessCard", { card: { id: "c11", text: IDENT } });
    await w.ok("assessCard", { card: { id: "c12", text: PERSONAL } });
    await w.ok("assessCard", { card: { id: "c13", text: ALL } }); // every category, sorted
    await w.ok("assessCard", { card: { id: "c14", text: "Krankenhaus für Müller, Passwort ändern", summary: "Gehalt" } });
    await w.ok("assessAggregate", { text: ALL });
    await w.ok("assessAggregate", { text: PLAIN, summary: HEALTH });
    await w.ok("assessAggregate", { text: "" });
    await w.ok("getSensitivity", { cardId: "missing" });
    await w.ok("close");
  },

  async "manual-labels"(w) {
    await w.ok("open");
    // `set` without card text and without a record: a manual label with contentHash "" (inventory 3).
    await w.ok("setSensitivity", { cardId: "m1", categories: ["personal", "financial"] });
    w.t += MIN;
    await w.ok("assessCard", { card: { id: "m1", text: CRED } }); // a manual label wins over any text
    await w.ok("store.set", { cardId: "m1", categories: ["credential"], source: "rule", contentHash: "h" }); // a rule write over a manual record is dropped
    await w.ok("store.set", { cardId: "m1", categories: ["credential"], source: "model", contentHash: "h" });
    await w.ok("setSensitivity", { cardId: "m1", categories: ["health"], card: { text: HEALTH } }); // manual over manual, hash now known
    w.t += MIN;
    await w.ok("assessCard", { card: { id: "m1", text: FINANCE } }); // content change: the manual label survives (inventory 14)
    await w.ok("getSensitivity", { cardId: "m1" });
    await w.ok("setSensitivity", { cardId: "m1", categories: ["identity"] }); // without card text the old hash stays
    await w.ok("setSensitivity", { cardId: "m1", categories: [], card: { text: PLAIN, summary: "s" } });
    // A rule label first, a manual one after it.
    await w.ok("assessCard", { card: { id: "r1", text: HEALTH } });
    w.t += MIN;
    await w.ok("setSensitivity", { cardId: "r1", categories: ["financial"] });
    await w.ok("assessCard", { card: { id: "r1", text: CRED } });
    await w.ok("store.set", { cardId: "r2", categories: ["personal"], source: "model", contentHash: "hm", nowMs: T0 + 5 });
    await w.ok("store.set", { cardId: "r2", categories: ["identity"], source: "rule", contentHash: "hr" }); // model over model/rule: allowed
    await w.ok("store.set", { cardId: "r2", categories: ["health"], source: "manual", contentHash: "hx", nowMs: 0 });
    await w.sqlite("store.set", { cardId: "bad", categories: ["health"], source: "bogus", contentHash: "h" }); // the CHECK of the table
    await w.ok("store.get", { cardId: "r2" });
    await w.ok("close");
  },

  async "clear"(w) {
    await w.ok("open");
    await w.ok("setSensitivity", { cardId: "k1", categories: ["health", "financial", "personal"], card: { text: HEALTH } });
    w.t += MIN;
    await w.ok("clearSensitivity", { cardId: "k1", category: "financial" });
    w.t += MIN;
    await w.ok("clearSensitivity", { cardId: "k1", category: "credential" }); // not in the list: still rewritten, still cleared: true
    await w.ok("clearSensitivity", { cardId: "nope", category: "health" });
    await w.ok("clearSensitivity", { cardId: "nope" });
    w.t += MIN;
    await w.ok("clearSensitivity", { cardId: "k1", category: "" }); // "" is falsy: the whole record goes
    await w.ok("setSensitivity", { cardId: "k2", categories: ["health"] });
    await w.ok("clearSensitivity", { cardId: "k2", category: "health" }); // the last category: the record goes
    await w.ok("setSensitivity", { cardId: "k3", categories: ["health", "identity"] });
    await w.ok("clearSensitivity", { cardId: "k3" });
    await w.ok("setSensitivity", { cardId: "k4", categories: ["health", "identity"] });
    await w.ok("clearSensitivity", { cardId: "k4", category: null });
    await w.ok("store.set", { cardId: "k5", categories: ["health", "identity", "personal"], source: "rule", contentHash: "h5", nowMs: T0 });
    await w.ok("store.clear", { cardId: "k5", category: "identity", nowMs: 42 });
    w.t += MIN;
    await w.ok("store.clear", { cardId: "k5", category: "health" }); // no nowMs: the clock
    await w.ok("store.clear", { cardId: "k5", category: "personal", nowMs: 1 });
    await w.ok("store.clear", { cardId: "k5" });
    await w.ok("close");
  },

  async "copy-by-hash"(w) {
    await w.ok("open");
    await w.ok("setSensitivity", { cardId: "src", categories: ["health", "credential"], card: { text: HEALTH } }); // manual
    w.t += MIN;
    await w.ok("assessCard", { card: { id: "dst1", text: HEALTH } }); // copied with its source: manual
    await w.ok("getSensitivity", { cardId: "dst1" });
    await w.ok("hasManualCategories", { categories: ["credential"] });
    await w.ok("assessCard", { card: { id: "dst1", text: "other text now" } }); // the copy is manual: it survives a change
    await w.ok("clearSensitivity", { cardId: "src" });
    w.t += MIN;
    await w.ok("assessCard", { card: { id: "dst2", text: HEALTH } }); // the source is gone: copied from dst1
    await w.ok("assessCard", { card: { id: "r1", text: IDENT } });
    w.t += MIN;
    await w.ok("assessCard", { card: { id: "r2", text: IDENT } }); // a rule record copies as a rule record
    await w.ok("setSensitivity", { cardId: "r1", categories: ["personal"], card: { text: IDENT } }); // r1 becomes manual, same hash as r2
    w.t += MIN;
    await w.ok("assessCard", { card: { id: "r3", text: IDENT } }); // the newest record of that hash is r1: manual
    await w.ok("store.getByHash", { contentHash: "unknown-hash" });
    await w.ok("close");
  },

  async "get-by-hash-ties"(w) {
    await w.ok("open");
    // Three records of one hash written at the same instant, in the order b, a, c: `ORDER BY updated_at DESC LIMIT 1` has a tie.
    await w.ok("store.set", { cardId: "c-b", categories: ["health"], source: "rule", contentHash: "H1", nowMs: T0 });
    await w.ok("store.getByHash", { contentHash: "H1" });
    await w.ok("store.set", { cardId: "c-a", categories: ["financial"], source: "rule", contentHash: "H1", nowMs: T0 });
    await w.ok("store.getByHash", { contentHash: "H1" });
    await w.ok("store.set", { cardId: "c-c", categories: ["personal"], source: "manual", contentHash: "H1", nowMs: T0 });
    await w.ok("store.getByHash", { contentHash: "H1" });
    await w.ok("store.set", { cardId: "c-a", categories: ["financial"], source: "rule", contentHash: "H1", nowMs: T0 + 1 });
    await w.ok("store.getByHash", { contentHash: "H1" }); // a newer one wins
    await w.ok("store.set", { cardId: "c-d", categories: ["identity"], source: "rule", contentHash: "H1", nowMs: T0 - 1 });
    await w.ok("store.getByHash", { contentHash: "H1" });
    // Another hash, other insertion order and distinct times.
    await w.ok("store.set", { cardId: "z1", categories: ["health"], source: "rule", contentHash: "H2", nowMs: 5 });
    await w.ok("store.set", { cardId: "z2", categories: ["health"], source: "rule", contentHash: "H2", nowMs: 9 });
    await w.ok("store.set", { cardId: "z3", categories: ["health"], source: "rule", contentHash: "H2", nowMs: 7 });
    await w.ok("store.getByHash", { contentHash: "H2" });
    // Ties again, with ids in descending and ascending insertion order.
    for (const id of ["t9", "t5", "t7", "t1"]) await w.ok("store.set", { cardId: id, categories: [], source: "rule", contentHash: "H3", nowMs: 100 });
    await w.ok("store.getByHash", { contentHash: "H3" });
    await w.ok("store.getByHash", { contentHash: "H3 " }); // exact comparison: no trimming
    await w.ok("setSensitivity", { cardId: "nohash", categories: ["health"] }); // contentHash ""
    await w.ok("store.getByHash", { contentHash: "" }); // "" is never looked up
    await w.ok("store.getByHash", { contentHash: "missing" });
    await w.ok("close");
  },

  async "has-manual"(w) {
    await w.ok("open");
    await w.ok("hasManualCategories", { categories: [] });
    await w.ok("hasManualCategories", { categories: ["health"] }); // empty table
    await w.ok("setSensitivity", { cardId: "m1", categories: ["health"] });
    await w.ok("hasManualCategories", { categories: ["health"] });
    await w.ok("hasManualCategories", { categories: ["financial"] });
    await w.ok("hasManualCategories", { categories: ["financial", "health"] });
    await w.ok("hasManualCategories", { categories: ["health", "health", "health"] });
    await w.ok("hasManualCategories", { categories: ["HEALTH"] }); // compared as written
    await w.ok("hasManualCategories", { categories: [""] });
    await w.ok("hasManualCategories", { categories: ["x"] });
    await w.ok("assessCard", { card: { id: "r1", text: CRED } }); // a rule record with credential only
    await w.ok("hasManualCategories", { categories: ["credential"] }); // rule records do not count
    await w.ok("store.hasManualCategories", { categories: ["credential"] });
    await w.ok("hasManualCategories", { categories: ["credential", "health"] });
    await w.ok("setSensitivity", { cardId: "m2", categories: ["credential", "personal"] });
    await w.ok("hasManualCategories", { categories: ["credential"] });
    await w.ok("hasManualCategories", { categories: ["personal", "identity"] });
    await w.ok("hasManualCategories", { categories: ["identity", "financial"] });
    await w.ok("store.set", { cardId: "m3", categories: ['a"b', "c\\d", "é", "😀", "x y", "[1]"], source: "manual", contentHash: "h", nowMs: T0 });
    for (const c of ['a"b', "c\\d", "é", "😀", "x y", "[1]", "1", "a", "é"]) await w.ok("hasManualCategories", { categories: [c] });
    await w.ok("hasManualCategories", { categories: ["\u0000", "é"] });
    await w.ok("clearSensitivity", { cardId: "m1" });
    await w.ok("hasManualCategories", { categories: ["health"] });
    await w.ok("store.set", { cardId: "m4", categories: ["health"], source: "model", contentHash: "h", nowMs: T0 });
    await w.ok("hasManualCategories", { categories: ["health"] }); // a model record does not count
    await w.ok("close");
  },

  async "category-arrays"(w) {
    await w.ok("open");
    await w.ok("store.set", { cardId: "a1", categories: ["health", "health", "personal", "health"], source: "rule", contentHash: "h1", nowMs: T0 }); // duplicates collapse
    await w.ok("store.set", { cardId: "a2", categories: ["zzz", "health"], source: "rule", contentHash: "h2", nowMs: T0 }); // an unknown category is stored
    await w.ok("store.set", { cardId: "a3", categories: [], source: "rule", contentHash: "h3", nowMs: T0 });
    await w.ok("store.set", { cardId: "a4", categories: ["personal", "identity", "health", "financial", "credential"], source: "rule", contentHash: "h4", nowMs: T0 });
    await w.ok("store.set", { cardId: "a5", categories: ["é", "z", "e", "Z", "a", "😀", "￿", "퟿", "10", "9", ""], source: "rule", contentHash: "h5", nowMs: T0 }); // UTF-16 code unit order
    await w.ok("setSensitivity", { cardId: "a6", categories: ["personal", "health", "personal"] });
    await w.ok("setSensitivity", { cardId: "a7", categories: ["nonsense", "health"] });
    await w.ok("setSensitivity", { cardId: "a8", categories: [] });
    await w.ok("store.clear", { cardId: "a1", category: "health", nowMs: T0 + 1 });
    await w.ok("getSensitivity", { cardId: "a5" });
    await w.ok("hasManualCategories", { categories: ["nonsense"] });
    await w.ok("hasManualCategories", { categories: ["personal", "personal"] });
    await w.ok("close");
  },

  async "texts-and-ids"(w) {
    await w.ok("open");
    const long = "ü".repeat(2400);
    await w.ok("setSensitivity", { cardId: "", categories: ["health"], card: { text: "" } }); // the empty id
    await w.ok("getSensitivity", { cardId: "" });
    await w.ok("assessCard", { card: { id: "", text: "x" } });
    await w.ok("setSensitivity", { cardId: "0", categories: ["personal"], card: { text: "0" } });
    await w.ok("assessCard", { card: { id: "kärte-日本-🙂", text: "Krankenhaus ß 日本語 🙂" } });
    await w.ok("getSensitivity", { cardId: "kärte-日本-🙂" });
    await w.ok("assessCard", { card: { id: "ws", text: " ﻿ Diagnose  　" } }); // the JavaScript trim set
    await w.ok("assessCard", { card: { id: "ws2", text: "Diagnose" } });
    await w.ok("assessCard", { card: { id: "cr", text: "a\r\nb\tc\u0007\u007f", summary: "\n" } });
    await w.ok("assessCard", { card: { id: long, text: `${long} Krankenhaus ${long}`, summary: long } });
    await w.ok("getSensitivity", { cardId: long });
    await w.ok("clearSensitivity", { cardId: long });
    await w.ok("store.set", { cardId: "ñ".repeat(3), categories: ["personal"], source: "manual", contentHash: "é", nowMs: 0 });
    await w.ok("store.set", { cardId: "big", categories: [], source: "rule", contentHash: "h", nowMs: 9_007_199_254_740_991 });
    await w.ok("store.set", { cardId: "neg", categories: [], source: "rule", contentHash: "h", nowMs: -1 });
    await w.ok("store.get", { cardId: "big" });
    w.t = 0; // a clock that reads 0
    await w.ok("setSensitivity", { cardId: "zero", categories: ["health"] });
    await w.ok("assessCard", { card: { id: "zero2", text: "Arzt" } });
    await w.ok("clearSensitivity", { cardId: "zero", category: "personal" });
    await w.ok("close");
  },

  async "reopen"(w) {
    await w.ok("open");
    await w.ok("pragma", { name: "journal_mode" });
    await w.ok("assessCard", { card: { id: "c1", text: HEALTH } });
    await w.ok("setSensitivity", { cardId: "m1", categories: ["identity"], card: { text: IDENT } });
    await w.ok("close");
    w.t += MIN;
    await w.ok("pragma", { name: "journal_mode" });
    await w.ok("pragma", { name: "user_version" });
    await w.ok("open"); // the same file again: the statements are IF NOT EXISTS
    await w.ok("getSensitivity", { cardId: "c1" });
    await w.ok("getSensitivity", { cardId: "m1" });
    await w.ok("assessCard", { card: { id: "c2", text: HEALTH } });
    await w.ok("hasManualCategories", { categories: ["identity"] });
    await w.ok("close");
    await w.ok("sql", { text: "DROP INDEX idx_card_sensitivity_hash" }); // a file whose index is gone gets it back
    await w.ok("open", { model: true });
    await w.ok("sql", { text: "SELECT 1" });
    await w.ok("getSensitivity", { cardId: "c2" });
    await w.ok("close");
  },

  async "older-layout-without-check"(w) {
    // The store has no `user_version`, no ALTER guard and no migration: whatever table is there stays as it is.
    await w.ok("seed", { text: "CREATE TABLE card_sensitivity (card_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, categories TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO card_sensitivity VALUES ('old', 'h-old', '[\"health\"]', 'legacy', 5); PRAGMA user_version = 7;" });
    await w.ok("pragma", { name: "journal_mode" });
    await w.ok("open");
    await w.ok("pragma", { name: "user_version" });
    await w.ok("pragma", { name: "journal_mode" });
    await w.ok("getSensitivity", { cardId: "old" });
    await w.ok("store.getByHash", { contentHash: "h-old" });
    await w.ok("store.set", { cardId: "new", categories: ["health"], source: "bogus", contentHash: "h" }); // no CHECK in this table
    await w.ok("assessCard", { card: { id: "old", text: HEALTH } }); // source "legacy" is not manual: reclassified
    await w.ok("close");
  },

  async "older-layout-without-column"(w) {
    await w.ok("seed", { text: "CREATE TABLE card_sensitivity (card_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, categories TEXT NOT NULL, source TEXT NOT NULL); INSERT INTO card_sensitivity VALUES ('old', 'h-old', '[\"health\"]', 'manual');" });
    await w.ok("open"); // the table is not altered
    await w.sqlite("getSensitivity", { cardId: "old" }); // no such column: updated_at
    await w.sqlite("store.set", { cardId: "x", categories: [], source: "rule", contentHash: "h", nowMs: 1 });
    await w.ok("store.getByHash", { contentHash: "" });
    await w.sqlite("store.getByHash", { contentHash: "h-old" });
    await w.ok("hasManualCategories", { categories: ["health"] }); // reads card.source and card.categories only
    await w.ok("hasManualCategories", { categories: ["personal"] });
    await w.sqlite("assessCard", { card: { id: "old", text: HEALTH } });
    await w.ok("close");
  },

  async "model-hook"(w) {
    await w.ok("open", { model: true });
    await w.ok("assessAggregate", { text: PLAIN }); // the hook says nothing
    await w.ok("model", { model: { cats: ["personal", "health"] } });
    await w.ok("assessAggregate", { text: PLAIN, summary: "sum" });
    await w.ok("assessCard", { card: { id: "m1", text: HEALTH } }); // rules and model merged, sorted, stored as "rule"
    await w.ok("assessCard", { card: { id: "m2", text: HEALTH } }); // copied by hash: the hook is not asked
    await w.ok("assessCard", { card: { id: "m3", text: PLAIN, summary: "s" } });
    await w.ok("assessCard", { card: { id: "m4", text: IDENT } });
    await w.ok("model", { model: { throws: true } }); // a failing hook falls back to the rules
    await w.ok("assessAggregate", { text: IDENT });
    await w.ok("assessCard", { card: { id: "m5", text: PERSONAL } });
    await w.ok("model", { model: { cats: ["zzz", "zzz", "identity", "identity"] } });
    await w.ok("assessAggregate", { text: IDENT });
    await w.ok("assessCard", { card: { id: "m6", text: "Bernd 🙂" } });
    await w.ok("model", { model: null });
    await w.ok("assessCard", { card: { id: "m7", text: "Bernd 🙂 again" } });
    await w.ok("close");
  },
};

function buildSchema(file: string): Json {
  // The store keeps its connection private: wrap `exec` of the class for the moment of the construction to see it.
  mkdirSync(path.dirname(file), { recursive: true }); // the store creates no directory
  const proto = (DatabaseSync as Json).prototype;
  const realExec = proto.exec;
  let db: DatabaseSync | null = null;
  proto.exec = function (this: DatabaseSync, ...args: unknown[]) { db ??= this; return realExec.apply(this, args); };
  let store: MemorySensitivityStore;
  try { store = new MemorySensitivityStore({ path: file }); } finally { proto.exec = realExec; }
  try {
    const conn = db!;
    const rows = (table: string) => conn.prepare(`SELECT type, name, tbl_name, sql FROM ${table} ORDER BY type, name`).all();
    const pragma = (name: string) => Object.values(conn.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
    return {
      master: rows("sqlite_master"),
      columns: { [TABLE]: (conn.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[]).map((r) => r.name) },
      pragmas: Object.fromEntries(["journal_mode", "foreign_keys", "busy_timeout", "synchronous", "user_version"].map((n) => [n, pragma(n)])),
    };
  } finally { store.close(); }
}

/** `{ scenarios, schema }`: the fixtures of `fixtures/parity/sensitivity/`. */
export async function buildSensitivityVectors(): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(path.join(tmpdir(), "p1b-parity-sensitivity-"));
  const realNow = Date.now;
  let world: World | null = null;
  Date.now = () => world?.t ?? T0; // the scripted clock; restored below
  try {
    const scenarios: Json[] = [];
    let i = 0;
    for (const [name, run] of Object.entries(SCENARIOS)) {
      const w = (world = new World(path.join(dir, `s${i++}`, "memory-sensitivity.sqlite")));
      try { await run(w); } finally { try { w.svc?.close(); } catch { /* already closed */ } }
      scenarios.push({ name, steps: w.steps });
    }
    world = null;
    return { scenarios: { scenarios }, schema: buildSchema(path.join(dir, "schema", "memory-sensitivity.sqlite")) };
  } finally { Date.now = realNow; rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "sensitivity", build: buildSensitivityVectors });
}
