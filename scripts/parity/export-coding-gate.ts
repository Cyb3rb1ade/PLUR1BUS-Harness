// Coding-gate verdicts from the TypeScript library on an isolated worktree with git and verifier doubles.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodingGate } from "../../packages/core/src/collab/coding-gate.ts";
import { CollabError } from "../../packages/core/src/collab/errors.ts";
import { exporterMain } from "./lib.mjs";

const HEAD = "a".repeat(40);
const manifest = JSON.stringify({ scripts: { format: "f", lint: "l", typecheck: "ty", test: "t" } });
const baseFile = "src/example.ts";
const networkConfig = ".plur1bus-verifiers.json";
const networkManifest = JSON.stringify({
  commands: { format: ["fixture-format"], lint: ["fixture-lint"], typecheck: ["fixture-typecheck"], test: ["fixture-test"] },
  networkAllowed: true,
});


async function scenario(name: string) {
  const tmp = mkdtempSync(join(tmpdir(), "p4k-coding-gate-"));
  const root = realpathSync.native(tmp);
  let afterDiff = false, permitReviewer = true;
  const lines = name === "threshold below" ? 199 : ["threshold at", "review recorded", "review revoked"].includes(name) ? 200 : 5;
  const toolCalls: Array<{ kind: string; networkAllowed: boolean }> = [];
  const audit: string[] = [];
  const check = new AbortController();
  const command = (args: string[]) => args.join(" ");
  const network = name.startsWith("project network ");
  if (network) writeFileSync(join(root, networkConfig), networkManifest);

  mkdirSync(join(root, "src"));
  writeFileSync(join(root, baseFile), "fixture");
  writeFileSync(join(root, "package.json"), name === "changed convention" ? manifest + " " : manifest);
  const gate = new CodingGate({
    path: ":memory:", audit: (event: { kind?: string }) => audit.push(event.kind ?? ""),
    isLocalReviewer: id => id === "writer" || (permitReviewer && id === "reviewer"),
    git: (_root, args) => {
      switch (command(args)) {
        case "rev-parse --show-toplevel": return root + "\n";
        case "rev-parse HEAD": return HEAD + "\n";
        case "ls-files -z": return "package.json\0" + baseFile + "\0";
        case "ls-files --others --exclude-standard -z": return "";
        case "diff --binary HEAD --": return afterDiff ? "new diff\n" : "fixture diff\n";
        case "diff --numstat HEAD --": return lines + "\t0\t" + baseFile + "\n";
        case "diff --name-only HEAD --": return baseFile + "\n";
        case "show " + HEAD + ":package.json": return manifest;
        case "show " + HEAD + ":" + networkConfig:
          if (network) return networkManifest;
          throw new Error("fixture path unavailable");

        default: throw new Error("fixture path unavailable");
      }
    },
    verifier: {
      async run(_root, cmd, options) {
        toolCalls.push({ kind: cmd.kind, networkAllowed: options.networkAllowed });
        if (name === "changed during verification") afterDiff = true;
        const failed = name === "verifier failure" && cmd.kind === "lint";
        return { ok: !failed, exitCode: failed ? 1 : 0, output: "fixture " + cmd.kind,
          ...(failed ? { reason: "fixture-failure" } : {}) };
      },
    },
  });
  try {
    const snapshot = gate.snapshot(root);
    const task = "project/card";
    const result = await (async () => {
      try {
        if (name === "self review") gate.recordReview(task, snapshot, "writer", "writer");
        if (name === "review of stale tree") gate.recordReview(task, { ...snapshot, treeHash: "stale" }, "reviewer", "writer");
        if (name === "review recorded" || name === "review revoked") gate.recordReview(task, snapshot, "reviewer", "writer");
        if (name === "review revoked") permitReviewer = false;
        const override = name === "override" ? { person: "lead", note: "checked manually" }
          : name === "empty override" ? { person: "lead", note: "   " } : undefined;
        return { ok: await gate.verify({ task, root, signal: check.signal, ...(override ? { override } : {}) }) };
      } catch (e) {
        if (e instanceof CollabError) return { err: { code: e.code, message: e.message } };
        throw e;
      }
    })();
    const divergence = name === "project network unapproved" ? { networkAllowed: false } : undefined;
    return { name, lines, result, audit, toolCalls, ...(divergence ? { divergence } : {}), snapshot:
 { head: snapshot.head, treeHash: snapshot.treeHash,
      changedLines: snapshot.changedLines, files: snapshot.files } };
  } finally {
    gate.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function buildCodingGateVectors() {
  const gate = [];
  for (const name of ["green", "threshold below", "threshold at", "self review", "review of stale tree",
    "review recorded", "review revoked", "changed convention", "changed during verification", "verifier failure", "override", "empty override", "project network approved", "project network unapproved"]) {
    gate.push(await scenario(name));
  }
  return { gate };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildCodingGateVectors });
}
