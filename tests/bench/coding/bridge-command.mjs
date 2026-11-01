/** Thin command capture for the verifier's no-stdin interface. No expected output or credentials are present. */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const setup = JSON.parse(readFileSync(process.argv[2], "utf8"));
const compilerNames = new Set([
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "GOTOOLCHAIN",
  "GOPROXY",
  "GOSUMDB",
  "CGO_ENABLED",
  "GOMAXPROCS",
  "CARGO_NET_OFFLINE",
]);
const compilerEnv = Object.fromEntries(
  Object.entries(setup.env ?? {}).filter(
    ([name, value]) => compilerNames.has(name) && typeof value === "string" && !value.includes("\0"),
  ),
);
const result = spawnSync(setup.program, setup.args, {
  cwd: setup.cwd,
  env: { ...process.env, ...compilerEnv },
  input: Buffer.from(setup.stdin, "base64"),
  timeout: Number.isSafeInteger(setup.timeoutMs) ? Math.min(60000, Math.max(1, setup.timeoutMs)) : 5000,
  killSignal: "SIGKILL",
  maxBuffer: 16384,
});
process.stdout.write(
  JSON.stringify({
    code: result.status,
    stdout: (result.stdout ?? Buffer.alloc(0)).toString("base64"),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("base64"),
    ...(result.error ? { failed: true } : {}),
  }) + "\n",
);
