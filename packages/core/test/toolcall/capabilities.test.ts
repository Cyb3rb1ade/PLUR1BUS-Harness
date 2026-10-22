// core/toolcall capability index (BM25 + optional embedding port, category quotas, cache), the category taxonomy and the SQLite registry.
// Expectations: the doc comments in capabilities.ts / categories.ts / sqlite-registry.ts ("Library index; persistence and policy
// filtering are supplied by the registration/embedding ports", "Stable two-level taxonomy") and BM25 / quota arithmetic done by hand.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { CapabilityIndex, capabilitiesSearch, type CapabilityEntry, type RegistrationPort, type EmbeddingPort } from "../../src/toolcall/capabilities.ts";
import { CATEGORIES, CATEGORY_PREFIX } from "../../src/toolcall/categories.ts";
import { SqliteCapabilityRegistry } from "../../src/toolcall/sqlite-registry.ts";
import { mulberry32, useTempDirs, entry } from "./helpers.ts";

const e = (id: string, over: Partial<CapabilityEntry> = {}) => entry({ id, name: id, ...over });

describe("CapabilityIndex.upsert: validation", () => {
  const invalid: [string, Partial<CapabilityEntry>][] = [
    ["empty id", { id: "" }], ["empty name", { name: "" }], ["empty description", { description: "" }], ["empty version", { version: "" }], ["empty source", { source: "" }],
    ["unknown kind", { kind: "gadget" as never }], ["unknown effect", { effect: "write" as never }], ["unknown risk", { risk: "extreme" as never }],
    ["category without dot", { category: "docs" }], ["category with three levels", { category: "docs.create.pdf" }], ["category upper case", { category: "Docs.create" }],
    ["category starts with digit", { category: "1docs.create" }], ["category with underscore", { category: "docs.cre_ate" }], ["empty category", { category: "" }], ["category with space", { category: "docs. create" }],
    ["category with newline", { category: "docs.create\n" }], ["three secondary categories", { secondaryCategories: ["a.b", "c.d", "e.f"] }],
  ];
  for (const [label, over] of invalid) it(`rejects: ${label}`, () => {
    const index = new CapabilityIndex();
    assert.throws(() => index.upsert(e("x", over)), /invalid capability entry/);
    assert.deepEqual(index.search("").map(h => h.entry.id), [], "nothing was stored");
  });

  it("accepts every documented kind, effect and risk value", () => {
    const index = new CapabilityIndex(); let n = 0;
    for (const kind of ["tool", "skill", "mcp-tool", "extension", "plugin-command", "channel-action"] as const) index.upsert(e(`k${n++}`, { kind }));
    for (const effect of ["read", "local-write", "local-destructive", "external", "money"] as const) index.upsert(e(`k${n++}`, { effect }));
    for (const risk of ["low", "medium", "high", "critical"] as const) index.upsert(e(`k${n++}`, { risk }));
    assert.equal(index.search("", { limit: 128 }).length, n);
  });

  it("accepts a category with digits and hyphens after the first letter", () => {
    new CapabilityIndex().upsert(e("x", { category: "a1-b.c2-d" }));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - secondary categories are not format-checked and a registered entry may carry up to two of any string", () => {
    const index = new CapabilityIndex();
    index.upsert(e("x", { secondaryCategories: ["NOT A CATEGORY", ""] }));
    assert.equal(index.search("", { category: "NOT A CATEGORY" }).length, 1);
  });

  it("stores a frozen deep copy: later changes to the caller's object are not seen, hits cannot be mutated", () => {
    const index = new CapabilityIndex();
    const source = e("x", { secondaryCategories: ["a.b"] });
    index.upsert(source);
    source.description = "changed afterwards"; (source.secondaryCategories as string[])[0] = "z.z";
    const hit = index.search("")[0]!;
    assert.equal(hit.entry.description, "Create a document report"); assert.deepEqual(hit.entry.secondaryCategories, ["a.b"]);
    assert.throws(() => { (hit.entry as { description: string }).description = "x"; }, TypeError);
    assert.throws(() => { (hit.entry.secondaryCategories as string[]).push("c.d"); }, TypeError);
  });

  it("the same id replaces the previous entry", () => {
    const index = new CapabilityIndex();
    index.upsert(e("x", { description: "alpha one" })); index.upsert(e("x", { description: "beta two", version: "2" }));
    const hits = index.search("");
    assert.equal(hits.length, 1); assert.equal(hits[0]!.entry.version, "2");
    assert.equal(index.search("alpha")[0]!.reasons[0], "fallback:no lexical overlap");
  });

  it("remove deletes; removing an unknown id is a no-op", () => {
    const index = new CapabilityIndex(); index.upsert(e("x")); index.remove("nope"); assert.equal(index.search("").length, 1);
    index.remove("x"); assert.equal(index.search("").length, 0);
  });
});

describe("CapabilityIndex.search", () => {
  it("limit must be an integer 0..128; 0 returns nothing; default is 12", () => {
    const index = new CapabilityIndex(); for (let i = 0; i < 20; i++) index.upsert(e(`e${String(i).padStart(2, "0")}`));
    for (const limit of [-1, 129, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => index.search("x", { limit }), /search limit must be 0\.\.128/, String(limit));
    assert.deepEqual(index.search("x", { limit: 0 }), []);
    assert.equal(index.search("x").length, 12); assert.equal(index.search("x", { limit: 128 }).length, 20); assert.equal(index.search("x", { limit: 3 }).length, 3);
  });

  it("an empty or term-less query lists everything with score 0 in id order and says why", () => {
    const index = new CapabilityIndex(); for (const id of ["b", "a", "C", "B"]) index.upsert(e(id));
    for (const q of ["", "   ", "!!! ???"]) {
      const hits = index.search(q);
      assert.deepEqual(hits.map(h => h.entry.id), ["B", "C", "a", "b"], "code-unit order: upper case before lower case");
      assert.ok(hits.every(h => h.score === 0 && h.reasons.length === 1 && h.reasons[0] === "fallback:no lexical overlap"));
    }
  });

  it("lexical match ranks the matching entry first, case-insensitively, with a lexical:<term> reason", () => {
    const index = new CapabilityIndex();
    index.upsert(e("pdf", { name: "pdf_export", description: "Export documents as PDF files", category: "docs.publish" }));
    index.upsert(e("mail", { name: "mail_send", description: "Send an email message", category: "comm.email" }));
    index.upsert(e("disk", { name: "disk_usage", description: "Show disk usage", category: "ops.system" }));
    for (const q of ["pdf", "PDF", "Pdf files"]) {
      const hits = index.search(q); assert.equal(hits[0]!.entry.id, "pdf", q);
      assert.ok(hits[0]!.score > 0 && hits[0]!.reasons.includes("lexical:pdf"), q);
      assert.ok(hits.slice(1).every(h => h.score === 0 && h.reasons[0] === "fallback:no lexical overlap"));
    }
  });

  it("more occurrences and shorter documents score higher; a rarer term outweighs a common one", () => {
    const index = new CapabilityIndex();
    index.upsert(e("once", { name: "one", description: "report alpha beta gamma delta epsilon zeta" }));
    index.upsert(e("twice", { name: "two", description: "report report alpha beta gamma delta epsilon zeta" }));
    index.upsert(e("short", { name: "short", description: "report" }));
    const ranking = index.search("report").map(h => h.entry.id);
    assert.deepEqual(ranking.slice(0, 2).sort(), ["short", "twice"].sort());
    assert.equal(ranking[2], "once");
    const rare = new CapabilityIndex();
    for (let i = 0; i < 6; i++) rare.upsert(e(`c${i}`, { name: `c${i}`, description: "common words everywhere" }));
    rare.upsert(e("r", { name: "r", description: "common words everywhere zzyzx" }));
    assert.equal(rare.search("common zzyzx")[0]!.entry.id, "r");
  });

  it("repeating a term in the query does not increase its weight", () => {
    const index = new CapabilityIndex(); index.upsert(e("a", { description: "alpha text" })); index.upsert(e("b", { description: "other text" }));
    assert.equal(index.search("alpha")[0]!.score, index.search("alpha alpha ALPHA")[0]!.score);
  });

  it("tokens are Unicode letters/digits/underscore: 'über' is found, punctuation splits, underscores join", () => {
    const index = new CapabilityIndex();
    index.upsert(e("de", { name: "de_tool", description: "Überweisung erstellen" }));
    index.upsert(e("snake", { name: "make_report", description: "does things" }));
    assert.equal(index.search("ÜBERWEISUNG")[0]!.entry.id, "de");
    assert.equal(index.search("make_report")[0]!.entry.id, "snake");
    assert.equal(index.search("things,")[0]!.entry.id, "snake", "trailing punctuation in the query is ignored");
    assert.equal(index.search("make")[0]!.reasons[0], "fallback:no lexical overlap", "characterization: Ist-Verhalten, nicht spezifiziert - underscore joins tokens, so 'make' does not match 'make_report'");
  });

  it("useWhen and inputs take part in matching, notFor does not", () => {
    const index = new CapabilityIndex();
    index.upsert(e("a", { description: "plain", useWhen: "needing spreadsheets", inputs: "csvfile", notFor: "invoices" }));
    index.upsert(e("b", { description: "other" }));
    assert.equal(index.search("spreadsheets")[0]!.entry.id, "a"); assert.ok(index.search("spreadsheets")[0]!.score > 0);
    assert.ok(index.search("csvfile")[0]!.score > 0);
    assert.equal(index.search("invoices")[0]!.score, 0);
  });

  it("filters combine with AND; category matches primary or secondary; reasons record the category filter", () => {
    const index = new CapabilityIndex();
    index.upsert(e("a", { category: "docs.create", kind: "tool", effect: "read", source: "s1" }));
    index.upsert(e("b", { category: "web.fetch", secondaryCategories: ["docs.create"], kind: "skill", effect: "external", source: "s2" }));
    index.upsert(e("c", { category: "docs.read", kind: "tool", effect: "read", source: "s1" }));
    const ids = (f: Parameters<CapabilityIndex["search"]>[1]) => index.search("", f).map(h => h.entry.id);
    assert.deepEqual(ids({ category: "docs.create" }), ["a", "b"]);
    assert.deepEqual(ids({ category: "docs.create", kind: "tool" }), ["a"]);
    assert.deepEqual(ids({ kind: "skill" }), ["b"]); assert.deepEqual(ids({ effect: "external" }), ["b"]); assert.deepEqual(ids({ source: "s1" }), ["a", "c"]);
    assert.deepEqual(ids({ source: "s1", effect: "external" }), []);
    assert.ok(index.search("", { category: "docs.create" }).every(h => h.reasons.includes("category:docs.create")));
    assert.deepEqual(ids({ category: "no.such" }), []);
  });

  it("disabled entries are invisible; enabled:true and absent are both visible", () => {
    const index = new CapabilityIndex();
    index.upsert(e("on", { enabled: true })); index.upsert(e("default")); index.upsert(e("off", { enabled: false }));
    assert.deepEqual(index.search("", { limit: 128 }).map(h => h.entry.id), ["default", "on"]);
    index.upsert(e("off", { enabled: true })); assert.equal(index.search("", { limit: 128 }).length, 3);
  });

  it("the embedding port adds a positive finite score with an 'embedding' reason; zero, negative, NaN and infinite scores are ignored", () => {
    const scores = new Map<string, number>([["a", 0.5], ["b", 0], ["c", -3], ["d", Number.NaN], ["f", Number.POSITIVE_INFINITY]]);
    const seen: string[][] = [];
    const port: EmbeddingPort = { score(_q, entries) { seen.push(entries.map(x => x.id)); return scores; } };
    const index = new CapabilityIndex(port);
    for (const id of ["a", "b", "c", "d", "f"]) index.upsert(e(id)); index.upsert(e("hidden", { enabled: false }));
    const hits = index.search("anything");
    assert.deepEqual(hits.map(h => h.entry.id), ["a", "b", "c", "d", "f"]);
    assert.equal(hits[0]!.score, 0.5); assert.deepEqual(hits[0]!.reasons, ["embedding"]);
    assert.ok(hits.slice(1).every(h => h.score === 0 && h.reasons[0] === "fallback:no lexical overlap"));
    assert.deepEqual(seen, [["a", "b", "c", "d", "f"]], "the port is asked once and sees only the enabled entries");
  });

  it("lexical and embedding scores add up; embedding scores for unknown ids are ignored", () => {
    const index = new CapabilityIndex({ score: () => new Map([["lex", 1], ["ghost", 9]]) });
    index.upsert(e("lex", { description: "needle text" })); index.upsert(e("other", { description: "plain" }));
    const lexOnly = new CapabilityIndex(); lexOnly.upsert(e("lex", { description: "needle text" })); lexOnly.upsert(e("other", { description: "plain" }));
    const hit = index.search("needle")[0]!;
    assert.equal(hit.entry.id, "lex"); assert.ok(Math.abs(hit.score - (lexOnly.search("needle")[0]!.score + 1)) < 1e-9);
    assert.deepEqual(hit.reasons, ["lexical:needle", "embedding"]);
    assert.ok(!index.search("needle").some(h => h.entry.id === "ghost"));
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a throwing embedding port makes search throw (no lexical fallback)", () => {
    const index = new CapabilityIndex({ score: () => { throw new Error("embedder down"); } });
    index.upsert(e("a"));
    assert.throws(() => index.search("x"), /embedder down/);
  });

  it("the ranking does not depend on insertion order (seeded shuffles)", () => {
    const SEED = 0xcab0;
    const rnd = mulberry32(SEED);
    const entries = Array.from({ length: 30 }, (_, i) => e(`id${String(i).padStart(2, "0")}`, { description: `shared words ${i % 3 ? "alpha" : "beta"} item ${i % 5}` }));
    const reference = (() => { const idx = new CapabilityIndex(); for (const x of entries) idx.upsert(x); return idx.search("alpha item", { limit: 128 }).map(h => `${h.entry.id}:${h.score.toFixed(9)}`); })();
    for (let round = 0; round < 40; round++) {
      const order = entries.slice(); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
      const idx = new CapabilityIndex(); for (const x of order) idx.upsert(x);
      assert.deepEqual(idx.search("alpha item", { limit: 128 }).map(h => `${h.entry.id}:${h.score.toFixed(9)}`), reference, `seed=0x${SEED.toString(16)} round=${round}`);
    }
  });

  it("capabilitiesSearch is the same call as index.search", () => {
    const index = new CapabilityIndex(); index.upsert(e("a", { description: "findme" })); index.upsert(e("b"));
    assert.deepEqual(capabilitiesSearch(index, "findme", { limit: 1 }), index.search("findme", { limit: 1 }));
  });
});

describe("CapabilityIndex.route", () => {
  function populated(perCategory: Record<string, number>): CapabilityIndex {
    const index = new CapabilityIndex();
    for (const [category, n] of Object.entries(perCategory)) for (let i = 0; i < n; i++) index.upsert(e(`${category.replace(".", "-")}-${String(i).padStart(2, "0")}`, { category, description: "generic entry" }));
    return index;
  }
  const count = (items: { entry: CapabilityEntry }[], category: string) => items.filter(i => i.entry.category === category).length;

  it("validates its inputs", () => {
    const index = populated({ "a.x": 3 });
    for (const topK of [-1, 129, 1.5, Number.NaN]) assert.throws(() => index.route("q", { "a.x": 1 }, topK), /routing budget must be 0\.\.128/, String(topK));
    for (const conf of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => index.route("q", { "a.x": 1 }, 4, conf), /invalid confidence/, String(conf));
    for (const dist of [{ "a.x": -1 }, { "a.x": Number.NaN }, { "a.x": Number.POSITIVE_INFINITY }, {}, { "a.x": 0 }, { "a.x": 0, "b.y": 0 }]) assert.throws(() => index.route("q", dist), /invalid category distribution/, JSON.stringify(dist));
  });

  it("topK 0 routes nothing", () => {
    assert.deepEqual(populated({ "a.x": 3 }).route("q", { "a.x": 1 }, 0).items, []);
  });

  it("quotas follow the distribution and sum to topK", () => {
    const index = populated({ "a.x": 30, "b.y": 30, "c.z": 30 });
    const r = index.route("generic", { "a.x": .5, "b.y": .3, "c.z": .2 }, 10);
    assert.equal(r.items.length, 10);
    assert.deepEqual([count(r.items, "a.x"), count(r.items, "b.y"), count(r.items, "c.z")], [5, 3, 2]);
  });

  it("only the three largest categories take part, ties broken by name", () => {
    const index = populated({ "a.x": 10, "b.y": 10, "c.z": 10, "d.w": 10 });
    const r = index.route("generic", { "a.x": .25, "b.y": .25, "c.z": .25, "d.w": .25 }, 9);
    assert.equal(count(r.items, "d.w"), 0); assert.equal(r.items.length, 9);
    assert.deepEqual([count(r.items, "a.x"), count(r.items, "b.y"), count(r.items, "c.z")], [3, 3, 3]);
  });

  it("unnormalised weights are normalised; a single category gets the whole budget", () => {
    const index = populated({ "a.x": 20, "b.y": 20 });
    const r = index.route("generic", { "a.x": 30, "b.y": 10 }, 8);
    assert.deepEqual([count(r.items, "a.x"), count(r.items, "b.y")], [6, 2]);
    assert.equal(index.route("generic", { "a.x": 0.0001 }, 8).items.length, 8);
  });

  it("an indivisible budget hands the spare slots to the largest remainders and never exceeds topK", () => {
    const index = populated({ "a.x": 30, "b.y": 30, "c.z": 30 });
    const r = index.route("generic", { "a.x": 1, "b.y": 1, "c.z": 1 }, 10);
    const counts = [count(r.items, "a.x"), count(r.items, "b.y"), count(r.items, "c.z")];
    assert.equal(counts.reduce((a, b) => a + b, 0), 10); assert.deepEqual([...counts].sort(), [3, 3, 4]);
    assert.deepEqual(index.route("generic", { "a.x": 1, "b.y": 1, "c.z": 1 }, 10, 1).items.map(i => i.entry.id), r.items.map(i => i.entry.id), "deterministic");
  });

  it("a category with too few entries is topped up from the rest of the index; unknown categories are ignored", () => {
    const index = populated({ "a.x": 1, "b.y": 1, "c.z": 20 });
    const r = index.route("generic", { "a.x": .5, "b.y": .3, "nonexistent.cat": .2 }, 12);
    assert.equal(r.items.length, 12);
    assert.equal(new Set(r.items.map(i => i.entry.id)).size, 12, "no duplicates");
    assert.equal(count(r.items, "a.x"), 1); assert.equal(count(r.items, "b.y"), 1);
  });

  it("fewer entries than topK returns everything that exists, once", () => {
    const index = populated({ "a.x": 2, "b.y": 1 });
    const r = index.route("generic", { "a.x": 1 }, 50);
    assert.deepEqual(r.items.map(i => i.entry.id).sort(), ["a-x-00", "a-x-01", "b-y-00"]);
  });

  it("an entry in two selected categories (primary and secondary) is returned once", () => {
    const index = new CapabilityIndex();
    index.upsert(e("both", { category: "a.x", secondaryCategories: ["b.y"], description: "generic" }));
    index.upsert(e("only-a", { category: "a.x", description: "generic" })); index.upsert(e("only-b", { category: "b.y", description: "generic" }));
    const ids = index.route("generic", { "a.x": .5, "b.y": .5 }, 6).items.map(i => i.entry.id);
    assert.equal(new Set(ids).size, ids.length); assert.deepEqual(ids.sort(), ["both", "only-a", "only-b"]);
  });

  it("disabled entries are never routed", () => {
    const index = populated({ "a.x": 3 }); index.upsert(e("a-x-off", { category: "a.x", enabled: false, description: "generic entry" }));
    assert.ok(!index.route("generic", { "a.x": 1 }, 10).items.some(i => i.entry.id === "a-x-off"));
  });

  it("low confidence spreads the budget over all chosen categories and adds a hint; confidence 0.5 does not", () => {
    const index = populated({ "a.x": 30, "b.y": 30, "c.z": 30 });
    const dist = { "a.x": .98, "b.y": .01, "c.z": .01 };
    const confident = index.route("generic", dist, 12, .5);
    assert.deepEqual([count(confident.items, "a.x"), count(confident.items, "b.y"), count(confident.items, "c.z")], [12, 0, 0]);
    assert.ok(!("hint" in confident));
    const unsure = index.route("generic", dist, 12, .4);
    assert.deepEqual([count(unsure.items, "a.x"), count(unsure.items, "b.y"), count(unsure.items, "c.z")], [10, 1, 1]);
    assert.match(unsure.hint ?? "", /capabilities\.search/);
  });

  it("caching: an identical repeat is served from cache until the index changes; only the last call is remembered", () => {
    const index = populated({ "a.x": 5, "b.y": 5 });
    const dist = { "a.x": .6, "b.y": .4 };
    const first = index.route("generic", dist, 6); assert.equal(first.cached, false);
    const second = index.route("generic", dist, 6); assert.equal(second.cached, true); assert.deepEqual(second.items, first.items);
    assert.equal(index.route("generic", dist, 5).cached, false, "different topK");
    assert.equal(index.route("generic", dist, 6).cached, false, "the previous call replaced the cache entry");
    assert.equal(index.route("other query", dist, 6).cached, false);
    assert.equal(index.route("other query", { "a.x": .5, "b.y": .5 }, 6).cached, false);
    assert.equal(index.route("other query", { "a.x": .5, "b.y": .5 }, 6, .9).cached, false, "confidence is part of the key");
    index.route("q", dist, 6);
    index.upsert(e("new-one", { category: "a.x" }));
    assert.equal(index.route("q", dist, 6).cached, false, "upsert invalidates");
    index.route("q", dist, 6); index.remove("new-one");
    assert.equal(index.route("q", dist, 6).cached, false, "remove invalidates");
    index.route("q", dist, 6); index.remove("never-existed");
    assert.equal(index.route("q", dist, 6).cached, true, "removing an unknown id changes nothing");
  });

  it("cached results keep their hint and are detached copies", () => {
    const index = populated({ "a.x": 5 });
    const first = index.route("generic", { "a.x": 1 }, 3, .2); first.items.length = 0;
    const second = index.route("generic", { "a.x": 1 }, 3, .2);
    assert.equal(second.cached, true); assert.equal(second.items.length, 3); assert.ok(second.hint);
    second.items[0]!.reasons.push("tampered");
    assert.ok(!index.route("generic", { "a.x": 1 }, 3, .2).items[0]!.reasons.includes("tampered"));
  });

  it("key order of the distribution does not affect the result", () => {
    const index = populated({ "a.x": 5, "b.y": 5 });
    const a = index.route("generic", { "a.x": .6, "b.y": .4 }, 6); const b = index.route("generic", { "b.y": .4, "a.x": .6 }, 6);
    assert.deepEqual(b.items.map(i => i.entry.id), a.items.map(i => i.entry.id)); assert.equal(b.cached, true);
  });
});

describe("CapabilityIndex.connect", () => {
  function port(initial: CapabilityEntry[]) {
    let listener: ((ev: { upsert?: CapabilityEntry; remove?: string }) => void) | undefined; let unsubscribed = 0;
    const p: RegistrationPort = { snapshot: () => initial, subscribe(fn) { listener = fn; return () => { unsubscribed++; listener = undefined; }; } };
    return { port: p, emit: (ev: { upsert?: CapabilityEntry; remove?: string }) => listener?.(ev), unsubscribed: () => unsubscribed, active: () => listener !== undefined };
  }

  it("loads the snapshot, applies live upserts and removals, and stops listening after disconnect", () => {
    const p = port([e("a"), e("b")]); const index = new CapabilityIndex();
    const disconnect = index.connect(p.port);
    assert.deepEqual(index.search("").map(h => h.entry.id), ["a", "b"]);
    p.emit({ upsert: e("c") }); p.emit({ remove: "a" });
    assert.deepEqual(index.search("").map(h => h.entry.id), ["b", "c"]);
    disconnect(); assert.equal(p.unsubscribed(), 1); assert.equal(p.active(), false);
    p.emit({ upsert: e("d") });
    assert.equal(index.search("").length, 2);
  });

  it("an invalid pushed entry is rejected by the index (the event handler throws, the index is unchanged)", () => {
    const p = port([e("a")]); const index = new CapabilityIndex(); index.connect(p.port);
    assert.throws(() => p.emit({ upsert: e("bad", { risk: "nuclear" as never }) }), /invalid capability entry/);
    assert.deepEqual(index.search("").map(h => h.entry.id), ["a"]);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - one invalid snapshot entry makes connect() throw after the earlier entries were already loaded and without subscribing", () => {
    const p = port([e("good"), e("bad", { kind: "nope" as never }), e("later")]); const index = new CapabilityIndex();
    assert.throws(() => index.connect(p.port), /invalid capability entry/);
    assert.deepEqual(index.search("").map(h => h.entry.id), ["good"]); assert.equal(p.active(), false);
  });
});

describe("category taxonomy", () => {
  it("is a frozen, duplicate-free list of ids that the index accepts, with a stable serialised prefix", () => {
    assert.ok(Object.isFrozen(CATEGORIES)); assert.ok(CATEGORIES.every(c => Object.isFrozen(c)));
    const ids = CATEGORIES.map(c => c.id);
    assert.equal(new Set(ids).size, ids.length);
    const index = new CapabilityIndex();
    for (const c of CATEGORIES) { assert.doesNotThrow(() => index.upsert(e(`cat-${c.id}`, { category: c.id })), c.id); assert.equal(c.description, c.id.replace(".", ": ")); }
    assert.equal(CATEGORY_PREFIX, JSON.stringify(CATEGORIES));
    assert.equal(new CapabilityIndex().categoriesPrefix(), CATEGORY_PREFIX);
  });

  it("contains the categories the rule-based triage can assign", () => {
    const ids = new Set(CATEGORIES.map(c => c.id));
    for (const id of ["web.research", "web.browse", "docs.create", "code.edit", "code.review", "files.manage", "ops.system", "data.analyse", "comm.email", "media.image", "memory.manage", "general.chat"]) assert.ok(ids.has(id), id);
  });
});

describe("SqliteCapabilityRegistry", () => {
  const tmp = useTempDirs();
  const open = () => new SqliteCapabilityRegistry(path.join(tmp(), "index.sqlite"));

  it("starts empty; snapshot is ordered by id", () => {
    const r = open();
    try {
      assert.deepEqual(r.snapshot(), []);
      r.upsert(e("b")); r.upsert(e("a")); r.upsert(e("C"));
      assert.deepEqual(r.snapshot().map(x => x.id), ["C", "a", "b"]);
    } finally { r.close(); }
  });

  it("validates before writing: an invalid entry throws and leaves no row", () => {
    const r = open();
    try {
      assert.throws(() => r.upsert(e("x", { category: "bad" })), /invalid capability entry/);
      assert.deepEqual(r.snapshot(), []);
    } finally { r.close(); }
  });

  it("notifies on a changed upsert (with a copy) and on a removal, not on an identical upsert or an unknown removal", () => {
    const r = open();
    try {
      const events: { upsert?: CapabilityEntry; remove?: string }[] = [];
      const off = r.subscribe(ev => events.push(ev));
      const first = e("x"); r.upsert(first); r.upsert({ ...first });
      assert.equal(events.length, 1); assert.notEqual(events[0]!.upsert, first); assert.deepEqual(events[0]!.upsert, first);
      r.upsert({ ...first, version: "2" }); assert.equal(events.length, 2);
      r.remove("unknown"); assert.equal(events.length, 2);
      r.remove("x"); assert.deepEqual(events[2], { remove: "x" });
      off(); r.upsert(e("y")); assert.equal(events.length, 3);
    } finally { r.close(); }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - change detection compares the serialised text, so a different property order counts as a change", () => {
    const r = open();
    try {
      let n = 0; r.subscribe(() => { n++; });
      const a = e("x"); r.upsert(a);
      const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as CapabilityEntry; r.upsert(reordered);
      assert.equal(n, 2);
    } finally { r.close(); }
  });

  it("a throwing subscriber surfaces its error after the row has been written", () => {
    const r = open();
    try {
      r.subscribe(() => { throw new Error("listener failed"); });
      assert.throws(() => r.upsert(e("x")), /listener failed/);
      assert.deepEqual(r.snapshot().map(x => x.id), ["x"]);
    } finally { r.close(); }
  });

  it("persists across reopen, including version updates", () => {
    const file = path.join(tmp(), "persist.sqlite");
    let r = new SqliteCapabilityRegistry(file);
    r.upsert(e("x", { version: "1" })); r.upsert(e("x", { version: "2", description: "newer" })); r.record("x", "agent", "used"); r.close();
    r = new SqliteCapabilityRegistry(file);
    try {
      const snap = r.snapshot(); assert.equal(snap.length, 1); assert.equal(snap[0]!.version, "2"); assert.equal(snap[0]!.description, "newer");
      assert.equal(r.stats("x", "agent").used, 1);
    } finally { r.close(); }
  });

  it("statistics: per capability and agent, each event on its own counter, unknown capability refused", () => {
    const r = open();
    try {
      r.upsert(e("x")); r.upsert(e("y"));
      for (const ev of ["offered", "offered", "used", "foundBySearch", "succeeded", "succeeded", "succeeded"] as const) r.record("x", "a1", ev);
      r.record("x", "a2", "used"); r.record("y", "a1", "offered");
      assert.deepEqual(r.stats("x", "a1"), { offered: 2, used: 1, foundBySearch: 1, succeeded: 3 });
      assert.deepEqual(r.stats("x", "a2"), { offered: 0, used: 1, foundBySearch: 0, succeeded: 0 });
      assert.deepEqual(r.stats("y", "a1"), { offered: 1, used: 0, foundBySearch: 0, succeeded: 0 });
      assert.deepEqual(r.stats("x", "nobody"), { offered: 0, used: 0, foundBySearch: 0, succeeded: 0 });
      assert.deepEqual(r.stats("unknown", "a1"), { offered: 0, used: 0, foundBySearch: 0, succeeded: 0 });
      assert.throws(() => r.record("missing", "a1", "used"), /unknown capability/);
      assert.equal(r.stats("missing", "a1").used, 0, "a refused record leaves no row");
    } finally { r.close(); }
  });

  it("names inherited from Object.prototype are refused as unknown statistics, never reaching SQL", () => {
    const r = open();
    try {
      r.upsert(e("x"));
      for (const ev of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) assert.throws(() => r.record("x", "a", ev as never), /unknown capability statistic/, ev);
    } finally { r.close(); }
  });

  it("unknown event names are refused and change nothing (including names inherited from Object.prototype)", () => {
    const r = open();
    try {
      r.upsert(e("x"));
      for (const ev of ["bogus", "constructor", "__proto__", "toString", "hasOwnProperty", "", "USED"]) assert.throws(() => r.record("x", "a", ev as never), Error, ev);
      assert.deepEqual(r.stats("x", "a"), { offered: 0, used: 0, foundBySearch: 0, succeeded: 0 });
      assert.equal(r.snapshot().length, 1, "tables intact");
    } finally { r.close(); }
  });

  it("ids and agent names are data: quotes, SQL fragments and unicode are stored literally", () => {
    const r = open();
    try {
      const id = "x'); DROP TABLE capability_index; --"; const agent = "ag\"ent'; DELETE FROM capability_stats; --";
      r.upsert(e(id)); r.record(id, agent, "used"); r.record(id, "😀", "used");
      assert.equal(r.snapshot()[0]!.id, id); assert.equal(r.stats(id, agent).used, 1); assert.equal(r.stats(id, "😀").used, 1);
      r.remove(id); assert.deepEqual(r.snapshot(), []);
    } finally { r.close(); }
  });

  it("drives a CapabilityIndex: new, changed, disabled and removed capabilities are routed immediately", () => {
    const r = open();
    try {
      const index = new CapabilityIndex(); const off = index.connect(r);
      r.upsert(e("x", { description: "invoice generator" })); assert.equal(index.search("invoice")[0]!.entry.id, "x");
      r.upsert(e("x", { description: "invoice generator", enabled: false, version: "2" })); assert.deepEqual(index.search("invoice"), []);
      r.upsert(e("x", { description: "receipt printer", version: "3" })); assert.equal(index.search("receipt")[0]!.entry.id, "x");
      r.remove("x"); assert.deepEqual(index.search("receipt"), []);
      off(); r.upsert(e("later")); assert.deepEqual(index.search(""), []);
    } finally { r.close(); }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a tampered database row with an invalid entry makes index.connect() fail while valid rows before it were loaded", () => {
    const file = path.join(tmp(), "tamper.sqlite");
    const r = new SqliteCapabilityRegistry(file); r.upsert(e("a")); r.upsert(e("c")); r.close();
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO capability_index (id,version,entry) VALUES (?,?,?)").run("b", "1", JSON.stringify({ ...e("b"), kind: "weird" }));
    raw.close();
    const again = new SqliteCapabilityRegistry(file);
    try {
      const index = new CapabilityIndex();
      assert.throws(() => index.connect(again), /invalid capability entry/);
      assert.deepEqual(index.search("").map(h => h.entry.id), ["a"]);
    } finally { again.close(); }
  });

  it("close() clears subscribers and makes further use fail", () => {
    const r = open(); let n = 0; r.subscribe(() => { n++; }); r.close();
    assert.throws(() => r.upsert(e("x")));
    assert.equal(n, 0);
  });
});
