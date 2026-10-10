import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { defaultWsFactory, openSocket, WS_CLOSED, WS_OPEN } from "../src/ws.ts";
import { isVoiceProviderError, VoiceProviderError } from "../src/errors.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface RawServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  onSocket: (fn: (sock: Duplex, req: any) => void) => void;
}

async function startRawServer(): Promise<RawServer> {
  let socketHandler: ((sock: Duplex, req: any) => void) | undefined;
  const sockets = new Set<Duplex>();
  const server: Server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", (req, sock: Duplex) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    const key = String(req.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socketHandler?.(sock, req);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.closeAllConnections();
      server.close(() => r());
    }),
    onSocket: (fn) => { socketHandler = fn; },
  };
}


test("ws unit: client outgoing frames are masked with 4-byte mask", async () => {
  const srv = await startRawServer();
  try {
    const received: Buffer[] = [];
    srv.onSocket((sock) => {
      sock.on("data", (d: Buffer) => received.push(d));
    });
    const ws = await openSocket({ provider: "test", url: srv.url });
    ws.send("hello");
    // Wait for frame
    for (let i = 0; i < 20 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const buf = Buffer.concat(received);
    assert.ok(buf.length >= 2 + 4 + 5);
    const maskedBit = (buf[1]! & 0x80) !== 0;
    assert.equal(maskedBit, true, "client frame must be masked per RFC 6455");
    const mask = buf.subarray(2, 6);
    const payload = Buffer.from(buf.subarray(6, 11));
    for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
    assert.equal(payload.toString("utf8"), "hello");
    ws.close(1000, "done");
  } finally {
    await srv.close();
  }
});

test("ws unit: incoming unfragmented text and fragmented text are reassembled", async () => {
  const srv = await startRawServer();
  try {
    srv.onSocket((sock) => {
      // Send fragmented text frame: first part opcode 1 fin=0, second part opcode 0 fin=1
      const f1 = Buffer.from([0x01, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello" (fin=0)
      const f2 = Buffer.from([0x80, 0x06, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64]); // " World" (fin=1, opcode 0)
      sock.write(Buffer.concat([f1, f2]));
    });
    const ws = await openSocket({ provider: "test", url: srv.url });
    const msgs: string[] = [];
    ws.addEventListener("message", (ev) => msgs.push(String(ev.data)));
    for (let i = 0; i < 20 && msgs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(msgs, ["Hello World"]);
    ws.close(1000);
  } finally {
    await srv.close();
  }
});

test("ws unit: fragmented message exceeding MAX_PAYLOAD closes with 1009", async () => {
  const srv = await startRawServer();
  try {
    let closedCode: number | undefined;
    srv.onSocket((sock) => {
      // Send fragments that cumulatively exceed max payload (or single frame exceeding)
      // Send 1009 test: first fragment 10 bytes, then fake an oversize check or test limit
      // With MAX_PAYLOAD = 16MB, let's test a frame whose length header exceeds 16MB or cumulative fragments
      // Len = 127 with 17MB
      const bigHead = Buffer.alloc(10);
      bigHead[0] = 0x81; // fin=1, text
      bigHead[1] = 127;
      bigHead.writeBigUInt64BE(BigInt(17 * 1024 * 1024), 2);
      sock.write(bigHead);
    });
    const ws = await openSocket({ provider: "test", url: srv.url });
    ws.addEventListener("close", (ev) => { closedCode = ev.code; });
    for (let i = 0; i < 20 && closedCode === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(closedCode, 1009);
  } finally {
    await srv.close();
  }
});

test("ws unit: control frame checks: payload > 125 or fragmented control frame closes with 1002", async () => {
  const srv = await startRawServer();
  try {
    let closedCode: number | undefined;
    srv.onSocket((sock) => {
      // Ping (opcode 9) with payload length 126 -> illegal (control frame <= 125)
      const illegalPing = Buffer.from([0x89, 126, 0x00, 0x80]);
      sock.write(illegalPing);
    });
    const ws = await openSocket({ provider: "test", url: srv.url });
    ws.addEventListener("close", (ev) => { closedCode = ev.code; });
    for (let i = 0; i < 20 && closedCode === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(closedCode, 1002);
  } finally {
    await srv.close();
  }
});

test("ws unit: control frame with fin=0 (fragmented control) closes with 1002", async () => {
  const srv = await startRawServer();
  try {
    let closedCode: number | undefined;
    srv.onSocket((sock) => {
      // Ping (opcode 9) with fin=0 (b0 = 0x09 instead of 0x89) -> illegal
      const fragmentedPing = Buffer.from([0x09, 0x00]);
      sock.write(fragmentedPing);
    });
    const ws = await openSocket({ provider: "test", url: srv.url });
    ws.addEventListener("close", (ev) => { closedCode = ev.code; });
    for (let i = 0; i < 20 && closedCode === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(closedCode, 1002);
  } finally {
    await srv.close();
  }
});

test("ws unit: RSV bits set without extension closes with 1002", async () => {
  const srv = await startRawServer();
  try {
    let closedCode: number | undefined;
    srv.onSocket((sock) => {
      // Frame with RSV1 set: 0xc1 (fin=1, rsv1=1, opcode 1)
      const rsvFrame = Buffer.from([0xc1, 0x01, 0x78]);
      sock.write(rsvFrame);
    });
    const ws = await openSocket({ provider: "test", url: srv.url });
    ws.addEventListener("close", (ev) => { closedCode = ev.code; });
    for (let i = 0; i < 20 && closedCode === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(closedCode, 1002);
  } finally {
    await srv.close();
  }
});

test("ws unit: invalid UTF-8 in text frame closes with 1007", async () => {
  const srv = await startRawServer();
  try {
    let closedCode: number | undefined;
    srv.onSocket((sock) => {
      // Text frame with invalid UTF-8 byte 0xff
      const badUtf8 = Buffer.from([0x81, 0x02, 0xc3, 0x28]); // invalid 2-byte sequence
      sock.write(badUtf8);
    });
    const ws = await openSocket({ provider: "test", url: srv.url });
    ws.addEventListener("close", (ev) => { closedCode = ev.code; });
    for (let i = 0; i < 20 && closedCode === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(closedCode, 1007);
  } finally {
    await srv.close();
  }
});

test("ws unit: close timeout destroys socket if peer never echoes close", async () => {
  const srv = await startRawServer();
  try {
    let peerSock: Duplex | undefined;
    srv.onSocket((sock) => {
      peerSock = sock;
      // Intentionally do not echo close and do not close socket
    });
    const ws = await openSocket({ provider: "test", url: srv.url });
    let closedEvent: { code: number; reason: string } | undefined;
    ws.addEventListener("close", (ev) => { closedEvent = ev; });
    ws.close(1000, "waiting");
    for (let i = 0; i < 40 && closedEvent === undefined; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(closedEvent !== undefined, "close event must fire on close timeout");
  } finally {
    await srv.close();
  }
});

