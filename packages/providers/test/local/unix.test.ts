/** D122 AF1: a real Unix boundary proves validation before connection, bounded bodies and owned cancellation. */
import assert from "node:assert/strict";
import { lstat, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Socket } from "node:net";
import { test } from "node:test";
import * as providers from "../../src/index.ts";
import { startFakeFmServe } from "../fixtures/fake-fm-serve.ts";

const T = { timeout: 15_000 };
const POSIX = { ...T, skip: process.platform === "win32" && "D122: native Unix socket tests require POSIX" };
const ORIGIN = "http://apple-fm.invalid";
const trusted = { verify: () => ({ ok: true as const }) };

test("Unix transport reports platform refusal before guard or connection on Windows", T, async () => {
  let verifies = 0;
  const fetch = providers.createUnixFetch({ id: "apple-fm", path: "/nonexistent/fm.sock" }, {
    platform: "win32", guard: { verify: () => {
      verifies++;
      return { ok: true };
    } },
  });
  await assert.rejects(fetch(`${ORIGIN}/health`), (error: unknown) =>
    error instanceof providers.ProviderError && error.code === "platform" && !error.retryable);
  assert.equal(verifies, 0);
});

test("managed Unix requests use a 0755 socket under a private directory without TCP or auth", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    const fetch = providers.createUnixFetch(fm.socket, { guard: trusted });
    const response = await fetch(`${ORIGIN}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "fm serve is running",
      models: [
        { name: "system", available: true }, { name: "pcc", available: false, reason: "synthetic cloud refusal" },
      ],
    });
    assert.equal((await stat(fm.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(fm.socket.path)).mode & 0o777, 0o755);
    assert.equal(fm.requests[0]?.headers.host, "apple-fm.invalid");
    assert.equal(fm.requests[0]?.headers.authorization, undefined);
    await fm.waitForDisconnect();
  } finally {
    await fm.close();
  }
});

test("Unix requests reject other hosts, credentials, query, fragments, routes and methods before guard", POSIX, async () => {
  const fm = await startFakeFmServe();
  let verifies = 0;
  try {
    const fetch = providers.createUnixFetch(fm.socket, {
      guard: { verify: () => {
        verifies++;
        return { ok: true };
      } },
    });
    const urls = [
      "http://127.0.0.1/health", "https://apple-fm.invalid/health", "http://apple-fm.invalid:8080/health",
      "http://user:pass@apple-fm.invalid/health", `${ORIGIN}/health?a=1`, `${ORIGIN}/health#fragment`,
      `${ORIGIN}/v1/models/`, `${ORIGIN}/containers/json`, `${ORIGIN}/v1/%6dodels`,
    ];
    for (const url of urls) await assert.rejects(fetch(url), TypeError, url);
    for (const method of ["DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"]) {
      await assert.rejects(fetch(`${ORIGIN}/health`, { method }), TypeError, method);
    }
    await assert.rejects(fetch(`${ORIGIN}/health`, { method: "POST", body: "{}" }), TypeError);
    await assert.rejects(fetch(`${ORIGIN}/v1/chat/completions`), TypeError);
    assert.equal(verifies, 0);
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix fetch rejects credentials and routing headers in records, tuples and Request objects", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    const fetch = providers.createUnixFetch(fm.socket, { guard: trusted });
    for (const name of ["Authorization", "Proxy-Authorization", "Cookie", "Host", "Transfer-Encoding", "Connection"]) {
      for (const headers of [{ [name]: "synthetic" }, [[name, "synthetic"]], new Headers({ [name]: "synthetic" })]) {
        await assert.rejects(fetch(`${ORIGIN}/health`, { headers: headers as HeadersInit }), TypeError, name);
      }
      await assert.rejects(fetch(new Request(`${ORIGIN}/health`, { headers: { [name]: "synthetic" } })), TypeError);
    }
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix descriptors reject wrong ids, relative paths and NUL before returning a fetch or reaching the guard", T, () => {
  let verifies = 0;
  const guard = { verify: () => {
    verifies++;
    return { ok: true as const };
  } };
  for (const descriptor of [
    "/tmp/fm.sock", { id: "other", path: "/tmp/fm.sock" }, { id: "apple-fm", path: "relative.sock" },
    { id: "apple-fm", path: "/tmp/fm\0.sock" },
  ]) {
    assert.throws(() => providers.createUnixFetch(descriptor as providers.ManagedUnixSocket, { guard }), TypeError);
  }
  assert.equal(verifies, 0);
});

test("103 UTF-8 bytes reach the guard while 104 ASCII or multibyte bytes give the short-home hint first", T, async () => {
  for (const path of [`/${"x".repeat(102)}`, `/${"é".repeat(51)}`, `/${"x".repeat(103)}`, `/${"é".repeat(51)}x`]) {
    let verifies = 0;
    const fetch = providers.createUnixFetch({ id: "apple-fm", path }, {
      platform: "linux", guard: { verify: () => {
        verifies++;
        return { ok: false, reason: "socket-untrusted" };
      } },
    });
    const tooLong = Buffer.byteLength(path) === 104;
    await assert.rejects(fetch(`${ORIGIN}/health`), (error: unknown) => {
      assert.ok(error instanceof providers.ProviderError);
      assert.equal(error.code, tooLong ? "socket-path-too-long" : "socket-untrusted");
      assert.equal(error.retryable, false);
      if (tooLong) assert.match(error.message, /use a shorter PLUR1BUS_HOME/);
      return true;
    });
    assert.equal(verifies, tooLong ? 0 : 1);
  }
});

test("20 KiB response headers are refused even with Node's ambient header limit raised", POSIX, async () => {
  await promisify(execFile)(process.execPath, [
    "--max-http-header-size=32768", "--experimental-strip-types", "--conditions=source",
    fileURLToPath(new URL("../fixtures/unix-header-limit.ts", import.meta.url)),
  ], { timeout: 10_000 });
});

test("a stalled Unix connect is destroyed by the two-second transport timer", POSIX, async (context) => {
  let stalled: Socket | undefined;
  context.mock.method(Socket.prototype, "connect", function (this: Socket) {
    stalled = this;
    Object.defineProperty(this, "connecting", { value: true, writable: true, configurable: true });
    return this;
  });
  const fetch = providers.createUnixFetch({ id: "apple-fm", path: "/synthetic-stalled.sock" }, { guard: trusted });
  const start = performance.now();
  await assert.rejects(fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(3500) }), (error: unknown) =>
    error instanceof providers.ProviderError && error.kind === "network" && error.code === "unavailable");
  assert.ok(performance.now() - start >= 1900, "the connect must remain stalled until its timer expires");
  assert.ok(performance.now() - start < 3400, "the caller's later abort must not be the shutdown mechanism");
  assert.equal(stalled?.destroyed, true);
});

test("Unix guard runs on every connection and refusals never reach the server", POSIX, async () => {
  const fm = await startFakeFmServe();
  let verifies = 0;
  let ok = true;
  try {
    const fetch = providers.createUnixFetch(fm.socket, {
      guard: { verify: () => {
        verifies++;
        return ok ? { ok: true } : { ok: false, reason: "socket-untrusted" };
      } },
    });
    await (await fetch(`${ORIGIN}/health`)).text();
    await (await fetch(`${ORIGIN}/health`)).text();
    assert.equal(verifies, 2);
    ok = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(fetch(`${ORIGIN}/health`), (error: unknown) =>
        error instanceof providers.ProviderError && error.code === "socket-untrusted" && !error.retryable);
    }
    assert.equal(verifies, 4, "every connection attempt must consult the guard");
    assert.equal(fm.requests.length, 2);
  } finally {
    await fm.close();
  }
});

test("replacing a socket immediately after success consults the guard again before connecting", POSIX, async () => {
  const fm = await startFakeFmServe();
  const replacement = await startFakeFmServe();
  let verifies = 0;
  try {
    const original = await lstat(fm.socket.path);
    const fetch = providers.createUnixFetch(fm.socket, { guard: { verify: async socket => {
      verifies++;
      const current = await lstat(socket.path);
      return current.ino === original.ino ? { ok: true } : { ok: false, reason: "socket-untrusted" };
    } } });
    await (await fetch(`${ORIGIN}/health`)).text();
    await rename(fm.socket.path, join(fm.directory, "original.sock"));
    await rename(replacement.socket.path, fm.socket.path);
    await assert.rejects(fetch(`${ORIGIN}/health`), (error: unknown) =>
      error instanceof providers.ProviderError && error.code === "socket-untrusted");
    assert.equal(verifies, 2);
    assert.equal(fm.requests.length, 1);
    assert.equal(replacement.requests.length, 0);
  } finally {
    await fm.close();
    await replacement.close();
  }
});

test("Unix guard exceptions are sanitized and never cause a fallback connection", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    const fetch = providers.createUnixFetch(fm.socket, {
      guard: { verify: () => {
        throw new Error(`synthetic-private-marker ${fm.socket.path}`);
      } },
    });
    await assert.rejects(fetch(`${ORIGIN}/health`), (error: unknown) => {
      assert.ok(error instanceof providers.ProviderError);
      assert.equal(error.code, "socket-untrusted");
      assert.doesNotMatch(String(error), /synthetic-private-marker|p1fm-/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix transport caps request bodies at one MiB before guard or connection", POSIX, async () => {
  const fm = await startFakeFmServe();
  let verifies = 0;
  try {
    const fetch = providers.createUnixFetch(fm.socket, {
      guard: { verify: () => {
        verifies++;
        return { ok: true };
      } },
    });
    await assert.rejects(fetch(`${ORIGIN}/v1/chat/completions`, {
      method: "POST", body: "é".repeat(512 * 1024 + 1),
    }), (error: unknown) => error instanceof providers.ProviderError && error.kind === "invalid_request");
    assert.equal(verifies, 0);
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix redirects are returned without following their Location", POSIX, async () => {
  const fm = await startFakeFmServe({ handler: (_request, response) => {
    response.writeHead(307, { location: "http://127.0.0.1:1/private" });
    response.end();
  } });
  try {
    const fetch = providers.createUnixFetch(fm.socket, { guard: trusted });
    const response = await fetch(`${ORIGIN}/health`);
    assert.equal(response.status, 307);
    await response.text();
    assert.equal(fm.requests.length, 1);
  } finally {
    await fm.close();
  }
});

test("Unix health responses larger than 64 KiB are cut and their connection closes", POSIX, async () => {
  const fm = await startFakeFmServe({ handler: (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("x".repeat(64 * 1024 + 1));
  } });
  try {
    const response = await providers.createUnixFetch(fm.socket, { guard: trusted })(`${ORIGIN}/health`);
    await assert.rejects(response.text(), (error: unknown) =>
      error instanceof providers.ProviderError && error.code === "protocol");
    await fm.waitForDisconnect();
  } finally {
    await fm.close();
  }
});

test("Unix fetch honours abort while the guard is pending, without waiting for the guard", POSIX, async () => {
  const fm = await startFakeFmServe();
  let entered!: () => void;
  const verifying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const controller = new AbortController();
  try {
    const fetch = providers.createUnixFetch(fm.socket, {
      guard: { verify: () => {
        entered();
        return new Promise(() => {});
      } },
    });
    const result = fetch(`${ORIGIN}/health`, { signal: controller.signal });
    await verifying;
    controller.abort();
    await assert.rejects(result);
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix body cancellation closes the underlying socket even without an AbortSignal", POSIX, async () => {
  const fm = await startFakeFmServe({ mode: "hang" });
  try {
    const response = await providers.createUnixFetch(fm.socket, { guard: trusted })(`${ORIGIN}/v1/chat/completions`, {
      method: "POST", body: "{}",
    });
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    await fm.waitForDisconnect();
  } finally {
    await fm.close();
  }
});

test("Unix connections are never pooled or routed through TCP, including a missing-socket failure", POSIX, async (t) => {
  const connect = Socket.prototype.connect;
  const destinations: unknown[] = [];
  t.mock.method(Socket.prototype, "connect", function(this: Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    destinations.push(typeof first === "object" && first !== null ? (first as { path?: unknown }).path : first);
    return Reflect.apply(connect, this, args);
  });
  const fm = await startFakeFmServe();
  try {
    const fetch = providers.createUnixFetch(fm.socket, { guard: trusted });
    await (await fetch(`${ORIGIN}/health`)).text();
    await (await fetch(`${ORIGIN}/v1/models`)).text();
    await fm.waitForDisconnect();
    await assert.rejects(providers.createUnixFetch({ id: "apple-fm", path: `${fm.directory}/missing.sock` }, {
      guard: trusted,
    })(`${ORIGIN}/health`));
    assert.deepEqual(destinations, [fm.socket.path, fm.socket.path, `${fm.directory}/missing.sock`]);
  } finally {
    await fm.close();
  }
});

test("Unix descriptor cannot be redirected by caller mutation while its guard is pending", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    const socket = { ...fm.socket };
    const fetch = providers.createUnixFetch(socket, { guard: { verify: (checked) => {
      assert.equal(checked.path, fm.socket.path);
      socket.path = `${fm.directory}/missing.sock`;
      return { ok: true };
    } } });
    assert.equal((await fetch(`${ORIGIN}/health`)).status, 200);
    assert.equal(fm.requests.length, 1);
  } finally {
    await fm.close();
  }
});

test("Unix transport sanitizes even a typed guard exception carrying a private message", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    const fetch = providers.createUnixFetch(fm.socket, { guard: { verify: () => {
      throw new providers.ProviderError("network", "synthetic-private-marker", { code: "platform" });
    } } });
    await assert.rejects(fetch(`${ORIGIN}/health`), (error: unknown) => {
      assert.ok(error instanceof providers.ProviderError);
      assert.doesNotMatch(String(error), /synthetic-private-marker/);
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally {
    await fm.close();
  }
});

test("Unix transport rejects an unrepresentable HTTP status instead of throwing from a response event", POSIX, async (t) => {
  const fm = await startFakeFmServe({ handler: (_request, response) => {
    response.writeHead(700);
    response.end("synthetic");
  } });
  t.after(() => fm.close());
  try {
    await assert.rejects(providers.createUnixFetch(fm.socket, { guard: trusted })(`${ORIGIN}/health`),
      (error: unknown) => error instanceof providers.ProviderError && error.code === "protocol");
  } finally {
    await fm.close();
  }
});

test("Unix transport sends the URL snapshot it validated even when an input stringifier changes", POSIX, async () => {
  const fm = await startFakeFmServe();
  let conversions = 0;
  try {
    const url = new URL(`${ORIGIN}/health`);
    url.toString = () => ++conversions === 1 ? `${ORIGIN}/health` : `${ORIGIN}/containers/json`;
    const response = await providers.createUnixFetch(fm.socket, { guard: trusted })(url);
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(fm.requests.map((request) => request.path), ["/health"]);
  } finally {
    await fm.close();
  }
});

test("Unix transport does not retain malformed credential header values in construction errors", POSIX, async () => {
  const fm = await startFakeFmServe();
  try {
    await assert.rejects(providers.createUnixFetch(fm.socket, { guard: trusted })(`${ORIGIN}/health`, {
      headers: { Authorization: "synthetic-private-marker\r\nheader" },
    }), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.doesNotMatch(String(error), /synthetic-private-marker/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(fm.requests.length, 0);
  } finally {
    await fm.close();
  }
});

test("Unix models and chat responses each enforce their own byte cap", POSIX, async () => {
  for (const [path, limit] of [["/v1/models", 1024 * 1024], ["/v1/chat/completions", 16 * 1024 * 1024]] as const) {
    const fm = await startFakeFmServe({ handler: (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("x".repeat(limit + 1));
    } });
    try {
      const fetch = providers.createUnixFetch(fm.socket, { guard: trusted });
      await assert.rejects(async () => {
        const response = await fetch(`${ORIGIN}${path}`, path === "/v1/models" ? {} : { method: "POST", body: "{}" });
        await response.text();
      }, (error: unknown) => error instanceof providers.ProviderError && error.code === "protocol");
      await fm.waitForDisconnect();
    } finally {
      await fm.close();
    }
  }
});

test("Unix transport permits exactly one MiB but cancels a streamed request beyond the cap", POSIX, async () => {
  const fm = await startFakeFmServe();
  let cancelled = false;
  try {
    const fetch = providers.createUnixFetch(fm.socket, { guard: trusted });
    await (await fetch(`${ORIGIN}/v1/chat/completions`, { method: "POST", body: "x".repeat(1024 * 1024) })).text();
    assert.equal(Buffer.byteLength(fm.requests[0]!.body), 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const init = { method: "POST", body, duplex: "half" };
    await assert.rejects(fetch(`${ORIGIN}/v1/chat/completions`, init), (error: unknown) =>
      error instanceof providers.ProviderError && error.kind === "invalid_request");
    assert.equal(cancelled, true);
    assert.equal(fm.requests.length, 1);
  } finally {
    await fm.close();
  }
});

test("Unix request-body cancellation does not wait for an uncooperative stream cancel hook", POSIX, async () => {
  const fm = await startFakeFmServe();
  let pulled!: () => void;
  const reading = new Promise<void>((resolve) => {
    pulled = resolve;
  });
  const controller = new AbortController();
  let cancelled = false;
  try {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled();
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    const init = { method: "POST", body, duplex: "half", signal: controller.signal };
    const result = providers.createUnixFetch(fm.socket, { guard: trusted })(`${ORIGIN}/v1/chat/completions`, init);
    await reading;
    controller.abort();
    await assert.rejects(result, (error: unknown) =>
      error instanceof providers.ProviderError && error.kind === "aborted");
    assert.equal(cancelled, true);
    assert.equal(fm.requests.length, 0);
  } finally {
    controller.abort();
    await fm.close();
  }
});
