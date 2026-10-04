import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enrich, heuristicKind, loadMetadataTable, lookup, reenrichCatalog } from "../../src/discovery/metadata.ts";
import { emptyCatalog } from "../../src/discovery/types.ts";
import type { CatalogModel } from "../../src/discovery/types.ts";

const bundled = JSON.parse(readFileSync(new URL("../../catalog/model-metadata.json", import.meta.url), "utf8"));
const ids = (section: string): string[] => JSON.parse(readFileSync(new URL(`../fixtures/model-ids/${section}.json`, import.meta.url), "utf8"));
const table = (vendors: Record<string, unknown[]>, revision = "r1") => ({ schema: "plur1bus.model-metadata/1", revision, vendors });
const rule = (pattern: string, extra: Record<string, unknown> = {}) => ({ pattern, kind: "chat", capabilities: [], ...extra });

describe("model metadata table", () => {
  it("every pattern matches at least one known id in fixtures/model-ids/<section>.json", () => {
    const t = loadMetadataTable();
    for (const [section, rules] of t.sections) {
      const vendor = section === "generic" ? undefined : section;
      const known = ids(section);
      for (const { rule: r } of rules) {
        assert.ok(known.some((id) => lookup(t, vendor, id) === r), `no fixture id first-matches ${r.pattern}`);
      }
    }
  });

  it("has no duplicate pattern within or across sections", () => {
    const patterns = Object.values(bundled.vendors as Record<string, { pattern: string }[]>).flat().map((r) => r.pattern);
    assert.equal(new Set(patterns).size, patterns.length);
    assert.throws(() => loadMetadataTable(table({ generic: [rule("^a$"), rule("^a$")] })), /duplicate/);
    assert.throws(() => loadMetadataTable(table({ generic: [rule("^a$")], v: [rule("^a$")] })), /duplicate/);
  });

  it("has no duplicate alias across rules within or across sections", () => {
    assert.throws(
      () => loadMetadataTable(table({ generic: [rule("^a$", { aliases: ["dup-alias"] }), rule("^b$", { aliases: ["dup-alias"] })] })),
      /duplicate alias/,
    );
    assert.throws(
      () => loadMetadataTable(table({ generic: [rule("^a$", { aliases: ["dup-alias"] })], v: [rule("^b$", { aliases: ["dup-alias"] })] })),
      /duplicate alias/,
    );
  });

  it("every pattern is anchored, at most 200 characters and in the RE2-safe subset", () => {
    for (const bad of ["(a)\\1", "(?=x)", "(?<!x)", "(?<n>x)\\k<n>", `^${"a".repeat(200)}$`, "example"]) {
      assert.throws(() => loadMetadataTable(table({ generic: [rule(bad.startsWith("(") ? `^${bad}$` : bad)] })), Error, bad);
    }
    assert.throws(() => loadMetadataTable(table({ generic: [rule("^(a)\\1$")] })), /RE2/);
    assert.doesNotThrow(() => loadMetadataTable(table({ generic: [rule("^example-chat-(large|small)(-\\d{8})?$")] })));
  });

  it("every kind and capability is in the registered vocabulary", () => {
    assert.throws(() => loadMetadataTable(table({ generic: [rule("^a$", { kind: "chatty" })] })), /kind/);
    assert.throws(() => loadMetadataTable(table({ generic: [rule("^a$", { capabilities: ["telepathy"] })] })), /capabilit/);
  });

  it("reports every violation at once", () => {
    try {
      loadMetadataTable(table({ generic: [rule("^a$", { kind: "chatty" }), rule("b")] }));
      assert.fail("should throw");
    } catch (e) {
      assert.match((e as Error).message, /kind/);
      assert.match((e as Error).message, /anchored/);
    }
  });

  it("first match wins, order pinned", () => {
    const a = loadMetadataTable(table({ generic: [rule("^example-chat-.+$"), rule("^example-chat-large$", { kind: "rerank" })] }));
    assert.equal(lookup(a, undefined, "example-chat-large")?.kind, "chat");
    const b = loadMetadataTable(table({ generic: [rule("^example-chat-large$", { kind: "rerank" }), rule("^example-chat-.+$")] }));
    assert.equal(lookup(b, undefined, "example-chat-large")?.kind, "rerank");
  });

  it("the vendor section is tried before generic", () => {
    const t = loadMetadataTable(table({ generic: [rule("^x$", { kind: "embedding" })], v: [rule("^x$".replace("x", "x"), { kind: "tts" })].map((r) => ({ ...r, pattern: "^x.*$" })) }));
    assert.equal(lookup(t, "v", "x")?.kind, "tts");
    assert.equal(lookup(t, undefined, "x")?.kind, "embedding");
    assert.equal(lookup(t, "other", "x")?.kind, "embedding");
  });

  it("an id nothing matches is unknown, not chat", () => {
    const t = loadMetadataTable();
    assert.equal(enrich("zzz-frobnicate", {}, {}, t, undefined).fields.kind, "unknown");
  });

  it("precedence override > API > table > heuristic", () => {
    const t = loadMetadataTable(table({ v: [rule("^m$", { contextWindow: 128000 })] }));
    assert.equal(enrich("m", { contextWindow: 64000 }, { contextWindow: 32000 }, t, "v").fields.contextWindow, 32000);
    assert.equal(enrich("m", { contextWindow: 64000 }, {}, t, "v").fields.contextWindow, 64000);
    assert.equal(enrich("m", {}, {}, t, "v").fields.contextWindow, 128000);
    assert.equal(enrich("m", {}, {}, t, "w").fields.contextWindow, undefined);
    assert.equal(enrich("m", {}, { displayName: "Mine" }, t, "v").fields.displayName, "Mine");
    assert.equal(enrich("m", { displayName: "Api" }, {}, t, "v").fields.displayName, "Api");
    assert.equal(enrich("m", {}, {}, t, "v").fields.displayName, "m");
  });

  it("aliases come from the override, else the table", () => {
    const t = loadMetadataTable();
    assert.deepEqual(enrich("example-chat-large", {}, {}, t, "example-vendor").fields.aliases, ["example-chat-latest"]);
    assert.deepEqual(enrich("example-chat-large", {}, { aliases: ["mine"] }, t, "example-vendor").fields.aliases, ["mine"]);
    assert.deepEqual(enrich("zzz", {}, {}, t, undefined).fields.aliases, []);
  });

  it("heuristicKind", () => {
    assert.equal(heuristicKind("example-whisper"), "asr");
    assert.equal(heuristicKind("example-tts"), "tts");
    assert.equal(heuristicKind("example-image"), "image");
    assert.equal(heuristicKind("example-gpt-live-1"), "realtime");
    assert.equal(heuristicKind("example-rerank-v2"), "rerank");
    assert.equal(heuristicKind("example-chat"), "unknown");
  });

  it("source is table only when the table filled a field", () => {
    const t = loadMetadataTable();
    assert.equal(enrich("example-chat-large", {}, {}, t, "example-vendor").source, "table");
    assert.equal(enrich("example-chat-large", { kind: "chat", contextWindow: 1, capabilities: ["tools"] }, {}, t, "example-vendor").source, "scan");
    assert.equal(enrich("zzz", {}, {}, t, undefined).source, "scan");
  });

  it("reenrichCatalog re-reads table entries only", () => {
    const base = (id: string, source: CatalogModel["source"], extra: Partial<CatalogModel> = {}): CatalogModel => ({
      provider: "p", id, displayName: id, kind: "chat", capabilities: [], aliases: [], status: "available",
      firstSeen: "t", lastSeen: "t", source, overrides: {}, ...extra,
    });
    const next = loadMetadataTable(table({ v: [rule("^.*$", { kind: "embedding", contextWindow: 9 })] }, "r2"));
    const c = { ...emptyCatalog("r1"), models: [
      base("a", "table", { api: {} }),
      base("b", "scan", { api: { kind: "chat" } }),
      base("c", "manual"),
      base("d", "table", { api: {}, overrides: { kind: "tts" }, kind: "tts" }),
    ] };
    const r = reenrichCatalog(c, next, () => "v");
    assert.equal(r.tableRevision, "r2");
    assert.equal(r.models[0]!.kind, "embedding");
    assert.equal(r.models[0]!.contextWindow, 9);
    assert.deepEqual(r.models[1], c.models[1]);
    assert.deepEqual(r.models[2], c.models[2]);
    assert.equal(r.models[3]!.kind, "tts");
    assert.deepEqual(r.models[3]!.overrides, { kind: "tts" });
    assert.equal(c.tableRevision, "r1", "input is not mutated");
  });

  it("enforces resolved alias uniqueness after enrichment, dropping alias from non-winning candidates (F4)", () => {
    const t = loadMetadataTable(
      table({
        v: [
          rule("^example-chat-large(-\\d{8})?$", {
            aliases: ["example-chat-latest"],
          }),
        ],
      })
    );

    const base = (id: string, source: CatalogModel["source"], extra: Partial<CatalogModel> = {}): CatalogModel => ({
      provider: "p", id, displayName: id, kind: "chat", capabilities: [], aliases: [], status: "available",
      firstSeen: "t", lastSeen: "t", source, overrides: {}, ...extra,
    });

    const c = {
      ...emptyCatalog("r1"),
      models: [
        base("example-chat-large", "table", { api: {} }),
        base("example-chat-large-20260101", "table", { api: {} }),
      ],
    };

    const r = reenrichCatalog(c, t, () => "v");

    const mBase = r.models.find((m) => m.id === "example-chat-large")!;
    const mDated = r.models.find((m) => m.id === "example-chat-large-20260101")!;
    assert.deepEqual(mBase.aliases, ["example-chat-latest"]);
    assert.deepEqual(mDated.aliases, []);
  });
});
