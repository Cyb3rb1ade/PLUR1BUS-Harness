/** Actual Rust SSH/SFTP fixture and verified workers; no external daemon or replacement transport. */
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { SftpOptions } from "../src/sftp.ts";
import type { VerifiedWorker } from "../src/worker.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = process.platform === "win32" ? ".exe" : "";
const debug = join(repository, "target", "debug");
let workers: Record<VerifiedWorker["mode"], VerifiedWorker>;

/** The explicit prerequisite builds only the two harness crates, using the shared target and audited lock. */
export async function buildNative(): Promise<void> {
  const child = spawn("cargo", ["build", "--locked", "-j2", "-p", "plur1bus-remote-fs", "-p", "plur1bus",
    "--bins", "--example", "sftp_test_server"], {
    cwd: repository, env: { ...process.env, CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0", CARGO_INCREMENTAL: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostic = "";
  child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-16_384); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`native fixture build failed: ${diagnostic}`)));
  });
  const descriptors = await Promise.all((["standalone", "harness"] as const).map(async mode => {
    const path = join(debug, `${mode === "harness" ? "plur1bus" : "plur1bus-remote-fs"}${suffix}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { path, sha256: hash.digest("hex"), mode };
  }));
  workers = { standalone: descriptors[0]!, harness: descriptors[1]! };
}

/** Holds only generated test key material, never a real account or persisted private-key file. */
export async function fixture(mode: VerifiedWorker["mode"], readDelayMs = 0) {
  const root = await mkdtemp(join(tmpdir(), "p1-sftp-"));
  await mkdir(join(root, "first-home", "nested"), { recursive: true });
  await mkdir(join(root, "second-home"));
  await writeFile(join(root, "first-home", "config.json"), "public-config");
  await writeFile(join(root, "first-home", "nested", "deep"), "x");
  await writeFile(join(root, "second-home", "config.yaml"), "second-config");
  // Directory junctions need no Windows symlink privilege and exercise the same canonical parent escape.
  await symlink(join(root, "second-home"), join(root, "first-home", "escape-parent"), process.platform === "win32" ? "junction" : "dir");
  const pair = generateKeyPairSync("ed25519");
  const privateKey = Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" }));
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  const kind = Buffer.from("ssh-ed25519");
  const publicBlob = Buffer.alloc(4 + kind.length + 4 + 32);
  publicBlob.writeUInt32BE(kind.length);
  kind.copy(publicBlob, 4);
  publicBlob.writeUInt32BE(32, 4 + kind.length);
  publicDer.subarray(-32).copy(publicBlob, 8 + kind.length);
  const server = spawn(join(debug, "examples", `sftp_test_server${suffix}`), [], { stdio: "pipe" });
  let stderr = "";
  server.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const lines = createInterface({ input: server.stdout });
  const ready = await new Promise<{ ip: string; port: number; hostKeySha256: string }>((resolve, reject) => {
    const timer = setTimeout(() => { server.kill("SIGKILL"); reject(new Error("native server startup timeout")); }, 10_000);
    lines.once("line", line => {
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch { reject(new Error("invalid native fixture readiness")); }
    });
    server.once("error", error => { clearTimeout(timer); reject(error); });
    server.once("exit", () => { clearTimeout(timer); reject(new Error(`native fixture exited: ${stderr}`)); });
    server.stdin.write(`${JSON.stringify({ root, authorizedPublicKey: `ssh-ed25519 ${publicBlob.toString("base64")}`, readDelayMs })}\n`);
  });
  let released = 0;
  const leased: Buffer[] = [];
  const options: SftpOptions = { worker: workers[mode], root: "/", endpoint: { ...ready, username: "fixture-user" },
    async leaseKey() {
      const key = Buffer.from(privateKey);
      leased.push(key);
      return { key, release() { released++; } };
    } };
  return { options, root, leased, released: () => released, stderr: () => stderr, privateKey,
    async close() {
      const closed = new Promise<void>(resolve => server.once("close", () => resolve()));
      server.stdin.end();
      const timer = setTimeout(() => server.kill("SIGKILL"), 1000);
      await closed;
      clearTimeout(timer);
      lines.close();
      privateKey.fill(0);
      await rm(root, { recursive: true, force: true });
    } };
}
