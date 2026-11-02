/** Native Windows proof: the helper checks the connected pipe, with a positive round trip and a foreign PID refusal. */
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { connect, RpcCallError } from "@plur1bus/module-api";
import { RPC_VERSION } from "@plur1bus/rpc-schema";
import { toolsPipeServerPid } from "../../src/tools-service/pipe-peer.ts";

if (process.platform === "win32") {
  const binary = resolve(fileURLToPath(new URL("../../../../target/debug/plur1bus.exe", import.meta.url)));
  for (const foreign of [false, true]) test(`native Windows tools pipe peer ${foreign ? "refuses a foreign PID without sending credentials" : "authenticates after the OS PID matches"}`, async () => {
    const address = `\\\\.\\pipe\\plur1bus-peer-${process.pid}-${randomBytes(8).toString("hex")}`;
    const sockets = new Set<Socket>();
    let bytes = 0;
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.on("data", chunk => {
        bytes += chunk.length;
        const request = JSON.parse(chunk.toString());
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
          result: { rpc: RPC_VERSION, pid: process.pid, instanceId: "native-peer-test" } }) + "\n");
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
    let client;
    try {
      const pending = connect({ address, endpoint: "tools", token: randomBytes(32).toString("hex"),
        ticketKey: randomBytes(32).toString("hex"), expectedServerPid: process.pid + (foreign ? 1 : 0),
        serverPidOf: socket => toolsPipeServerPid(socket, binary) });
      if (foreign) {
        await assert.rejects(pending, (error: unknown) => error instanceof RpcCallError && error.reason === "pipe-server-mismatch");
        assert.equal(bytes, 0);
      } else { client = await pending; assert.ok(bytes > 0); }
    } finally {
      await client?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
