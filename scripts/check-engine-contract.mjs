#!/usr/bin/env node
// Compare exported declaration names and qualified methods with the Rust schema.
// Usage: node scripts/check-engine-contract.mjs <types/engine.d.ts> [--schema <schema.json>]
// TypeScript parses declarations so comments, callbacks and nested groups cannot
// be mistaken for top-level methods. Additive A1 and Rust support names are reported.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const DROP_LIST = Object.freeze([
  "HostRuntime", "HostPathOverrides", "pushCriticalButtons", "memoryArchiveDir", "mutateConfig",
  "logger", "configPath", "routing", "clock", "events", "fetch", "tools", "commands", "runCommand",
  "ToolSpec", "CommandSpec", "CommandResult",
]);

const DROPPED_TYPES = new Set(["HostRuntime", "HostPathOverrides", "ToolSpec", "CommandSpec", "CommandResult"]);
// A generic name such as events must only excuse its approved original member.
const DROPPED_MEMBERS = new Map([
  ["HostCapabilities", new Set(["pushCriticalButtons", "memoryArchiveDir"])],
  ["HostServices", new Set(["mutateConfig", "logger", "configPath", "routing", "clock", "events", "fetch"])],
  ["Engine", new Set(["tools", "commands", "runCommand"])],
]);
const DEFAULT_SCHEMA = fileURLToPath(new URL("../crates/plur1bus-engine/schema/engine-contract.schema.json", import.meta.url));
const sorted = (values) => [...new Set(values)].sort();

/** Return exported interface/type names and their own qualified method names. */
export function parseDeclarations(source, filename = "engine.d.ts") {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) {
    const diagnostic = file.parseDiagnostics[0];
    const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new SyntaxError(`declaration syntax error at ${filename}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }

  const declarations = new Map();
  const exports = new Map();
  for (const statement of file.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
    const name = statement.name.text;
    const named = declarations.get(name) ?? [];
    named.push(statement);
    declarations.set(name, named);
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exports.set(name, name);
  }
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const member of statement.exportClause.elements) {
      const original = member.propertyName?.text ?? member.name.text;
      if (declarations.has(original)) exports.set(member.name.text, original);
    }
  }
  if (exports.size === 0) throw new Error(`${filename}: no exported interface or type declarations`);

  function callable(type, seen = new Set()) {
    if (!type) return false;
    if (ts.isFunctionTypeNode(type)) return true;
    if (ts.isParenthesizedTypeNode(type)) return callable(type.type, seen);
    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.some((branch) => callable(branch, seen));
    if (ts.isTypeLiteralNode(type)) return type.members.some(ts.isCallSignatureDeclaration);
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      const name = type.typeName.text;
      if (seen.has(name)) return false;
      const next = new Set(seen).add(name);
      return (declarations.get(name) ?? []).some((declaration) => ts.isTypeAliasDeclaration(declaration)
        ? callable(declaration.type, next)
        : declaration.members.some(ts.isCallSignatureDeclaration));
    }
    return false;
  }

  const methods = new Set();
  function visitType(type, owner) {
    if (!type) return;
    if (ts.isTypeLiteralNode(type)) visitMembers(type.members, owner);
    else if (ts.isParenthesizedTypeNode(type)) visitType(type.type, owner);
    else if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
      for (const branch of type.types) visitType(branch, owner);
    } else if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && ["Readonly", "Partial", "Required"].includes(type.typeName.text)) {
      // These mapped wrappers preserve the member names of an inline object.
      visitType(type.typeArguments?.[0], owner);
    }
  }
  function visitMembers(members, owner) {
    for (const member of members) {
      if (!member.name) continue;
      const name = ts.isComputedPropertyName(member.name) ? member.name.expression : member.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) {
        throw new Error(`${filename}: unsupported computed contract member ${member.name.getText(file)}`);
      }
      const qualified = `${owner}.${name.text}`;
      if (ts.isMethodSignature(member) || (ts.isPropertySignature(member) && callable(member.type))) methods.add(qualified);
      else if (ts.isPropertySignature(member)) visitType(member.type, qualified);
      // Parameter callbacks and methods on return values are not service methods.
    }
  }
  for (const [exported, original] of exports) {
    for (const declaration of declarations.get(original)) {
      if (ts.isInterfaceDeclaration(declaration)) visitMembers(declaration.members, exported);
      else visitType(declaration.type, exported);
    }
  }
  return { types: sorted(exports.keys()), methods: sorted(methods) };
}

/** Read definition titles and x-methods keys (relative paths under each title). */
export function parseSchema(schema) {
  const definitions = schema?.$defs;
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) throw new Error("contract schema must contain an object $defs");
  if (Object.keys(definitions).length === 0) throw new Error("contract schema $defs is empty");
  const types = new Set();
  const methods = new Set();
  for (const [key, definition] of Object.entries(definitions)) {
    const title = definition?.title;
    if (typeof title !== "string" || !title.trim() || title !== title.trim()) throw new Error(`$defs/${key}: a nonempty title is required`);
    if (types.has(title)) throw new Error(`contract schema has duplicate title ${title}`);
    types.add(title);
    const metadata = definition["x-methods"] ?? [];
    if (typeof metadata !== "object" || metadata === null) throw new Error(`$defs/${key}: x-methods must be an object or array of names`);
    const names = Array.isArray(metadata) ? metadata : Object.keys(metadata);
    for (const name of names) {
      if (typeof name !== "string" || !name.trim() || name !== name.trim() || name.split(".").some((part) => !part)) {
        throw new Error(`$defs/${key}: x-methods contains an invalid method name`);
      }
      methods.add(`${title}.${name}`);
    }
  }
  return { types: sorted(types), methods: sorted(methods) };
}

/** Report both differences; only unapproved omissions fail the contract check. */
export function checkContract(declarations, schema) {
  const original = parseDeclarations(declarations);
  const current = parseSchema(schema);
  const difference = (left, right) => {
    const other = new Set(right);
    return left.filter((name) => !other.has(name));
  };
  const drops = new Set();
  const missingTypes = difference(original.types, current.types).filter((name) => {
    if (!DROPPED_TYPES.has(name)) return true;
    drops.add(name);
    return false;
  });
  const missingMethods = difference(original.methods, current.methods).filter((name) => {
    const [owner, rootMember] = name.split(".");
    const drop = DROPPED_TYPES.has(owner) ? owner : DROPPED_MEMBERS.get(owner)?.has(rootMember) ? rootMember : undefined;
    if (!drop) return true;
    drops.add(drop);
    return false;
  });
  return {
    ok: missingTypes.length === 0 && missingMethods.length === 0,
    missingFromSchema: { types: missingTypes, methods: missingMethods },
    missingFromDeclarations: {
      types: difference(current.types, original.types), methods: difference(current.methods, original.methods),
    },
    drops: sorted(drops),
  };
}

export function main(args = process.argv.slice(2)) {
  const usage = "usage: node scripts/check-engine-contract.mjs <types/engine.d.ts> [--schema <schema.json>]";
  try {
    if (!args[0] || args[0].startsWith("-") || (args.length !== 1 && (args.length !== 3 || args[1] !== "--schema" || !args[2]))) {
      throw new Error(usage);
    }
    const declarations = readFileSync(args[0], "utf8");
    const schema = JSON.parse(readFileSync(args[2] ?? DEFAULT_SCHEMA, "utf8"));
    const report = checkContract(declarations, schema);
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`engine contract check: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
