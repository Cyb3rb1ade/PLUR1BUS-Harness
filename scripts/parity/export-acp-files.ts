// File-change presentation of the ACP backend (P4-K K8): which completed file tool results become a standard diff and which
// stay labelled text, over the events of a scripted Core. The backend only reads Core events; it never touches a file.
import { INIT, NEW, ev, ins, textPrompt, uuids, type Scenario } from "./export-acp-support.ts";
import { CODE, E, okj, page, rpcOf } from "./export-acp-core-support.ts";

const bytes = (s: string) => Buffer.byteLength(s);
type Item = ["call", string, string, unknown?] | ["result", string, unknown];
const S = (name: string, events: unknown[], rpc: any, extra: Record<string, unknown> = {}): Scenario => ({ name, rpc, events, ids: uuids(4), ...extra });
const ok = (path: string, content: string, over: any = {}) => ({ isError: false, tool: "file.write", value: { rootId: "coding-worktree", path, created: true, bytesWritten: bytes(content), ...over } });

/** Events of one turn: the given tool events in order, then the end of the turn. */
function turnPage(items: Item[]) {
  let seq = 0;
  const events = items.map((it) => (it[0] === "call"
    ? E(++seq, "tool.call", { id: it[1], name: it[2], ...(it[3] !== undefined ? { args: it[3] } : {}) })
    : E(++seq, "tool.result", { id: it[1], output: typeof it[2] === "string" ? it[2] : JSON.stringify(it[2]) })));
  events.push(E(++seq, "turn.completed", {}));
  return page(events);
}
const one = (name: string, items: Item[], root = "/work", extra: Record<string, unknown> = {}) =>
  S(name, [...ins(INIT, NEW(2)), ev.in(textPrompt(3, "c1", "go"))], rpcOf({ methods: CODE, open: [{ ...okj({ state: "open", root }), repeat: true }], pages: [turnPage(items)] }), extra);

export function buildFiles(): Scenario[] {
  const out: Scenario[] = [];
  const W = (id: string, content: unknown, result: unknown, args: any = {}): Item[] => [["call", id, "file.write", { path: "a.txt", content, ...args }], ["result", id, result]];

  out.push(one("write-of-a-new-file-becomes-a-diff", [...W("w1", "hello", ok("a.txt", "hello"))]));
  out.push(one("write-diff-bytes-count-utf8-not-characters", [...W("w1", "é😀", ok("a.txt", "é😀")), ...W("w2", "é😀", ok("a.txt", "é😀", { bytesWritten: 3 })), ...W("w3", "é", ok("a.txt", "é", { bytesWritten: 1 }))]));
  out.push(one("write-diff-empty-and-odd-contents", [...W("w1", "", ok("a.txt", "")), ...W("w2", "line1\r\nline2\n\u2028", ok("a.txt", "line1\r\nline2\n\u2028")), ...W("w3", " ", ok("a.txt", " ")), ...W("w4", "\u0000", ok("a.txt", "\u0000"))]));
  out.push(one("write-without-content-or-with-content-of-the-wrong-type", [["call", "w1", "file.write", { path: "a.txt" }], ["result", "w1", ok("a.txt", "")], ["call", "w2", "file.write", { path: "a.txt", content: 5 }], ["result", "w2", ok("a.txt", "5", { bytesWritten: 5 })],
    ["call", "w3", "file.write", { path: "a.txt", content: null }], ["result", "w3", ok("a.txt", "")], ["call", "w4", "file.write", "text"], ["result", "w4", ok("a.txt", "")], ["call", "w5", "file.write"], ["result", "w5", ok("a.txt", "")], ["call", "w6", "file.write", ["x"]], ["result", "w6", ok("a.txt", "x")]]));
  out.push(one("write-encoding-decides-the-diff", [...W("w1", "x", ok("a.txt", "x"), { encoding: "utf8" }), ...W("w2", "x", ok("a.txt", "x"), { encoding: "UTF8" }), ...W("w3", "x", ok("a.txt", "x"), { encoding: "latin1" }), ...W("w4", "x", ok("a.txt", "x"), { encoding: null }), ...W("w5", "x", ok("a.txt", "x"), { encoding: "utf-8" })]));
  out.push(one("write-result-must-say-created", [...W("w1", "x", ok("a.txt", "x", { created: false })), ...W("w2", "x", ok("a.txt", "x", { created: undefined })), ...W("w3", "x", ok("a.txt", "x", { created: "true" })), ...W("w4", "x", ok("a.txt", "x", { created: 1 })), ...W("w5", "x", ok("a.txt", "x", { bytesWritten: "1" })), ...W("w6", "x", ok("a.txt", "x", { bytesWritten: undefined })), ...W("w7", "x", ok("a.txt", "x", { bytesWritten: 1.0 }))]));
  const top = (over: any) => ({ isError: false, tool: "file.write", ...over });
  out.push(one("write-result-envelope-layers", [
    ...W("w1", "x", top({ rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 })),
    ...W("w2", "x", top({ data: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } })),
    ...W("w3", "x", top({ result: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } })),
    ...W("w4", "x", top({ value: { value: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } } })),
    ...W("w5", "x", top({ value: { data: { result: { value: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } } } } })),
    ...W("w6", "x", top({ value: { data: { result: { value: { data: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } } } } } })),
    ...W("w7", "x", top({ value: null, data: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } })),
    ...W("w8", "x", top({ value: [1], data: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } })),
    ...W("w9", "x", top({ value: 0, data: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } })),
    ...W("w10", "x", top({ value: "", data: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } })),
    ...W("w11", "x", top({ value: false, data: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } })),
    ...W("w12", "x", top({ value: {}, data: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } })),
  ]));
  out.push(one("write-result-root-and-path-forms", [
    ...W("w1", "x", ok("a.txt", "x", { rootId: "other" })), ...W("w2", "x", ok("a.txt", "x", { rootId: undefined })), ...W("w3", "x", ok("a.txt", "x", { rootId: "Coding-Worktree" })),
    ...W("w4", "x", ok("sub/dir/f.txt", "x")), ...W("w5", "x", ok(".hidden/x", "x")), ...W("w6", "x", ok("a b/c d.txt", "x")), ...W("w7", "x", ok("é/ü.txt", "x")), ...W("w8", "x", ok("a.", "x")), ...W("w9", "x", ok("..a", "x")), ...W("w10", "x", ok("a/...", "x")),
  ]));
  const paths = ["", "/abs", "a/", "/a", "a//b", "./a", "../a", "a/../b", "a/./b", "a/..", "..", ".", "a\\b", "a:b", "C:x", "C:/x", "\\\\x\\y", "a\u0000b", "a".repeat(4096), "a".repeat(4097), `${"a/".repeat(2047)}a`, "a/b/", "~/a", "a b ", " a", "a\n", "é\u0301", "con", "a.txt:stream", "a%2e%2e/b", "..%2fa", "....//x", 5, null, ["a"], { p: 1 }, true];
  out.push(one("write-result-path-forms", paths.flatMap((p, i) => W(`p${i}`, "x", ok(p as string, "x")))));
  out.push(one("write-result-paths-that-are-not-strings", [...W("w1", "x", { isError: false, tool: "file.write", value: { rootId: "coding-worktree", created: true, bytesWritten: 1 } }), ...W("w2", "x", { isError: false, tool: "file.write", value: { rootId: "coding-worktree", path: 5, created: true, bytesWritten: 1 } })]));
  out.push(one("write-result-tool-and-call-id-checks", [
    ...W("w1", "x", ok("a.txt", "x", {}) as any), ...W("w2", "x", { ...ok("a.txt", "x"), tool: "file.edit" }), ...W("w3", "x", { ...ok("a.txt", "x"), tool: undefined }), ...W("w4", "x", { ...ok("a.txt", "x"), tool: null }),
    ...W("w5", "x", { ...ok("a.txt", "x"), callId: "w5" }), ...W("w6", "x", { ...ok("a.txt", "x"), callId: "other" }), ...W("w7", "x", { ...ok("a.txt", "x"), callId: null }), ...W("w8", "x", { ...ok("a.txt", "x"), callId: 8 }), ...W("w9", "x", { ...ok("a.txt", "x"), callId: "" }),
  ]));
  out.push(one("write-result-is-error-forms", [
    ...W("w1", "x", { ...ok("a.txt", "x"), isError: true }), ...W("w2", "x", { ...ok("a.txt", "x"), isError: undefined }), ...W("w3", "x", { ...ok("a.txt", "x"), isError: "false" }), ...W("w4", "x", { ...ok("a.txt", "x"), isError: 0 }), ...W("w5", "x", { ...ok("a.txt", "x"), isError: null }),
    ...W("w6", "x", ok("a.txt", "x", { isError: true })), ...W("w7", "x", ok("a.txt", "x", { isError: false })), ...W("w8", "x", ok("a.txt", "x", { isError: "true" })), ...W("w9", "x", ok("a.txt", "x", { isError: 1 })),
  ]));
  const trunc = (name: string, over: any) => ok("a.txt", "x", over);
  out.push(one("write-result-truncation-forms", [
    ...W("t1", "x", trunc("", { truncated: false })), ...W("t2", "x", trunc("", { truncated: true })), ...W("t3", "x", trunc("", { truncated: 0 })), ...W("t4", "x", trunc("", { truncated: null })), ...W("t5", "x", trunc("", { truncated: "" })),
    ...W("t6", "x", trunc("", { truncated: "no" })), ...W("t7", "x", trunc("", { truncated: [] })), ...W("t8", "x", trunc("", { truncated: undefined })), ...W("t9", "x", trunc("", { diffTruncated: true })), ...W("t10", "x", trunc("", { diffTruncated: "true" })),
    ...W("t11", "x", trunc("", { diffTruncated: false })), ...W("t12", "x", trunc("", { meta: { truncated: true } })), ...W("t13", "x", trunc("", { meta: { truncated: "true" } })), ...W("t14", "x", trunc("", { meta: { truncated: false } })), ...W("t15", "x", trunc("", { meta: [] })),
    ...W("t16", "x", { ...ok("a.txt", "x"), truncated: true }), ...W("t17", "x", { ...ok("a.txt", "x"), truncated: 0 }), ...W("t18", "x", { ...ok("a.txt", "x"), diffTruncated: true }), ...W("t19", "x", { ...ok("a.txt", "x"), meta: { truncated: true } }),
  ]));

  // --- results that stay text
  const edit = (id: string, output: unknown, args: any = { path: "a.txt", old: "x", new: "y" }): Item[] => [["call", id, "file.edit", args], ["result", id, output]];
  out.push(one("edit-result-is-text-with-its-patch", [
    ...edit("e1", { isError: false, tool: "file.edit", diff: "--- a\n+++ b\n@@\n-x\n+y" }), ...edit("e2", { unifiedDiff: "-x\n+y" }), ...edit("e3", { diff: null, unifiedDiff: "later" }), ...edit("e4", { diff: 5, unifiedDiff: "after number" }),
    ...edit("e5", { diff: "", unifiedDiff: "ignored" }), ...edit("e6", { value: { diff: "nested" } }), ...edit("e7", { data: { value: { unifiedDiff: "deep" } } }), ...edit("e8", { diff: ["x"] }), ...edit("e9", { diff: "first", value: { diff: "second" } }),
    ...edit("e10", { diff: 1, value: { diff: "from-nested" } }), ...edit("e11", { value: { value: { value: { value: { diff: "layer five" } } } } }), ...edit("e12", { value: { value: { value: { value: { value: { diff: "layer six" } } } } } }),
  ]));
  out.push(one("edit-result-plain-output", [...edit("e1", "plain text result"), ...edit("e2", ""), ...edit("e3", "   "), ...edit("e4", "not json {"), ...edit("e5", "[1,2,3]"), ...edit("e6", "null"), ...edit("e7", "5"), ...edit("e8", "\"diff\""), ...edit("e9", "{\"diff\": \"in a string\"}"), ...edit("e10", "{\"diff\":\"é\u2028\"}")]));
  out.push(one("edit-result-reasons-are-joined", [
    ...edit("e1", { truncated: true, isError: true }), ...edit("e2", { isError: true }), ...edit("e3", { truncated: true }), ...edit("e4", { diffTruncated: true, isError: true, diff: "d" }), ...edit("e5", { value: { isError: true } }), ...edit("e6", { value: { truncated: true }, diff: "d" }),
    ...edit("e7", { isError: false }), ...edit("e8", { meta: { truncated: true }, isError: true }),
  ]));
  out.push(one("write-failures-and-oddities-stay-text", [
    ...W("f1", "x", { isError: true, tool: "file.write", error: "denied" }), ...W("f2", "x", "boom"), ...W("f3", "x", ""), ...W("f4", "x", ok("a.txt", "x", { created: false, diff: "was there" })),
    ...W("f5", "x", { ...ok("a.txt", "x"), diff: "with a patch" }), ...W("f6", "x", [1, 2]), ...W("f7", "x", null), ...W("f8", "x", { isError: false }),
  ]));
  out.push(one("results-of-unknown-calls", [
    ["result", "u1", "plain"], ["result", "u2", { diff: "orphan" }], ["result", "u3", { tool: "file.write" }], ["result", "u4", { tool: "file.edit" }], ["result", "u5", { tool: "web.fetch" }], ["result", "u6", { unifiedDiff: "orphan2" }],
    ["result", "u7", { isError: false, tool: "file.write", value: { rootId: "coding-worktree", path: "a.txt", created: true, bytesWritten: 1 } }], ["result", "u8", { tool: ["file.write"] }], ["result", "u9", { value: { tool: "file.write" } }], ["result", "u10", { diff: 5 }],
  ]));
  out.push(one("results-of-calls-to-other-tools", [["call", "o1", "web.search", { q: "x" }], ["result", "o1", { diff: "x" }], ["call", "o2", "file.read", { path: "a" }], ["result", "o2", "plain"], ["call", "o3", "file.delete", {}], ["result", "o3", { tool: "file.write" }],
    ["call", "o4", "File.Write", {}], ["result", "o4", "x"], ["call", "o5", "file.write ", {}], ["result", "o5", "x"]]));
  out.push(one("a-result-is-used-once", [...W("w1", "x", ok("a.txt", "x")), ["result", "w1", ok("a.txt", "x")], ["result", "w1", "again"]]));
  out.push(one("a-reused-call-id-is-ambiguous", [["call", "d1", "file.write", { path: "a.txt", content: "x" }], ["call", "d1", "file.write", { path: "a.txt", content: "x" }], ["result", "d1", ok("a.txt", "x")],
    ["call", "d2", "file.write", { path: "a.txt", content: "x" }], ["result", "d2", ok("a.txt", "x")], ["call", "d2", "file.write", { path: "a.txt", content: "x" }], ["result", "d2", ok("a.txt", "x")], ["call", "d3", "file.write", { path: "a.txt", content: "x" }], ["call", "d3", "file.edit", {}], ["result", "d3", "x"]]));
  out.push(one("a-reused-call-id-after-a-result", [["call", "d1", "file.write", { path: "a.txt", content: "x" }], ["result", "d1", ok("a.txt", "x")], ["call", "d1", "file.write", { path: "a.txt", content: "x" }], ["result", "d1", ok("a.txt", "x")], ["result", "d1", ok("a.txt", "x")]]));
  out.push(one("call-ids-of-odd-length", [...W("", "x", ok("a.txt", "x")), ...W("i".repeat(256), "x", ok("a.txt", "x")), ...W("i".repeat(257), "x", ok("a.txt", "x")), ...W("é".repeat(256), "x", ok("a.txt", "x")), ...W("é".repeat(257), "x", ok("a.txt", "x")), ...W("😀".repeat(128), "x", ok("a.txt", "x")), ...W("😀".repeat(129), "x", ok("a.txt", "x"))]));
  out.push(one("only-sixteen-calls-are-retained", [...Array.from({ length: 17 }, (_, i): Item => ["call", `r${i}`, "file.write", { path: "a.txt", content: "x" }]), ...Array.from({ length: 17 }, (_, i): Item => ["result", `r${i}`, ok("a.txt", "x")])]));
  out.push(one("retained-calls-are-dropped-oldest-first-even-when-replaced", [...Array.from({ length: 16 }, (_, i): Item => ["call", `r${i}`, "file.write", { path: "a.txt", content: "x" }]), ["call", "r0", "file.write", { path: "a.txt", content: "x" }], ["call", "late", "file.write", { path: "a.txt", content: "x" }], ["result", "r0", ok("a.txt", "x")], ["result", "r1", ok("a.txt", "x")], ["result", "late", ok("a.txt", "x")]]));
  // More than a page of tool events: the seen-set bound of 1024 calls.
  const many: Item[] = Array.from({ length: 1030 }, (_, i): Item => ["call", `m${i}`, "file.write", { path: "a.txt", content: "x" }]);
  const manyResults: Item[] = [["result", "m0", ok("a.txt", "x")], ["result", "m1023", { diff: "known" }], ["result", "m1024", "plain after the bound"], ["result", "m1029", { diff: "orphan after the bound" }], ["result", "m1024", { tool: "file.write" }]];
  out.push(S("at-most-1024-call-ids-are-remembered", [...ins(INIT, NEW(2)), ev.in(textPrompt(3, "c1", "go"))], rpcOf({ methods: CODE, pages: [...[0, 1, 2].map((k) => page(many.slice(k * 400, k * 400 + 400).map((it, i) => E(k * 400 + i + 1, "tool.call", { id: it[1], name: "file.write", args: { path: "a.txt", content: "x" } })), true)), turnPage(manyResults)] })));

  // --- the diff text of a patch
  out.push(one("long-patches-are-clipped-at-a-character-boundary-in-german", [
    ...edit("c1", { diff: "€".repeat(12000) }), ...edit("c2", { diff: "a".repeat(32768) }), ...edit("c3", { diff: "a".repeat(32769) }), ...edit("c4", { diff: `${"a".repeat(32767)}€` }), ...edit("c5", { diff: `${"a".repeat(32766)}😀tail` }), ...edit("c6", { diff: `${"a".repeat(32765)}😀tail` }),
    ...edit("c7", "é".repeat(20000)), ...edit("c8", { diff: "x" }, { path: "a.txt" }),
  ], "/work", { server: { language: "de" } }));
  out.push(one("long-patches-are-clipped-in-english", [...edit("c1", { diff: "€".repeat(12000) }), ...edit("c2", "plain ".repeat(10000))]));
  out.push(one("german-labels", [...W("g1", "x", ok("a.txt", "x")), ...edit("g2", { truncated: true, isError: true, diff: "d" }), ...edit("g3", "plain"), ...edit("g4", { isError: true })], "/work", { server: { language: "de" } }));
  // --- the bound root
  const rootsPaths = ["a.txt", "sub/dir/f.txt"];
  const roots = ["/work", "/work/", "/", "/a/b c", "/work//", "C:\\work", "C:/work", "c:\\w\\x", "C:\\", "C:\\work\\", "\\\\srv\\share\\w", "\\\\srv\\share", "\\\\srv", "//srv/share/w", "work", "", "C:", "C:w", "1:\\x", "/work\u0000x", "/é/ü", "\\work", "/work/.", "/work/../x", "a:\\x", "Z:/x/y"];
  const roots2 = roots.flatMap((r) => rootsPaths.map((p) => [r, p] as const));
  out.push(S("roots-and-the-paths-they-resolve", [...ins(INIT, ...roots2.map((_, i) => NEW(i + 2))), ...roots2.map((_, i) => ev.in(textPrompt(100 + i, `c${i}`, "go")))],
    rpcOf({ methods: CODE, create: roots2.map((_, i) => okj({ session: { id: `c${i}` } })), open: roots2.map(([r]) => okj({ state: "open", root: r })),
      pages: roots2.map(([, p]) => turnPage(W("w", "x", ok(p, "x")))) })));
  out.push(S("roots-the-core-reports-in-odd-forms", [...ins(INIT, NEW(2), NEW(3), NEW(4), NEW(5), NEW(6)), ...[0, 1, 2, 3, 4].map((i) => ev.in(textPrompt(100 + i, `c${i}`, "go")))],
    rpcOf({ methods: CODE, create: [0, 1, 2, 3, 4].map((i) => okj({ session: { id: `c${i}` } })), open: [okj({ state: "open" }), okj({ state: "open", root: null }), okj({ state: "open", root: 5 }), okj({ state: "open", root: ["/w"] }), okj({ state: "open", root: "/work" })],
      pages: [0, 1, 2, 3, 4].map(() => turnPage(W("w", "x", ok("a.txt", "x")))) })));
  out.push(S("without-modes-there-is-no-root", [...ins(INIT, NEW(2)), ev.in(textPrompt(3, "c1", "go"))], rpcOf({ pages: [turnPage(W("w", "x", ok("a.txt", "x")))] })));
  return out;
}

/** The scenarios that carry about 128 KiB of text each live in their own fixture file (no vector file may pass 1 MiB). */
export function buildFilesLarge(): Scenario[] {
  const out: Scenario[] = [];
  const W = (id: string, content: unknown, result: unknown, args: any = {}): Item[] => [["call", id, "file.write", { path: "a.txt", content, ...args }], ["result", id, result]];
  const edit = (id: string, output: unknown, args: any = { path: "a.txt", old: "x", new: "y" }): Item[] => [["call", id, "file.edit", args], ["result", id, output]];
  const big = (n: number) => "a".repeat(n);
  out.push(one("diff-content-limit-is-128-kib", [...W("b1", big(131072), ok("a.txt", big(131072))), ...W("b2", big(131073), ok("a.txt", big(131073))), ...W("b3", "é".repeat(65536), ok("a.txt", "é".repeat(65536))), ...W("b4", "é".repeat(65537), ok("a.txt", "é".repeat(65537)))]));
  out.push(one("oversized-calls-say-so", [...edit("b5", { diff: "d" }, { path: "a.txt", content: big(131073) }), ...W("b6", big(200000), { ...ok("a.txt", "x"), truncated: true, isError: false })]));
  return out;
}
