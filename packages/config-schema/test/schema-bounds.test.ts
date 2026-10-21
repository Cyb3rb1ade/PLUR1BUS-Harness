import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, defaults, validate } from "../src/index.ts";

/** A pattern bounds the length when it has no `*`, `+` or `{n,}` outside escapes and character classes. */
const boundedPattern = (pattern: string): boolean => !/[*+]|\{\d+,\}/.test(pattern.replace(/\\./g, "").replace(/\[(?:\\.|[^\]\\])*\]/g, "X"));

/** Every number, string and array in the schema that nothing bounds. Maps (`additionalProperties` objects) are not covered here. */
function unbounded(schema: Record<string, any>): string[] {
  const out: string[] = [];
  const visit = (node: any, path: string): void => {
    if (!node || typeof node !== "object") return;
    const types: string[] = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
    if ((types.includes("integer") || types.includes("number")) && !["maximum", "exclusiveMaximum", "const", "enum"].some((k) => k in node)) out.push(`${path}: number without maximum`);
    if (types.includes("string") && !["maxLength", "const", "enum"].some((k) => k in node) && !(typeof node.pattern === "string" && boundedPattern(node.pattern)) && !node.anyOf && !node.oneOf) out.push(`${path}: string without maxLength`);
    if (types.includes("array") && !("maxItems" in node)) out.push(`${path}: array without maxItems`);
    for (const [k, v] of Object.entries<any>(node.properties ?? {})) visit(v, `${path}/${k}`);
    if (node.additionalProperties && typeof node.additionalProperties === "object") visit(node.additionalProperties, `${path}/*`);
    if (node.items && typeof node.items === "object") visit(node.items, `${path}/[]`);
    for (const key of ["oneOf", "anyOf", "allOf"]) (node[key] ?? []).forEach((v: any, i: number) => visit(v, `${path}/${key}${i}`));
  };
  visit(schema, "#");
  return out;
}

const at = (cfg: any, path: string, value: unknown): any => {
  const parts = path.split("."); let cur = cfg;
  for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
  cur[parts.at(-1)!] = value;
  return cfg;
};
const ok = (cfg: unknown) => validate(cfg).ok;

describe("schema bounds", () => {
  it("every number has a maximum, every string a maxLength (or a bounded pattern) and every array a maxItems", () => {
    assert.deepEqual(unbounded(CONFIG_SCHEMA), []);
  });

  it("the check sees an unbounded field (the helper is not vacuous)", () => {
    const found = unbounded({ properties: { n: { type: "integer" }, s: { type: "string" }, a: { type: "array", items: { type: "string", pattern: "^x+$" } }, p: { type: "string", pattern: "^[a-z]{1,8}$" } } });
    assert.deepEqual(found.sort(), ["#/a/[]: string without maxLength", "#/a: array without maxItems", "#/n: number without maximum", "#/s: string without maxLength"].sort());
  });

  const MS = 3_600_000;
  const numbers: [path: string, max: number, siblings?: [string, number][]][] = [
    ["logs.keep", 1000], ["logs.maxBytes", 10_737_418_240], ["core.recall.capChars", 10_000_000],
    ["core.recall.softBudgetMs", MS, [["core.recall.hardBudgetMs", MS]]], ["core.recall.hardBudgetMs", MS],
    ["core.capture.waitMs", MS], ["core.shutdownBudgetMs", MS], ["supervisor.graceMs", MS], ["supervisor.healthIntervalMs", MS],
    ["session.compaction.summaryMaxTokens", 2_000_000], ["session.compaction.maxMessageTokens", 2_000_000], ["session.compaction.prune.keepLastTurns", 1000],
    ["memory.mediaEmbedding.dimensions", 16384], ["memory.mediaEmbedding.video.segmentSec", 3600], ["memory.mediaEmbedding.video.maxFrames", 4096],
    ["memory.mediaEmbedding.audio.segmentSec", 3600], ["memory.mediaEmbedding.audio.maxSeconds", 604_800], ["memory.mediaEmbedding.caption.maxChars", 10_000],
  ];
  for (const [path, max, siblings = []] of numbers) {
    it(`${path} accepts ${max} and refuses ${max + 1}`, () => {
      const build = (v: number) => siblings.reduce((c, [p, x]) => at(c, p, x), at(defaults(), path, v));
      assert.equal(ok(build(max)), true, `${path} = ${max}`);
      assert.equal(ok(build(max + 1)), false, `${path} = ${max + 1}`);
    });
  }

  it("the same media limits apply to a per-agent override", () => {
    const build = (dimensions: number, maxFrames: number) => at(at(defaults(), "agents.bernd.memory.mediaEmbedding.dimensions", dimensions), "agents.bernd.memory.mediaEmbedding.video.maxFrames", maxFrames);
    assert.equal(ok(build(16384, 4096)), true);
    assert.equal(ok(build(16385, 32)), false);
    assert.equal(ok(build(768, 4097)), false);
  });

  it("telegram ids stay inside the integers a JSON number carries exactly", () => {
    const build = (id: number) => at(at(defaults(), "channels.telegram.allowlist", [id]), "channels.telegram.botId", 1);
    assert.equal(ok(build(-1_001_234_567_890)), true);
    assert.equal(ok(build(Number.MAX_SAFE_INTEGER)), true);
    assert.equal(ok(build(2 ** 53)), false);
    assert.equal(ok(build(-(2 ** 53))), false);
    assert.equal(ok(at(defaults(), "channels.telegram.botId", Number.MAX_SAFE_INTEGER)), true);
    assert.equal(ok(at(defaults(), "channels.telegram.botId", 2 ** 53)), false);
  });

  const lists: [path: string, max: number, item: unknown][] = [
    ["auth.openai.federated.args", 128, "--flag"], ["agents.bernd.skills.pinned", 1024, "s"], ["agents.bernd.skills.blocked", 1024, "s"],
    ["media.video.adapters.fal.resolutions", 32, "720p"], ["media.video.adapters.fal.aspects", 32, "16:9"], ["media.video.adapters.fal.fps", 32, 24],
  ];
  for (const [path, max, item] of lists) {
    it(`${path} accepts ${max} entries and refuses ${max + 1}`, () => {
      const build = (n: number) => { const c = at(defaults(), path, Array.from({ length: n }, () => item)); if (path.startsWith("media.video.adapters.fal")) at(c, "media.video.adapters.fal.model", "m"); return c; };
      assert.equal(ok(build(max)), true, path);
      assert.equal(ok(build(max + 1)), false, path);
    });
  }

  const strings: [path: string, max: number, prefix?: [string, unknown][]][] = [
    ["auth.openai.federated.command", 4096], ["auth.openai.federated.file", 4096], ["modelRoles.chat", 256], ["$schema", 2048],
    ["engine.baseDbPathOverride", 4096], ["memory.mediaEmbedding.model", 256], ["memory.mediaEmbedding.provider", 128, [["memory.mediaEmbedding.enabled", false]]],
    ["agents.bernd.skills.pinned.0", 128], ["containers.image", 512],
  ];
  for (const [path, max, prefix = []] of strings) {
    it(`${path} accepts ${max} characters and refuses ${max + 1}`, () => {
      // An absolute-looking value where the key names a path, so the value stays valid next to path rules.
      const text = (n: number) => (path === "engine.baseDbPathOverride" ? `/${"a".repeat(n - 1)}` : "a".repeat(n));
      const build = (n: number) => {
        const c: any = prefix.reduce((cfg, [p, v]) => at(cfg, p, v), defaults());
        if (path.endsWith(".0")) return at(c, path.slice(0, -2), [text(n)]);
        return at(c, path, text(n));
      };
      assert.equal(ok(build(max)), true, `${path}: ${max} characters`);
      assert.equal(ok(build(max + 1)), false, `${path}: ${max + 1} characters`);
    });
  }

  it("a value the schema bounds by pattern or format is still refused beyond its length", () => {
    assert.equal(ok(at(defaults(), "containers.bindAddress", "127.0.0.1")), true);
    assert.equal(ok(at(defaults(), "containers.bindAddress", `::${"1".repeat(60)}`)), false);
    assert.equal(ok(at(defaults(), "agents.bernd.createdAt", "2026-09-24T10:20:30.123456789012345-05:30")), true);
    assert.equal(ok(at(defaults(), "agents.bernd.createdAt", `2026-09-24T10:20:30.${"1".repeat(60)}Z`)), false);
  });

  it("the shipped defaults and a generous real-world configuration stay valid", () => {
    assert.equal(ok(defaults()), true);
    const cfg: any = defaults();
    Object.assign(cfg.logs, { maxBytes: 536_870_912, keep: 30 });
    Object.assign(cfg.core.recall, { capChars: 200_000, hardBudgetMs: 120_000, softBudgetMs: 60_000 });
    Object.assign(cfg.session.compaction, { summaryMaxTokens: 128_000, maxMessageTokens: 200_000 });
    Object.assign(cfg.memory.mediaEmbedding, { dimensions: 3072 });
    assert.equal(ok(cfg), true);
  });
});
