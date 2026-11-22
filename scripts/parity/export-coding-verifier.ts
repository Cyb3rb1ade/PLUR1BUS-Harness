// Coding verifier conventions recorded from the frozen TypeScript implementation.
import { pathToFileURL } from "node:url";
import { detectVerifiers } from "../../packages/core/src/collab/coding-gate.ts";
import { CollabError } from "../../packages/core/src/collab/errors.ts";
import { exporterMain } from "./lib.mjs";

const manifest = ".plur1bus-verifiers.json";
const commands = { format: ["fmt", "--check"], lint: ["lint"], typecheck: ["types"], test: ["test"] };
const project = (data: unknown) => ({ [manifest]: JSON.stringify(data) });

export function buildCodingVerifierVectors() {
  const samples: [string, Record<string, string>][] = [
    ["node scripts", { "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: {
      "format:check": "first", format: "other", lint: "lint", "check:types": "check", test: "test",
    } }) }],
    ["node fallback", { "package.json": "{}" }],
    ["lock chooses pnpm", { "package.json": "{}", "pnpm-lock.yaml": "lockfileVersion: 9" }],
    ["python", { "pyproject.toml": "[project]" }],
    ["requirements", { "requirements.txt": "fixture\n" }],
    ["cargo", { "Cargo.toml": "[package]" }],
    ["go", { "go.mod": "module fixture" }],
    ["gradle", { "build.gradle.kts": "plugins {}" }],
    ["gradle groovy", { "build.gradle": "plugins {}" }],
    ["first supported toolchain", { "pyproject.toml": "legacy", "package.json": "{}", "Cargo.toml": "[package]" }],
    ["explicit takes priority", { ...project({ commands, networkAllowed: true }), "package.json": "{}" }],
    ["explicit network requires true", project({ commands, networkAllowed: "true" })],
    ["unknown key", project({ commands, extra: true })],
    ["null plan", project(null)],
    ["missing command", project({ commands: { ...commands, test: [] } })],
    ["non-string command", project({ commands: { ...commands, lint: ["lint", 1] } })],
    ["empty argument", project({ commands: { ...commands, lint: ["lint", ""] } })],
    ["NUL argument", project({ commands: { ...commands, lint: ["lint", "zero\0byte"] } })],
    ["too many arguments", project({ commands: { ...commands, test: Array(33).fill("arg") } })],
    ["argument too long", project({ commands: { ...commands, format: ["fmt", "ß".repeat(4097)] } })],
    ["unknown toolchain", { "README.md": "Fixture" }],
    ["malformed JSON", { "package.json": "{" }],
  ];
  return { "verifier-plan": samples.map(([name, files]) => {
    try {
      const result = detectVerifiers(files);
      // Keep fixtures portable. Only Node's synthesized executable path follows the host separator.
      for (const command of result.commands) {
        if (result.toolchain === "node" && command.argv[0]?.startsWith("node_modules")) {
          command.argv[0] = command.argv[0].replaceAll("\\", "/");
        }
      }
      return { name, files, ok: result };
    } catch (e) {
      return { name, files, err: e instanceof CollabError ? { code: e.code, message: e.message } : { raw: true } };
    }
  }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildCodingVerifierVectors });
}
