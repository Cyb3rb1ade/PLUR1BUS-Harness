/** Native worker bridge: one bounded request on stdin, fixed readiness/error on stderr, streamed bytes on stdout.
* Shares the existing egress client and target configuration validation; starts no Core, engine or plugin code.
*/
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { MAX_CONFIG_BYTES, readConfigFile } from "./config-load.ts";
import { ExtensionSourceError, fetchExtensionSource } from "./extension-source-fetch.ts";
const REQUEST_BYTES = 16 * 1024;
async function* bodyChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done)
        return;
      yield next.value;
    }
  }
  finally {
    reader.releaseLock();
  }
}
try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > REQUEST_BYTES)
      throw new ExtensionSourceError("package-invalid");
    chunks.push(buffer);
  }
  let request: unknown;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  catch {
    throw new ExtensionSourceError("package-invalid");
  }
  const stream = await fetchExtensionSource(request, {
    config(home) {
      const path = join(home, "config.json");
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
        throw new ExtensionSourceError("config-invalid");
      }
      return readConfigFile(path);
    },
  });
  // The native caller waits for this bounded line before reading body bytes; a refusal sends no body.
  process.stderr.write('{"ok":true}\n');
  await pipeline(bodyChunks(stream), process.stdout);
}
catch (error) {
  const reason = error instanceof ExtensionSourceError ? error.reason : "source-unreachable";
  const code = reason === "egress-denied" ? "E_DENIED" : reason === "config-invalid" ? "E_CONFIG_INVALID" : "E_INVALID_PARAMS";
  process.stderr.write(`${JSON.stringify({ ok: false, code, reason })}\n`);
  process.exitCode = 1;
}
