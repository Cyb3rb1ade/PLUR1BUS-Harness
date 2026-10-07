import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold, highlight, isSensitiveKey, search, type Entry } from "../src/palette/match.ts";

const e = (id: string, o: Partial<Entry> & { label: string }): Entry => ({ id, group: "setting", labels: [o.label], key: id, to: `/settings?focus=${id}`, ...o });

describe("fold", () => {
  test("lower-cases, strips diacritics, maps ß to ss and keeps an index map to the original", () => {
    assert.equal(fold("Träume").text, "traume");
    assert.equal(fold("Straße").text, "strasse");
    assert.equal(fold("É").text, "e");
    assert.deepEqual(fold("aß").map, [0, 1, 1]);
  });
});

describe("search: matching", () => {
  const entries = [
    e("a", { label: "Soft budget ms", key: "core.recall.softBudgetMs", help: "Time before recall answers early" }),
    e("b", { label: "Log level", key: "core.logLevel" }),
    e("c", { label: "Port", key: "metrics.port", value: "9464", help: "Loopback listener" }),
    e("d", { label: "Erinnerungen & Träume", labels: ["Memories & Dreams", "Erinnerungen & Träume"], key: "/memories", group: "nav", to: "/memories" }),
  ];
  const ids = (q: string): string[] => search(entries, q).map((h) => h.entry.id);

  test("case-insensitive, diacritic-insensitive, substring", () => {
    assert.deepEqual(ids("LOG"), ["b"]);
    assert.deepEqual(ids("traume"), ["d"]);
    assert.deepEqual(ids("trÄume"), ["d"]);
    assert.deepEqual(ids("udget"), ["a"]);
  });
  test("labels of both languages are searchable", () => {
    assert.deepEqual(ids("dreams"), ["d"]);
    assert.deepEqual(ids("erinnerungen"), ["d"]);
  });
  test("multi-word query is an AND over words, in any order, across fields", () => {
    assert.deepEqual(ids("budget soft"), ["a"]);
    assert.deepEqual(ids("recall early"), ["a"]); // key + help
    assert.deepEqual(ids("budget loopback"), []);
  });
  test("key, help and value fields match", () => {
    assert.deepEqual(ids("core.logLevel"), ["b"]);
    assert.deepEqual(ids("listener"), ["c"]);
    assert.deepEqual(ids("9464"), ["c"]);
  });
  test("an empty or blank query lists the navigation only, in index order", () => {
    assert.deepEqual(ids(""), ["d"]);
    assert.deepEqual(ids("   "), ["d"]);
  });
  test("no match, no hits", () => assert.deepEqual(ids("zzz"), []));
});

describe("search: ranking", () => {
  test("label prefix > label part > key > help > value", () => {
    const entries = [
      e("value", { label: "Zeta", key: "z.zeta", value: "port" }),
      e("help", { label: "Yota", key: "y.yota", help: "the port number" }),
      e("key", { label: "Xi", key: "x.port" }),
      e("part", { label: "Network port", key: "n.net" }),
      e("prefix", { label: "Port", key: "p.p" }),
    ];
    assert.deepEqual(search(entries, "port").map((h) => h.entry.id), ["prefix", "part", "key", "help", "value"]);
  });
  test("ties break by folded label, then id; the order does not depend on the input order", () => {
    const a = [e("2", { label: "Beta port" }), e("1", { label: "Alpha port" }), e("3", { label: "Alpha port" })];
    const want = ["1", "3", "2"];
    assert.deepEqual(search(a, "port").map((h) => h.entry.id), want);
    assert.deepEqual(search([...a].reverse(), "port").map((h) => h.entry.id), want);
  });
  test("with several words the weakest word decides the class", () => {
    const entries = [e("one", { label: "Port forwarding", key: "k.one" }), e("two", { label: "Port", key: "k.two", help: "forwarding rules" })];
    assert.deepEqual(search(entries, "port forwarding").map((h) => h.entry.id), ["one", "two"]);
  });
});

describe("highlight", () => {
  const text = (s: string, q: string): string => highlight(s, q).map((x) => (x.hit ? `[${x.text}]` : x.text)).join("");
  test("marks every occurrence of every word, merging overlaps", () => {
    assert.equal(text("Soft budget ms", "bud ms"), "Soft [bud]get [ms]");
    assert.equal(text("abcabc", "ab bc"), "[abcabc]");
  });
  test("maps back through diacritics and ß", () => {
    assert.equal(text("Erinnerungen & Träume", "traume"), "Erinnerungen & [Träume]");
    assert.equal(text("Straße", "sse"), "Stra[ße]");
  });
  test("returns text unchanged without words, and never an empty segment", () => {
    assert.deepEqual(highlight("abc", ""), [{ text: "abc", hit: false }]);
    assert.ok(highlight("abc", "b").every((s) => s.text.length > 0));
  });
  test("hostile text is returned as text only", () => {
    const s = highlight("<img src=x onerror=alert(1)>", "img");
    assert.equal(s.map((x) => x.text).join(""), "<img src=x onerror=alert(1)>");
  });
});

describe("isSensitiveKey", () => {
  test("key, token, secret, password and credential in any segment, any case", () => {
    for (const k of ["providers.openai.apiKey", "x.accessToken", "secrets.store", "auth.PASSWORD", "oauth.credentials", "a.b.Secret"]) assert.equal(isSensitiveKey(k), true, k);
    for (const k of ["core.logLevel", "logs.keep", "metrics.port", "egress.allowHosts"]) assert.equal(isSensitiveKey(k), false, k);
  });
});
