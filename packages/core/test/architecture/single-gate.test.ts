// D109's single path and D120 T1-a: every tool execution in packages/*/src resolves to one of ten executor
// declarations and is allowed only by G1 (ToolDef.execute inside ToolDispatcher.#run or ToolRegistry.register)
// or G2 (raw executors only inside a ToolDef execute, an McpToolPort callTool decorator, McpRegistry.callTool,
// runHostTool, or createHostctl's invoke). See docs/tool-reliability.md ("Single execution path").
// Limits: the scan misses any/unknown values that are then cast, reflective access (Reflect.get, computed keys
// that are not string literals), objects whose type is only structurally compatible with an executor interface,
// and code outside packages/*/src (tests call executors directly on purpose). packages/webmcp is the web page's
// browser-side tools; none of its declarations is in the table. This scan complements ToolDispatcher and does
// not replace the end-to-end tests.
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const rel = (f: string): string => path.relative(ROOT, path.resolve(f)).split(path.sep).join("/");
const PROBE_REL = "packages/core/src/__single_gate_probe__.ts";
const PROBE = path.join(ROOT, ...PROBE_REL.split("/"));

const PROBE_TEXT = `// Virtual probe of single-gate.test.ts (never written to disk). A line ending in "expect: G1" or "expect: G2" must give
// exactly one finding of that rule on that line; every other line must give none.
import type { RegisteredTool, ToolDef } from "./tools/registry.ts";
import type { FsToolSpec } from "./tools/fs/tools.ts";
import type { ExecToolSpec } from "./tools/exec/tool.ts";
import type { ToolSpec } from "./tools/web/tools.ts";
import type { HostTool } from "./host-tools/types.ts";
import type { McpToolPort } from "./tools/mcp-bridge.ts";
import type { McpRegistry } from "./mcp/registry.ts";
import type { McpConnection } from "./mcp/connection.ts";
import type { Hostctl } from "../../hostctl/src/index.ts";
import { runHostTool } from "./host-tools/index.ts";
declare const base: ToolDef, reg: RegisteredTool | undefined, fsSpec: FsToolSpec, execSpec: ExecToolSpec, webSpec: ToolSpec;
declare const host: HostTool, port: McpToolPort, mcp: McpRegistry, conn: McpConnection, hc: Hostctl, x: never;
export const p1 = () => base.execute(x, x); // expect: G1
export const p2 = () => { const f = base.execute; return f; }; // expect: G1
export const p3 = () => { const { execute } = base; return execute; }; // expect: G1
export const p4 = () => base["execute"](x, x); // expect: G1
export const p5 = () => reg?.execute(x, x); // expect: G1
export const p6 = () => base.execute.call(base, x, x); // expect: G1
export const p7 = () => fsSpec.execute(x, x); // expect: G2
export const p8 = () => execSpec.execute(x); // expect: G2
export const p9 = () => webSpec.execute(x, x); // expect: G2
export const p10 = () => host.run(x, x); // expect: G2
export const p11 = () => port.callTool("s", "t", {}, x); // expect: G2
export const p12 = () => mcp.callTool("s", "t", {}, x); // expect: G2
export const p13 = () => conn.callTool("t", {}); // expect: G2
export const p14 = () => hc.invoke("hostctl.sys.info", {}, x); // expect: G2
export const p15 = () => runHostTool("sys.info", {}, x); // expect: G2
export const p16 = { execute: async () => fsSpec.execute(x, x) }; // expect: G2
export const p17: ToolDef = { ...base, classify: async () => { await host.run(x, x); return x; } }; // expect: G2
export const ok1: ToolDef = { ...base, execute: async () => fsSpec.execute(x, x) };
export const ok2: ToolDef = { ...base, async execute() { return host.run(x, x); } };
export const ok3: ToolDef = { ...base, execute: (args) => runHostTool("sys.info", args, x) };
export const ok4: McpToolPort = { ...port, callTool: (s, t, a, c, sig) => port.callTool(s, t, a, c, sig) };
`;

const EXPECTED_IDS = [
  "ToolDef.execute",
  "FsToolSpec.execute",
  "ExecToolSpec.execute",
  "ToolSpec.execute",
  "HostTool.run",
  "McpToolPort.callTool",
  "McpRegistry.callTool",
  "McpConnection.callTool",
  "Hostctl.invoke",
  "runHostTool",
] as const;

const DISPATCHER_FILE = "packages/core/src/tools/dispatcher.ts";
const REGISTRY_FILE = "packages/core/src/tools/registry.ts";
const MCP_REGISTRY_FILE = "packages/core/src/mcp/registry.ts";
const CATALOG_FILE = "packages/core/src/host-tools/catalog.ts";
const HOSTCTL_FILE = "packages/hostctl/src/index.ts";

const ROUTE_MESSAGE = "route the call through a ToolDef registered with the ToolRegistry, or, if it is a new adapter, change §5.4 in this file and docs/tool-reliability.md in the same PR.";

type Rule = "G1" | "G2";
interface TargetInfo {
  rule: Rule;
  id: string;
}

interface MemberSpec {
  id: string;
  rule: Rule;
  file: string;
  owner: string;
  member: string;
}

const MEMBER_SPECS: readonly MemberSpec[] = [
  { id: "ToolDef.execute", rule: "G1", file: "packages/core/src/tools/registry.ts", owner: "ToolDef", member: "execute" },
  { id: "FsToolSpec.execute", rule: "G2", file: "packages/core/src/tools/fs/tools.ts", owner: "FsToolSpec", member: "execute" },
  { id: "ExecToolSpec.execute", rule: "G2", file: "packages/core/src/tools/exec/tool.ts", owner: "ExecToolSpec", member: "execute" },
  { id: "ToolSpec.execute", rule: "G2", file: "packages/core/src/tools/web/tools.ts", owner: "ToolSpec", member: "execute" },
  { id: "HostTool.run", rule: "G2", file: "packages/core/src/host-tools/types.ts", owner: "HostTool", member: "run" },
  { id: "McpToolPort.callTool", rule: "G2", file: "packages/core/src/tools/mcp-bridge.ts", owner: "McpToolPort", member: "callTool" },
  { id: "McpRegistry.callTool", rule: "G2", file: "packages/core/src/mcp/registry.ts", owner: "McpRegistry", member: "callTool" },
  { id: "McpConnection.callTool", rule: "G2", file: "packages/core/src/mcp/connection.ts", owner: "McpConnection", member: "callTool" },
];

let findings: string[] = [];
let locatedIds: string[] = [];
let probeDiagnostics: string[] = [];
let checker: ts.TypeChecker;
const targets = new Map<ts.Node, TargetInfo>();

function sameFile(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function collectSources(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) collectSources(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
}

function rootFiles(): string[] {
  const files: string[] = [];
  const packagesDir = path.join(ROOT, "packages");
  for (const entry of readdirSync(packagesDir)) {
    const src = path.join(packagesDir, entry, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    collectSources(src, files);
  }
  files.sort((a, b) => rel(a).localeCompare(rel(b)));
  files.push(PROBE);
  return files;
}

function compilerOptions(): ts.CompilerOptions {
  const configPath = path.join(ROOT, "tsconfig.base.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(read.error, undefined, read.error ? ts.flattenDiagnosticMessageText(read.error.messageText, "\n") : "");
  const converted = ts.convertCompilerOptionsFromJson(read.config.compilerOptions, ROOT);
  assert.deepEqual(
    converted.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    [],
    "tsconfig.base.json has compiler option errors",
  );
  return { ...converted.options, noEmit: true };
}

function sourceFileByRel(program: ts.Program, file: string): ts.SourceFile | undefined {
  const abs = path.join(ROOT, ...file.split("/"));
  return program.getSourceFile(abs) ?? program.getSourceFiles().find((sf) => sameFile(sf.fileName, abs));
}

function nameText(name: ts.Node | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function memberNodes(sf: ts.SourceFile, owner: string, member: string): ts.Node[] {
  const found: ts.Node[] = [];
  for (const statement of sf.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isClassDeclaration(statement)) continue;
    if (statement.name?.text !== owner) continue;
    for (const item of statement.members) {
      if (item.name && ts.isIdentifier(item.name) && item.name.text === member) found.push(item);
    }
  }
  return found;
}

function hostctlInvokeNodes(sf: ts.SourceFile): ts.Node[] {
  const found: ts.Node[] = [];
  for (const statement of sf.statements) {
    if (!ts.isFunctionDeclaration(statement) || statement.name?.text !== "createHostctl") continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isShorthandPropertyAssignment(node)
        && node.name.text === "invoke"
        && ts.isReturnStatement(node.parent.parent)
      ) found.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(statement, visit);
  }
  return found;
}

function runHostToolNodes(sf: ts.SourceFile): ts.Node[] {
  const found: ts.Node[] = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "runHostTool") found.push(statement);
  }
  return found;
}

function remember(node: ts.Node, info: TargetInfo): void {
  targets.set(node, info);
  locatedIds.push(info.id);
}

function locateTargets(program: ts.Program): void {
  targets.clear();
  locatedIds = [];
  for (const spec of MEMBER_SPECS) {
    const sf = sourceFileByRel(program, spec.file);
    if (!sf) continue;
    for (const node of memberNodes(sf, spec.owner, spec.member)) remember(node, { rule: spec.rule, id: spec.id });
  }
  const hostctl = sourceFileByRel(program, HOSTCTL_FILE);
  if (hostctl) {
    for (const node of hostctlInvokeNodes(hostctl)) remember(node, { rule: "G2", id: "Hostctl.invoke" });
  }
  const catalog = sourceFileByRel(program, CATALOG_FILE);
  if (catalog) {
    for (const node of runHostToolNodes(catalog)) remember(node, { rule: "G2", id: "runHostTool" });
  }
}

function unwrapAlias(symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function targetOf(symbol: ts.Symbol | undefined): TargetInfo | undefined {
  if (!symbol) return undefined;
  const resolved = unwrapAlias(symbol);
  const symbols = [resolved, ...checker.getRootSymbols(resolved)];
  for (const candidate of symbols) {
    for (const declaration of candidate.declarations ?? []) {
      const hit = targets.get(declaration);
      if (hit) return hit;
    }
  }
  return undefined;
}

function namedChain(node: ts.Node): Array<ts.MethodDeclaration | ts.FunctionDeclaration> {
  const chain: Array<ts.MethodDeclaration | ts.FunctionDeclaration> = [];
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) chain.push(current);
  }
  return chain;
}

function classNameOf(node: ts.MethodDeclaration): string | undefined {
  const parent = node.parent;
  if (ts.isClassDeclaration(parent) && parent.name) return parent.name.text;
  return undefined;
}

function innermostIsMethod(node: ts.Node, file: string, expectedFile: string, className: string, method: string): boolean {
  if (file !== expectedFile) return false;
  const inner = namedChain(node)[0];
  return inner !== undefined
    && ts.isMethodDeclaration(inner)
    && nameText(inner.name) === method
    && classNameOf(inner) === className;
}

function objectLiteralNamed(node: ts.Node, member: string): ts.ObjectLiteralExpression | undefined {
  if (!ts.isPropertyAssignment(node) && !ts.isMethodDeclaration(node)) return undefined;
  if (!node.name || nameText(node.name) !== member) return undefined;
  if (!ts.isObjectLiteralExpression(node.parent)) return undefined;
  return node.parent;
}

function contextualPropertyIs(literal: ts.ObjectLiteralExpression, member: string, id: string): boolean {
  const contextual = checker.getContextualType(literal);
  if (!contextual) return false;
  const property = checker.getPropertyOfType(checker.getNonNullableType(contextual), member);
  return targetOf(property)?.id === id;
}

function insideContextualMember(node: ts.Node, member: string, id: string): boolean {
  for (let current = node.parent; current; current = current.parent) {
    const literal = objectLiteralNamed(current, member);
    if (literal && contextualPropertyIs(literal, member, id)) return true;
  }
  return false;
}

function allowed(node: ts.Node, target: TargetInfo, sf: ts.SourceFile): boolean {
  const file = rel(sf.fileName);
  if (target.rule === "G1") {
    return innermostIsMethod(node, file, DISPATCHER_FILE, "ToolDispatcher", "#run")
      || innermostIsMethod(node, file, REGISTRY_FILE, "ToolRegistry", "register");
  }
  if (insideContextualMember(node, "execute", "ToolDef.execute")) return true;
  if (target.id === "McpToolPort.callTool" && insideContextualMember(node, "callTool", "McpToolPort.callTool")) return true;
  if (target.id === "McpConnection.callTool" && innermostIsMethod(node, file, MCP_REGISTRY_FILE, "McpRegistry", "callTool")) {
    return true;
  }
  if (target.id !== "HostTool.run") return false;
  const chain = namedChain(node);
  const inner = chain[0];
  const outer = chain[1];
  if (file === CATALOG_FILE && inner !== undefined && ts.isFunctionDeclaration(inner) && inner.name?.text === "runHostTool") {
    return true;
  }
  return file === HOSTCTL_FILE
    && inner !== undefined
    && outer !== undefined
    && ts.isFunctionDeclaration(inner)
    && inner.name?.text === "invoke"
    && ts.isFunctionDeclaration(outer)
    && outer.name?.text === "createHostctl";
}

function isRunHostToolIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPartOfTypeNode(node)) return false;
  return targetOf(checker.getSymbolAtLocation(node))?.id === "runHostTool";
}

function referenceTarget(node: ts.Node): TargetInfo | undefined {
  if (ts.isPropertyAccessExpression(node)) return targetOf(checker.getSymbolAtLocation(node.name));
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    const property = checker.getPropertyOfType(
      checker.getNonNullableType(checker.getTypeAtLocation(node.expression)),
      node.argumentExpression.text,
    );
    return targetOf(property);
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
      const property = checker.getPropertyOfType(
        checker.getNonNullableType(checker.getTypeAtLocation(node.parent)),
        key.text,
      );
      return targetOf(property);
    }
  }
  if (ts.isIdentifier(node) && isRunHostToolIdentifier(node)) return targetOf(checker.getSymbolAtLocation(node));
  return undefined;
}

function visitFile(sf: ts.SourceFile): void {
  const walk = (node: ts.Node): void => {
    const target = referenceTarget(node);
    if (target && !allowed(node, target, sf)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      findings.push(`${rel(sf.fileName)}:${line} ${target.rule} ${target.id}`);
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const where = diagnostic.file && diagnostic.start !== undefined
    ? `${rel(diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
    : PROBE_REL;
  return `${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
}

function ruleOnly(finding: string): string {
  const parts = finding.split(" ");
  return `${parts[0]} ${parts[1]}`;
}

before(() => {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (sameFile(fileName, PROBE)) return ts.createSourceFile(fileName, PROBE_TEXT, languageVersionOrOptions, true);
    return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => sameFile(fileName, PROBE) || originalFileExists(fileName);
  const program = ts.createProgram({ rootNames: rootFiles(), options, host });
  checker = program.getTypeChecker();
  const probeFile = sourceFileByRel(program, PROBE_REL);
  assert.ok(probeFile, "the virtual probe was not part of the program");
  probeDiagnostics = ts.getPreEmitDiagnostics(program, probeFile).map(formatDiagnostic);
  assert.deepEqual(probeDiagnostics, [], `probe has diagnostics:\n${probeDiagnostics.join("\n")}`);
  locateTargets(program);
  findings = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!/^packages\/[^/]+\/src\//.test(rel(sf.fileName))) continue;
    visitFile(sf);
  }
}, { timeout: 120_000 });

describe("every tool execution passes the dispatcher gate (type-checked, D120 T1-a)", () => {
  it("finds all ten executor declarations", () => {
    const missing = EXPECTED_IDS.filter((id) => !locatedIds.includes(id));
    const counts = new Map<string, number>();
    for (const id of locatedIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const duplicated = [...counts.entries()].filter(([, count]) => count !== 1).map(([id, count]) => `${id} x${count}`);
    assert.deepEqual(missing, [], `missing executor declarations: ${missing.join(", ")}`);
    assert.deepEqual(duplicated, [], `executor declarations must be unique: ${duplicated.join(", ")}`);
    assert.equal(locatedIds.length, EXPECTED_IDS.length);
  });

  it("packages/*/src executes tools only behind ToolDispatcher", () => {
    const real = findings.filter((finding) => !finding.startsWith(`${PROBE_REL}:`));
    assert.deepEqual(real, [], `${ROUTE_MESSAGE}\n${real.join("\n")}`);
  });

  it("catches every seeded bypass in the probe", () => {
    assert.deepEqual(probeDiagnostics, [], `probe has diagnostics:\n${probeDiagnostics.join("\n")}`);
    const expected = PROBE_TEXT.split("\n").flatMap((line, index) => {
      const marker = line.match(/\/\/ expect: (G[12])$/);
      return marker ? [`${PROBE_REL}:${index + 1} ${marker[1]}`] : [];
    });
    const actual = findings.filter((finding) => finding.startsWith(`${PROBE_REL}:`)).map(ruleOnly);
    assert.deepEqual(actual, expected);
  });
});
