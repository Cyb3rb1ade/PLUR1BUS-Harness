// Prepare real test dependencies and artifacts. This does not start services or replace the Engine.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./check-toolchain.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
function runCommand(kind, args, { cwd }) {
  const cli = kind === "pnpm" && process.env.npm_execpath?.includes("pnpm") ? process.env.npm_execpath : null;
  const command = kind === "node" || cli ? process.execPath : "pnpm";
  return new Promise((resolve) => {
    const child = spawn(command, cli ? [cli, ...args] : args, {
      cwd, stdio: "inherit", shell: command === "pnpm" && process.platform === "win32",
    });
    child.on("error", error => resolve({ status: null, error }));
    child.on("close", status => resolve({ status }));
  });
}

export async function prepareTests({ root = ROOT, run = runCommand, log = console.log } = {}) {
  const prerequisites = fileURLToPath(new URL("./test-prerequisites.mjs", import.meta.url));
  const steps = [
    { name: "install", kind: "pnpm", args: ["install", "--frozen-lockfile"] },
    { name: "gen", kind: "pnpm", args: ["gen"] },
    { name: "build", kind: "pnpm", args: ["build"] },
    ...["audit", "core", "engine"].map(name => ({
      name, kind: "node", args: ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", prerequisites, name, root],
    })),
  ];
  log("test:prep: the frozen workspace install requires read access to the private Engine repository or the cached pinned package. Node 24.21 and pnpm 10 must be on PATH.");
  for (const step of steps) {
    log(`test:prep: ${step.name}`);
    let result;
    try { result = await run(step.kind, step.args, { cwd: root }); }
    catch (error) { result = { status: null, error }; }
    if (result.status !== 0) {
      log(`test:prep: ${step.name} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status ?? "unavailable"})`}.`);
      if (step.name === "install" || step.name === "engine") {
        log("Core integration tests cannot run without the pinned private Engine @cyb3rb1ade/plur1bus-memory. Check network/package access and authenticated read access to its repository, then rerun `pnpm test:prep`. The private dependency remains required.");
      }
      return result.status || 1;
    }
  }
  log("test:prep: TypeScript test prerequisites are ready. Run `pnpm test` or the relevant Cargo tests.");
  return 0;
}

if (isMainModule(process.argv[1], import.meta.url)) process.exitCode = await prepareTests();
