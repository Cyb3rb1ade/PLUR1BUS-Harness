// A minimal Chromium driver for rendering documents: launch a headless Chromium, reach it over the DevTools Protocol
// (CDP), and call `Page.printToPDF` / `Page.captureScreenshot`. No third-party browser library is used (D100's dependency
// allow-list has none): this is a small RFC 6455 client on `node:net` plus a thin CDP JSON-RPC layer, so the renderer stays
// self-contained and the CI container only needs a Chromium binary, which the package resolves from an explicit path or
// `PATH` and otherwise reports as unavailable.

import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { get as httpGet } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ChromiumLaunch {
  readonly proc: ChildProcess;
  readonly close: () => Promise<void>;
  readonly endpoint: string; // http://127.0.0.1:<port>
}

/** Spawn headless Chromium with an ephemeral DevTools port and a throwaway profile. Resolves once the endpoint is ready. */
export function launchChromium(bin: string, signal: AbortSignal): Promise<ChromiumLaunch> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ];
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe", "ignore"] });
    let settled = false;
    let buf = "";
    const timer = setTimeout(() => fail(new Error("chromium did not report a DevTools endpoint in time")), 30_000);
    const onAbort = (): void => fail(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(err);
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      buf += chunk;
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
      if (m) {
        const ws = m[1]!;
        const host = /ws:\/\/([^/]+)/.exec(ws)![1]!;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        settled = true;
        resolve({
          proc: child,
          endpoint: `http://${host}`,
          close: async () => { try { child.kill("SIGKILL"); } catch { /* gone */ } },
        });
      }
    });
    child.on("error", (e) => fail(e));
    child.on("exit", (code) => fail(new Error(`chromium exited early (${code})`)));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// RFC 6455 client (client-to-server frames are masked; server frames are not).
// ---------------------------------------------------------------------------------------------------------------------

type WsMessageHandler = (text: string) => void;

class WsConnection {
  #socket: Socket;
  #onMessage: WsMessageHandler;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(socket: Socket, onMessage: WsMessageHandler) {
    this.#socket = socket;
    this.#onMessage = onMessage;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
  }

  static connect(url: string): Promise<WsConnection> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const key = randomBytes(16).toString("base64");
      const socket = connect({ host: u.hostname, port: Number(u.port || 80) }, () => {
        const headers = [
          `GET ${u.pathname}${u.search} HTTP/1.1`,
          `Host: ${u.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n");
        socket.write(headers);
      });
      let handshake = "";
      let upgraded = false;
      const onUpgradeData = (chunk: Buffer): void => {
        if (upgraded) return;
        handshake += chunk.toString("utf8");
        const end = handshake.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = handshake.slice(0, end);
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        if (!head.includes("101") || !head.includes(accept)) {
          socket.destroy();
          reject(new Error(`websocket handshake failed: ${head.split("\r\n")[0]}`));
          return;
        }
        upgraded = true;
        socket.removeListener("data", onUpgradeData);
        const rest = Buffer.from(handshake.slice(end + 4), "utf8");
        const conn = new WsConnection(socket, () => {});
        if (rest.length > 0) conn.#onData(rest);
        resolve(conn);
      };
      socket.on("data", onUpgradeData);
      socket.on("error", reject);
    });
  }

  setHandler(handler: WsMessageHandler): void {
    this.#onMessage = handler;
  }

  send(text: string): void {
    const payload = Buffer.from(text, "utf8");
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    this.#socket.write(Buffer.concat([header, mask, masked]));
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (;;) {
      if (this.#buffer.length < 2) return;
      const opcode = this.#buffer[0]! & 0x0f;
      const b1 = this.#buffer[1]!;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.#buffer.length < 4) return;
        len = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.#buffer.length < 10) return;
        len = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.#buffer.length < offset + len) return;
      const payload = this.#buffer.subarray(offset, offset + len);
      this.#buffer = this.#buffer.subarray(offset + len);
      if (opcode === 0x1) this.#onMessage(payload.toString("utf8"));
      // Ignore ping/pong/continuation frames for this protocol.
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------------------------------------------------

export interface CdpClient {
  readonly call: <R = unknown>(method: string, params?: Record<string, unknown>) => Promise<R>;
  readonly close: () => void;
}

async function httpJson<T>(url: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    httpGet(url, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data) as T); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

/** Connect to the first page target on the browser's HTTP endpoint (resolved from `/json/list`). */
export async function connectCdp(endpoint: string, signal: AbortSignal): Promise<CdpClient> {
  if (signal.aborted) throw new Error("aborted");
  const list = await httpJson<{ webSocketDebuggerUrl: string; type: string }[]>(`${endpoint}/json/list`);
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = await WsConnection.connect(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.setHandler((text) => {
    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try { msg = JSON.parse(text) as never; } catch { return; }
    const p = pending.get(msg.id ?? -1);
    if (!p) return;
    pending.delete(msg.id!);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
  return {
    call: <R = unknown>(method: string, params: Record<string, unknown> = {}): Promise<R> =>
      new Promise<R>((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      }),
    close: () => ws.send(JSON.stringify({ id: ++id, method: "Browser.close" })),
  };
}

/** Spawn Chromium, navigate to a `file://` URL, and wait until the document finishes loading. */
export async function openPage(bin: string, fileUrl: string, signal: AbortSignal): Promise<{ cdp: CdpClient; launch: ChromiumLaunch }> {
  const launch = await launchChromium(bin, signal);
  try {
    const cdp = await connectCdp(launch.endpoint, signal);
    await cdp.call("Page.enable");
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("page load timed out")), 30_000);
      const poll = async (): Promise<void> => {
        try {
          const r = await cdp.call<{ result?: { value?: string } }>("Runtime.evaluate", { expression: "document.readyState" });
          if (r?.result?.value === "complete") { clearTimeout(timer); resolve(); return; }
        } catch { /* retry */ }
        setTimeout(poll, 50);
      };
      void poll();
    });
    await cdp.call("Page.navigate", { url: fileUrl });
    await loaded;
    // Embedded fonts (data: URLs) decode lazily; print too early and Chromium reports "Printing failed". Wait for font load.
    await cdp.call("Runtime.evaluate", {
      expression: "document.fonts ? document.fonts.ready.then(() => 'loaded') : Promise.resolve('no-fonts')",
      awaitPromise: true,
    });
    return { cdp, launch };
  } catch (e) {
    await launch.close();
    throw e;
  }
}

/** Render a `file://` page to PDF bytes via `Page.printToPDF`, with fonts embedded. */
export async function printToPdf(cdp: CdpClient, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw new Error("aborted");
  const res = await cdp.call<{ data: string }>("Page.printToPDF", {
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    transferMode: "ReturnAsBase64",
  });
  return Buffer.from(res.data, "base64");
}

/** Render a `file://` page to a PNG screenshot (used by the visual review, Phase 2). */
export async function captureScreenshot(cdp: CdpClient): Promise<Uint8Array> {
  const res = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true });
  return Buffer.from(res.data, "base64");
}

/** Fixed capture viewport (A4 at 96 dpi). Without it the headless window size, and with it the page width/height, varies between runs. */
export const CAPTURE_WIDTH = 794;
export const CAPTURE_HEIGHT = 1123;

/**
 * Render the full scrollable page to one PNG (beyond the viewport). Deterministic: the viewport is pinned, the layout is given time
 * to settle (fonts ready, two animation frames, scroll height unchanged over consecutive samples) and the capture is clipped to the
 * measured document height.
 */
export async function captureFullPagePng(cdp: CdpClient): Promise<Uint8Array> {
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT, deviceScaleFactor: 1, mobile: false });
  const settle = "document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)))))))";
  let height = 0, stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const res = await cdp.call<{ result?: { value?: number } }>("Runtime.evaluate", { expression: settle, awaitPromise: true, returnByValue: true });
    const h = Number(res.result?.value ?? 0);
    stable = h === height && h > 0 ? stable + 1 : 0;
    height = h;
    await new Promise((r) => setTimeout(r, 50));
  }
  const res = await cdp.call<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: CAPTURE_WIDTH, height: Math.max(height, 1), scale: 1 },
  });
  return Buffer.from(res.data, "base64");
}

/** Evaluate a JS expression against the page and return the JSON value. */
export async function evaluate(cdp: CdpClient, expression: string): Promise<unknown> {
  const res = await cdp.call<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true });
  return res.result?.value;
}

export async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "plur1bus-doc-"));
}
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
