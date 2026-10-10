import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Call {
  method: string;
  body: Record<string, unknown>;
}

export const FAKE_TELEGRAM_TOKEN = ["123456789", "AAFakeTokenForTestsOnly_abcdefghijklmnop"].join(":");

/** A local Bot API stand-in. getUpdates holds the request open (like long polling) until updates are queued or close(). */
export class FakeTelegram {
  readonly token = FAKE_TELEGRAM_TOKEN;
  readonly calls: Call[] = [];
  readonly files = new Map<string, { path: string; mime: string; data: Buffer }>();
  readonly queue: Record<string, unknown>[] = [];
  /** Scripted failures per method, consumed in order: [status, body]. */
  readonly failures: Record<string, Array<[number, unknown]>> = {};
  #waiters: Array<() => void> = [];
  #server!: Server;
  #nextMessageId = 100;
  baseUrl = "";

  async listen(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#server.on("connection", (s) => s.setNoDelay(true));
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.baseUrl = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> {
    this.#wake();
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
  push(update: Record<string, unknown>): void {
    this.queue.push(update);
    this.#wake();
  }
  failNext(method: string, status: number, body: unknown): void {
    (this.failures[method] ??= []).push([status, body]);
  }
  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
  reset(): void {
    this.calls.length = 0;
    this.queue.length = 0;
    for (const k of Object.keys(this.failures)) delete this.failures[k];
    this.#wake();
  }
  #wake(): void {
    const w = this.#waiters;
    this.#waiters = [];
    for (const f of w) f();
  }
  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const filePrefix = `/file/bot${this.token}/`;
    if ((req.url ?? "").startsWith(filePrefix)) {
      const path = req.url!.slice(filePrefix.length);
      const file = [...this.files.values()].find((f) => f.path === path);
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": file.mime });
      res.end(file.data);
      return;
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!m || m[1] !== this.token)
      return send(401, {
        ok: false,
        error_code: 401,
        description: "Unauthorized",
      });
    const method = m[2]!;
    const raw = Buffer.concat(chunks);
    let body: Record<string, unknown>;
    if (req.headers["content-type"]?.startsWith("multipart/form-data")) {
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] },
        body: raw,
      });
      const form = await request.formData();
      body = {};
      form.forEach((v, k) => {
        body[k] = typeof v === "string" ? v : { size: v.size, type: v.type, name: v.name };
      });
    } else body = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
    const call = { method, body };
    this.calls.push(call);
    const fail = this.failures[method]?.shift();
    if (fail) return send(fail[0], fail[1]);
    if (method === "getMe") return send(200, { ok: true, result: { id: 999, username: "testbot" } });
    if (["setWebhook", "deleteWebhook", "setMyCommands", "answerCallbackQuery"].includes(method))
      return send(200, { ok: true, result: true });
    if (method === "getFile") {
      const file = this.files.get(String(body.file_id));
      return file
        ? send(200, {
            ok: true,
            result: { file_path: file.path, file_size: file.data.length },
          })
        : send(400, { ok: false, error_code: 400 });
    }
    if (["sendPhoto", "sendDocument", "sendVoice", "sendAudio", "sendVideo"].includes(method))
      return send(200, {
        ok: true,
        result: { message_id: this.#nextMessageId++ },
      });
    if (method === "sendMessage")
      return send(200, {
        ok: true,
        result: { message_id: this.#nextMessageId++ },
      });
    if (method === "getUpdates") {
      const offset = typeof body.offset === "number" ? body.offset : 0;
      let ready = this.queue.filter((u) => (u.update_id as number) >= offset);
      if (ready.length === 0) {
        let closed = false;
        let wake: (() => void) | undefined;
        const onClose = () => {
          closed = true;
          const i = this.#waiters.indexOf(wake!);
          if (i >= 0) this.#waiters.splice(i, 1);
          wake?.();
        };
        res.on("close", onClose);
        await new Promise<void>((r) => {
          wake = r;
          this.#waiters.push(r);
        });
        res.off("close", onClose);
        if (closed) {
          const idx = this.calls.lastIndexOf(call);
          if (idx >= 0) this.calls.splice(idx, 1);
          return;
        }
        ready = this.queue.filter((u) => (u.update_id as number) >= offset);
      }
      return send(200, { ok: true, result: ready });
    }
    send(404, { ok: false, description: "Not Found" });
  }
}

export const textUpdate = (id: number, chatId: number, text: string) => ({
  update_id: id,
  message: {
    message_id: id * 10,
    date: 1_700_000_000,
    text,
    chat: { id: chatId, type: "private" },
    from: { id: chatId },
  },
});
