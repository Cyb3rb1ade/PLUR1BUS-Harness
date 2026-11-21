// Parity vectors (mode V) for `skill.load` and `skill.read` (`packages/core/src/toolcall/skill-tools.ts`, P4-K K9b). Each
// scenario is a small file tree, described here and built in a fresh temporary home, and a list of calls; the vector
// keeps the tree, the calls and what TypeScript answered (the result's JSON text, or the refusal's code). The Rust replay
// (`crates/plur1bus-core/src/toolcall/skill_vectors.rs`) builds the same tree and must answer the same. Trees with
// symlinks or a FIFO are marked `unix`; nothing records an absolute path. Recorded on a system with symlinks and FIFOs.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-skill-tools.ts [--check]
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawOf, str } from "./toolcall-support.ts";
import { createSkillTools } from "../../packages/core/src/toolcall/skill-tools.ts";
import { isSecretFileName } from "../../packages/core/src/import/secret-file-names.ts";
import { denyEntriesFor } from "../../packages/core/src/host-tools/denylist.ts";

/** A node: `[path, "dir"]`, `[path, "file", content]` (a string spec of `rawOf`, or `{ hex }` for bytes that are not
 *  UTF-8), `[path, "link", target]` (relative target) or `[path, "fifo"]`. */
type Node = [string, "dir" | "file" | "link" | "fifo", unknown?];
interface Scenario { name: string; unix?: boolean; nodes: Node[]; admitted: string[]; calls: [("load" | "read"), unknown, boolean?][] }

const SKILL = "---\r\nname: reports\r\ndescription: Quarterly reports\r\n---\r\n# Reports\r\nUse the reporting workflow.\r\n";
const R = "skills/reports/";
const BASE: Node[] = [[R + "SKILL.md", "file", SKILL], [R + "references/zebra.txt", "file", "Zebra reference"], [R + "references/alpha.txt", "file", "Alpha reference"], [R + "workflow.sh", "file", "#!/bin/sh\nexit 42\n"]];
const CREDENTIALS = [".env", "id_rsa", "credentials.json", ".ssh/config", "keys/server.pem", ".env.production", "auth.json", "ID_RSA.pub", "deploy.KEY", ".gnupg/x", "credentials", "auth-profiles.json", "a/.netrc/b", "id_dsa", ".ENV.LOCAL", "x.pem.txt", "env", ".envrc", "keys.json", ".npmrc", ".pypirc"];
const read = (path: unknown, aborted?: boolean): ["read", unknown, boolean?] => ["read", { name: "reports", path }, aborted];
const load = (args: unknown = { name: "reports" }, aborted?: boolean): ["load", unknown, boolean?] => ["load", args, aborted];

const PATHS: unknown[] = ["SKILL.md", "references/alpha.txt", "workflow.sh", "../secret", "references/../../secret", "/etc/passwd", "C:/Users/private", "C:\\private", "c:x", "1:x",
  "references/./alpha.txt", "references//alpha.txt", "references\\..\\secret", "references/alpha.txt\u0000", "references/alpha.txt\u007f", "references/alpha.txt\u001f", "references/alpha.txt\u0085",
  "", ".", "..", "references", "references/", "/references/alpha.txt", "nope.txt", "references/alpha.txt/x", "REFERENCES/alpha.txt", "references/ALPHA.txt", " references/alpha.txt", "SKILL.md ",
  5, null, true, ["SKILL.md"], { p: 1 }, "a" + String.fromCharCode(0xd800), String.fromCharCode(0xdc00) + ".env"];

const SCENARIOS: Scenario[] = [
  { name: "base", nodes: BASE, admitted: ["reports"], calls: [
    load(), load({ name: "private" }), load({ name: "Reports" }), load({ name: "reports", path: "../x" }), load({ name: "" }), load({ name: 5 }), load(null), load(undefined), load("reports"), load(["reports"]),
    load({ name: "reports" }, true), read("SKILL.md", true),
    ...PATHS.map(p => read(p)), ["read", { name: "private", path: "SKILL.md" }], ["read", { name: "reports" }], ["read", null],
  ] },
  { name: "credentials", nodes: [...BASE, ...CREDENTIALS.map((p): Node => [R + p, "file", `SECRET ${p}`])], admitted: ["reports"], calls: [load(), ...CREDENTIALS.map(p => read(p)), read("keys/../.env"), read(".ssh"), read("x\\.env")] },
  { name: "limits", nodes: [...BASE, [R + "limit.txt", "file", { gen: ["", "x", 64 * 1024, ""] }], [R + "large.txt", "file", { gen: ["", "x", 64 * 1024 + 1, ""] }],
    [R + "utf8.txt", "file", { hex: "61ff62c3a9e282ac" }], [R + "bom.txt", "file", "\uFEFFbom"], [R + "multi.txt", "file", { gen: ["", "é", 32 * 1024, ""] }], [R + "multi1.txt", "file", { gen: ["", "é", 32 * 1024, "x"] }]],
    admitted: ["reports"], calls: [read("limit.txt"), read("large.txt"), read("utf8.txt"), read("bom.txt"), read("multi.txt"), read("multi1.txt"), load()] },
  { name: "big-skill", nodes: [[R + "SKILL.md", "file", { gen: ["", "x", 64 * 1024 + 1, ""] }]], admitted: ["reports"], calls: [load(), read("SKILL.md")] },
  { name: "many-files", nodes: [...BASE, ...Array.from({ length: 80 }, (_, i): Node => [R + `${String(i).padStart(2, "0")}-${"x".repeat(220)}`, "file", "x"])], admitted: ["reports"], calls: [load(), read("00-" + "x".repeat(220))] },
  { name: "count-files", nodes: [...BASE, ...Array.from({ length: 1020 }, (_, i): Node => [R + `f/${i}`, "file", ""])], admitted: ["reports"], calls: [load()] },
  { name: "count-files-over", nodes: [...BASE, ...Array.from({ length: 1021 }, (_, i): Node => [R + `f/${i}`, "file", ""])], admitted: ["reports"], calls: [load()] },
  { name: "deep-32", nodes: [[R + "SKILL.md", "file", "body"], [R + Array.from({ length: 32 }, () => "d").join("/") + "/f.txt", "file", "deep"]], admitted: ["reports"], calls: [load(), read(Array.from({ length: 32 }, () => "d").join("/") + "/f.txt")] },
  { name: "deep-33", nodes: [[R + "SKILL.md", "file", "body"], [R + Array.from({ length: 33 }, () => "d").join("/") + "/f.txt", "file", "deep"]], admitted: ["reports"], calls: [load()] },
  { name: "front-matter", nodes: [
    ["skills/a/SKILL.md", "file", "---\nx: 1\n---\nbody"], ["skills/b/SKILL.md", "file", "\uFEFF---\r\nx\r\n---\r\nbody"], ["skills/c/SKILL.md", "file", "---\n---\nbody"], ["skills/d/SKILL.md", "file", "---\nx\n---"],
    ["skills/e/SKILL.md", "file", "---\nx\n---body"], ["skills/f/SKILL.md", "file", " ---\nx\n---\nbody"], ["skills/g/SKILL.md", "file", "---\nx\n---\n---\ny\n---\nz"], ["skills/h/SKILL.md", "file", "---\rx\r---\rbody"],
    ["skills/i/SKILL.md", "file", "---\nx\u2028\n---\nbody"], ["skills/j/SKILL.md", "file", "\uFEFF\uFEFF---\nx\n---\nbody"], ["skills/k/SKILL.md", "file", "---\n\n---\n\nbody"], ["skills/l/SKILL.md", "file", ""],
  ], admitted: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"], calls: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map(name => load({ name })) },
  { name: "names", nodes: [["skills/a.b-c_d/SKILL.md", "file", "x"], ["skills/0/SKILL.md", "file", "x"], ["skills/" + "a".repeat(64) + "/SKILL.md", "file", "x"], ["skills/" + "a".repeat(65) + "/SKILL.md", "file", "x"], ["skills/-a/SKILL.md", "file", "x"], ["skills/.a/SKILL.md", "file", "x"], ["skills/a b/SKILL.md", "file", "x"], ["skills/plain/SKILL.md", "dir"], ["skills/nofile/x", "file", "x"], ["skills/notdir", "file", "x"], ["skills/Upper/SKILL.md", "file", "x"], ["skills/up_per/SKILL.md", "file", "x"]],
    admitted: ["a.b-c_d", "0", "a".repeat(64), "a".repeat(65), "-a", ".a", "a b", "plain", "nofile", "notdir", "absent", "Upper", "up_per"],
    calls: ["a.b-c_d", "0", "a".repeat(64), "a".repeat(65), "-a", ".a", "a b", "plain", "nofile", "notdir", "absent", "Upper", "up_per"].map(name => load({ name })) },
  { name: "unicode", nodes: [[R + "SKILL.md", "file", "x"], [R + "ü.txt", "file", "u"], [R + "Z.txt", "file", "z"], [R + "a.txt", "file", "a"], [R + "😀.txt", "file", "e"], [R + "\uFF41.txt", "file", "w"], [R + "é/x.txt", "file", "e"]], admitted: ["reports"], calls: [load(), read("ü.txt"), read("😀.txt")] },
  { name: "no-store", nodes: [["other", "dir"]], admitted: ["reports"], calls: [load(), read("SKILL.md"), read(".env")] },
  { name: "links", unix: true, nodes: [...BASE, ["private.txt", "file", "PRIVATE"], [R + "escape.txt", "link", "../../private.txt"], [R + "alias", "link", "references"], [R + "inside.txt", "link", "workflow.sh"], [R + "nonregular", "fifo"]],
    admitted: ["reports"], calls: [load(), read("escape.txt"), read("alias/alpha.txt"), read("inside.txt"), read("nonregular"), read("references/alpha.txt")] },
  { name: "store-link", unix: true, nodes: [["foreign/reports/SKILL.md", "file", SKILL], ["skills", "link", "foreign"]], admitted: ["reports"], calls: [load(), read("SKILL.md")] },
  { name: "root-link", unix: true, nodes: [["foreign/reports/SKILL.md", "file", SKILL], ["skills", "dir"], ["skills/reports", "link", "../foreign/reports"]], admitted: ["reports"], calls: [load(), read("SKILL.md")] },
  { name: "skill-md-link", unix: true, nodes: [[R + "real.md", "file", SKILL], [R + "SKILL.md", "link", "real.md"]], admitted: ["reports"], calls: [load(), read("real.md")] },
];

async function build(home: string, nodes: Node[]): Promise<void> {
  for (const [path, kind, content] of nodes) {
    const target = join(home, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    if (kind === "dir") await mkdir(target, { recursive: true });
    else if (kind === "file") await writeFile(target, (content as any)?.hex ? Buffer.from((content as any).hex, "hex") : String(rawOf(content)));
    else if (kind === "link") await symlink(String(content), target);
    else execFileSync("mkfifo", [target], { timeout: 5000 });
  }
}

async function outcome(tools: ReturnType<typeof createSkillTools>, mode: "load" | "read", args: unknown, aborted?: boolean): Promise<unknown> {
  const tool = tools.find(t => t.name === `skill.${mode}`)!;
  const controller = new AbortController();
  if (aborted) controller.abort();
  try {
    return { ok: str(JSON.stringify(await tool.execute(rawOf(args === undefined ? { undefined: true } : { value: JSON.stringify(args) }) as any, { signal: controller.signal, agentId: "agent", principal: "owner" } as any))) };
  } catch (e: any) {
    return e?.name === "AbortError" ? { aborted: true } : { code: String(e?.code), message: String(e?.message) };
  }
}

export async function buildSkillTools() {
  if (process.platform === "win32") throw new Error("the skill-tools vectors are recorded on a platform with symlinks and FIFOs");
  const scenarios: unknown[] = [];
  for (const s of SCENARIOS) {
    const home = await mkdtemp(join(tmpdir(), "p4k-k9b-skill-"));
    try {
      await build(home, s.nodes);
      const loaded: string[] = [];
      const tools = createSkillTools({ home, skills: s.admitted.map(name => ({ entry: { id: `skill:${name}`, name, description: "d", category: "docs.create", kind: "skill", effect: "read", risk: "low", source: "skills", version: "v" }, text: "" })), onLoad: name => loaded.push(name) });
      const calls: unknown[] = [];
      for (const [mode, args, aborted] of s.calls) calls.push([mode, args === undefined ? { undefined: true } : { value: JSON.stringify(args) }, aborted === true, await outcome(tools, mode, args, aborted)]);
      scenarios.push({ name: s.name, ...(s.unix ? { unix: true } : {}), nodes: s.nodes, admitted: s.admitted, calls, loaded });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
  const tools = createSkillTools({ home: "/unused", skills: [{ entry: { id: "skill:x", name: "x", description: "d", category: "docs.create", kind: "skill", effect: "read", risk: "low", source: "skills", version: "v" }, text: "" }] });
  const NAMES = [...CREDENTIALS.flatMap(p => p.split("/")), "ID_ED25519", "id_ecdsa_sk", "a.Pem", "a.key", "key", ".env.", ".envx", "AUTH.JSON", "İd_rsa", "\u0130D_RSA", "x.pem ", "Credentials.Json", ".pypirc", ".PyPiRc", "\u212Aey.key"];
  const classify = [...PATHS, ...CREDENTIALS, "a\\b\\.env", "a//.ssh//x", "\\\\.netrc", "..\\.env", "x/.ENV", ".\u0130", "\u212A", "Ｅnv", ".e\u0301nv"].map(path => {
    const args = { name: "reports", path };
    return [JSON.stringify(args), JSON.stringify(tools.map(t => t.classify!(rawOf({ value: JSON.stringify(args) }) as any)))];
  });
  return {
    definitions: JSON.stringify(tools),
    denyNames: denyEntriesFor("/", {}, "linux").filter(entry => "name" in entry).map(entry => (entry as { name: string }).name),
    secretNames: NAMES.map(n => [n, isSecretFileName(n)]),
    classify: [...classify, [JSON.stringify(null), JSON.stringify(tools.map(t => t.classify!(null as any)))]],
    scenarios,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await exporterMain({ area: "toolcall", build: async () => ({ "skill-tools": await buildSkillTools() }) }));
