/** Real private role-i broker. Credentials are generated here and never enter argv, diagnostics or metadata stdout. */
import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { createSecurePath, unitAddress } from "@plur1bus/module-api";
import { createImportSourceSecrets } from "../../src/import/source-secrets.ts";
import { startImportSourceSecretBroker } from "../../src/import/source-secret-broker.ts";
import { openImportWorkerPort } from "../../src/import/worker-port.ts";

function metadata(value) { process.stdout.write(JSON.stringify(value) + "\n"); }

async function worker() {
  const port = await openImportWorkerPort({ input: process.stdin, output: process.stdout });
  const lease = await port.takeSourceSecrets();
  const values = [...lease.entries()].map(([, value]) => value);
  const slots = values.length;
  const hashes = values.map(value => createHash("sha256").update(value).digest("hex"));
  lease.release();
  metadata({ slots, hashes, zeroed: values.every(value => value.every(byte => byte === 0)) });
  await port.close();
}

async function broker(home) {
  const lines = createInterface({ input: process.stdin });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.length > 16_384) throw Error();
  const { job, scenario } = JSON.parse(first.value);
  const binding = { ownerId: job.ownerId, planId: job.planId, planSha256: job.planSha256, preflightId: job.preflightId };
  await mkdir(join(home, "run"), { mode: 0o700 });
  if (!createSecurePath()(join(home, "run"), { mode: 0o700 }).applied) throw Error();
  const token = randomBytes(32).toString("hex");
  await writeFile(join(home, "run", "core.token"), (scenario === "denied" ? randomBytes(32).toString("hex") : token) + "\n", { mode: 0o600 });
  await writeFile(join(home, "run", "core.pid"), `${process.pid} fixture\n`, { mode: 0o600 });
  const input = Buffer.from(`PRIVATE_IMPORT_SOURCE_TEST_${randomBytes(24).toString("hex")}`);
  const valueSha256 = createHash("sha256").update(input).digest("hex");
  const expected = Buffer.from(JSON.stringify({ v: 1, type: "secret-source", runId: job.runId, planId: job.planId,
    preflightId: job.preflightId, entries: { OPENAI_API_KEY: input.toString("utf8") } }) + "\n");
  const frameSha256 = createHash("sha256").update(expected).digest("hex");
  expected.fill(0);
  const secrets = createImportSourceSecrets();
  secrets.prepare({ ...binding, expiresAt: Date.now() + 60_000, entries: new Map([["OPENAI_API_KEY", input]]) });
  let lookups = 0, taken = 0;
  const held = [];
  const observed = { ...secrets, take(value) {
    const lease = secrets.take(value);
    taken++;
    held.push(...[...lease.entries()].map(([, bytes]) => bytes));
    return lease;
  } };
  let instance;
  if (scenario === "oversized") {
    const address = unitAddress(home, "i");
    const server = createServer(socket => {
      socket.on("error", () => {});
      socket.once("data", () => {
        const header = Buffer.alloc(4); header.writeUInt32BE(0xffffffff);
        socket.end(header);
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
    if (process.platform !== "win32" && !createSecurePath()(address).applied) throw Error();
    instance = { address, close: () => new Promise(resolve => server.close(resolve)) };
  } else {
    instance = await startImportSourceSecretBroker({ home, token, secrets: observed, async binding(planId, preflightId) {
      lookups++;
      if (scenario === "delay") await new Promise(resolve => setTimeout(resolve, 1000));
      return planId === binding.planId && preflightId === binding.preflightId ? binding : undefined;
    } });
  }
  metadata({ ready: true, frameSha256, valueSha256 });
  try {
    for await (const line of iterator) {
      if (line !== "status") throw Error();
      // Give socket ACK/close its event-loop turn before observing the real Core lease buffers.
      await new Promise(resolve => setImmediate(resolve));
      const end = Date.now() + 1000;
      while (taken && held.some(value => value.some(byte => byte !== 0)) && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      metadata({ lookups, taken, released: held.length > 0 && held.every(value => value.every(byte => byte === 0)),
        preparedInputZeroed: input.every(byte => byte === 0) });
    }
  } finally { await instance.close(); secrets.close(); lines.close(); }
}

const task = process.argv[2] === "worker" ? worker() : broker(process.argv[2]);
void task.catch(() => { process.exit(2); });
