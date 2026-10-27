import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  DROP_LIST, checkContract, parseDeclarations, parseSchema,
} from "../check-engine-contract.mjs";

const script = fileURLToPath(new URL("../check-engine-contract.mjs", import.meta.url));
const schema = (...definitions) => ({
  $defs: Object.fromEntries(definitions.map(([title, methods = []]) => [
    `definition_${title}`, { title, "x-methods": Object.fromEntries(methods.map((name) => [name, {}])) },
  ])),
});

describe("engine contract declaration parser", () => {
  it("reads exported interfaces and aliases with nested methods, overloads and function properties", () => {
    const source = [
      '/** export interface Imaginary { ignored(): void } */',
      'interface Private { hidden(): void }',
      'type Callback = (value: string) => void;',
      'export type Choice = "{ fake(): void }" | "other";',
      'export declare interface Service {',
      '  readonly callback?: Callback;',
      '  list(): string[]; list(limit: number): string[];',
      '  nested: { "validate"(value: { nope(): void }): Promise<{ ignored(): void }>;',
      '    deeper?: { run: (done: () => void) => void } };',
      '  arrow?: ((value: string) => void) | undefined;',
      '  plain: string;',
      '}',
      'export type Actions = { apply(): void } & { pending: { cancel(): void } };',
      'export declare function factory(): Service;',
    ].join("\r\n");
    assert.deepEqual(parseDeclarations(source), {
      types: ["Actions", "Choice", "Service"],
      methods: [
        "Actions.apply", "Actions.pending.cancel", "Service.arrow", "Service.callback",
        "Service.list", "Service.nested.deeper.run", "Service.nested.validate",
      ],
    });
  });

  it("keeps methods on their declared owner, including referenced services", () => {
    assert.deepEqual(parseDeclarations(`
      export interface Child { validate(): void }
      export interface Parent extends Child { child: Child; own(): void }
    `), {
      types: ["Child", "Parent"], methods: ["Child.validate", "Parent.own"],
    });
  });

  it("supports local export aliases and ignores unexported declarations", () => {
    assert.deepEqual(parseDeclarations(`
      interface Local { run(): void }
      type LocalAlias = { stop(): void };
      interface Hidden { private(): void }
      export { Local as Public, type LocalAlias };
    `), {
      types: ["LocalAlias", "Public"], methods: ["LocalAlias.stop", "Public.run"],
    });
  });

  it("refuses invalid syntax and an empty exported contract", () => {
    assert.throws(() => parseDeclarations("export interface Broken { run(: void }"), /syntax|parse/i);
    assert.throws(() => parseDeclarations("interface Private {}"), /no exported interface or type/i);
  });
});

describe("engine contract schema parser", () => {
  it("uses definition titles and qualified method metadata, allowing additive support definitions", () => {
    const value = schema(["Service", ["list", "nested.validate"]], ["RustSupport"]);
    value.$defs.definition_RustSupport["x-methods"] = ["run"];
    assert.deepEqual(parseSchema(value), {
      types: ["RustSupport", "Service"],
      methods: ["RustSupport.run", "Service.list", "Service.nested.validate"],
    });
  });

  it("fails on absent definitions, missing or duplicate titles and invalid method metadata", () => {
    assert.throws(() => parseSchema({}), /\$defs/);
    assert.throws(() => parseSchema({ $defs: {} }), /empty/i);
    assert.throws(() => parseSchema({ $defs: { WithoutTitle: {} } }), /title/);
    assert.throws(() => parseSchema({ $defs: { a: { title: "Same" }, b: { title: "Same" } } }), /duplicate/i);
    assert.throws(() => parseSchema({ $defs: { a: { title: "Service", "x-methods": "run" } } }), /x-methods/);
  });
});

describe("engine contract drift", () => {
  it("pins exactly the T1 drop list", () => {
    assert.deepEqual([...DROP_LIST].sort(), [
      "HostRuntime", "HostPathOverrides", "pushCriticalButtons", "memoryArchiveDir", "mutateConfig",
      "logger", "configPath", "routing", "clock", "events", "fetch", "tools", "commands", "runCommand",
      "ToolSpec", "CommandSpec", "CommandResult",
    ].sort());
    assert.ok(Object.isFrozen(DROP_LIST));
  });

  it("reports both differences and fails when an original type or method is missing", () => {
    const result = checkContract(`
      export type Removed = string;
      export interface Service { nested: { validate(): void }; list(): void }
    `, schema(["Service", ["list", "nested.renamed"]], ["Additive"]));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFromSchema, { types: ["Removed"], methods: ["Service.nested.validate"] });
    assert.deepEqual(result.missingFromDeclarations, { types: ["Additive"], methods: ["Service.nested.renamed"] });
    assert.deepEqual(result.drops, []);
  });

  it("does not confuse a method in a different nested group with the missing original", () => {
    const result = checkContract(`
      export interface Service { first: { validate(): void }; second: { validate(): void } }
    `, schema(["Service", ["second.validate"]]));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFromSchema.methods, ["Service.first.validate"]);
  });

  it("allows additive A1 types and methods without hiding missing original members", () => {
    const result = checkContract("export interface Service { run(): void }", schema(
      ["Service", ["run", "curation.stats"]], ["CurationStats"], ["Cancel"],
    ));
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingFromDeclarations, {
      types: ["Cancel", "CurationStats"], methods: ["Service.curation.stats"],
    });
  });

  it("collapses intentionally dropped owners and member groups to the exact approved drop names", () => {
    const result = checkContract(`
      export interface HostRuntime { config: { current(): void } }
      export interface HostPathOverrides { override(): void }
      export interface HostCapabilities { pushCriticalButtons(): void; memoryArchiveDir(): string }
      export interface HostServices {
        mutateConfig(): void; logger: { debug(): void }; configPath(): string;
        routing?(): void; clock?: () => number; events: { emit(): void }; fetch?: () => void;
      }
      export interface Engine { tools: unknown[]; commands: unknown[]; runCommand(): void; open(): void }
      export interface ToolSpec {}
      export interface CommandSpec {}
      export type CommandResult = string;
    `, schema(["HostCapabilities"], ["HostServices"], ["Engine", ["open"]]));
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingFromSchema, { types: [], methods: [] });
    assert.deepEqual(result.drops, DROP_LIST.filter((name) => !["tools", "commands"].includes(name)).sort());
  });

  it("does not let approved drop names hide unrelated or deeper members", () => {
    const result = checkContract(`
      export interface Other { events(): void; runCommand(): void; logger(): void }
      export interface HostServices { nested: { clock(): void } }
      export interface Engine { channels: { list(): void } }
    `, schema(["Other"], ["HostServices"], ["Engine"]));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFromSchema.methods, [
      "Engine.channels.list", "HostServices.nested.clock", "Other.events", "Other.logger", "Other.runCommand",
    ]);
    assert.deepEqual(result.drops, []);
  });
});

describe("engine contract CLI", () => {
  function run(source, value, extra = []) {
    const directory = mkdtempSync(join(tmpdir(), "engine-contract-"));
    try {
      const declaration = join(directory, "contract.d.ts");
      const schemaPath = join(directory, "schema.json");
      writeFileSync(declaration, source);
      writeFileSync(schemaPath, JSON.stringify(value));
      return spawnSync(process.execPath, [script, declaration, "--schema", schemaPath, ...extra], { encoding: "utf8" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("returns zero with parseable JSON for approved drops and additions", () => {
    const result = run("export interface Engine { open(): void; runCommand(): void }", schema(
      ["Engine", ["open"]], ["Additive"],
    ));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.drops, ["runCommand"]);
    assert.deepEqual(report.missingFromDeclarations.types, ["Additive"]);
  });

  it("exits one and reports a synthetic mismatch without requiring an installed engine", () => {
    const result = run("export interface Engine { open(): void }", schema(["Engine"]));
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).missingFromSchema.methods, ["Engine.open"]);
  });

  it("fails closed with readable diagnostics for missing arguments, files and malformed schemas", () => {
    const noArgument = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(noArgument.status, 1);
    assert.match(noArgument.stderr, /usage:.*check-engine-contract.*\.d\.ts/i);
    const absent = spawnSync(process.execPath, [script, join(tmpdir(), "missing-engine-contract.d.ts")], { encoding: "utf8" });
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /ENOENT|no such file/i);
    const invalid = run("export interface Engine {}", {});
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /\$defs/);
    const unknown = run("export interface Engine {}", schema(["Engine"]), ["--unknown"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /usage|unknown argument/i);
  });
});
