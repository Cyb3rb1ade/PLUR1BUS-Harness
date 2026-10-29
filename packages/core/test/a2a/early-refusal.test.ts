import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createA2aServer, type A2aServer } from "../../src/a2a/server.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";
import { AGENTS, KEY_A, peers } from "./helpers.ts";

// The 413 of the A2A server comes before the upload is in and is sent with `Connection: close`. Closing a socket under a
// sender ends in an RST, and on macOS an RST wipes the unread answer from the client's receive queue (the same failure as
// the Harness API's `POST /rpc (1100011 bytes)`). This client reads nothing until its upload is complete, as macOS would.

const open: A2aServer[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });

describe("a2a early refusal", () => {
  it("a 413 for a declared body over the limit reaches a client that is still uploading, and the upload is not cut", async () => {
    const s = createA2aServer({ peers: peers(), agents: (id) => (Object.hasOwn(AGENTS, id) ? AGENTS[id] : undefined), provider: () => new FakeChatProvider(), limits: { maxBodyBytes: 4096 } });
    open.push(s); const { port } = await s.listen();
    const total = 60_000; let writeError: string | undefined; let written = 0; let response = "";
    const sock = connect(port, "127.0.0.1"); sock.pause(); sock.on("error", (e: NodeJS.ErrnoException) => { writeError ??= e.code ?? e.message; });
    await new Promise<void>((resolve) => sock.once("connect", resolve));
    sock.write(`POST /a2a/bernd/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${KEY_A}\r\nContent-Type: application/json\r\nContent-Length: ${total}\r\nConnection: close\r\n\r\n`);
    for (let i = 0; i < total / 4096 && !writeError; i++) { await new Promise<void>((resolve) => sock.write(Buffer.alloc(4096, 0x61), (e) => { if (!e) written += 4096; resolve(); })); await delay(2); }
    assert.equal(writeError, undefined, "the server kept the connection until the upload was done");
    assert.ok(written >= total - 4096);
    sock.resume(); sock.setTimeout(5000, () => sock.destroy());
    await new Promise<void>((resolve) => { sock.on("data", (c) => { response += c; }); sock.on("close", () => resolve()); sock.end(); });
    assert.match(response, /^HTTP\/1\.1 413 /); assert.match(response, /connection: close/i);
  });
});
