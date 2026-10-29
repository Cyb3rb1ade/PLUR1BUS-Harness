import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/** What a server is willing to spend on the rest of an upload it has already decided to refuse. */
export interface LingerLimits {
  /** At most this many further bytes are read and thrown away. */
  capBytes: number;
  /** The whole linger ends after this many milliseconds, however slowly the client sends. */
  maxMs: number;
}

/** The linger a server gives a refused upload besides its own body limit: four times the limit plus a header's worth, five seconds. */
export function lingerLimits(bodyLimit: number, maxMs = 5_000): LingerLimits {
  return { capBytes: bodyLimit * 4 + 65_536, maxMs };
}

/**
 * Reads and discards the rest of a request the server is answering early (a 413, a 401 for a big body, a 431), so the
 * answer can be sent before the connection is closed rather than instead of it.
 *
 * Why: a socket closed while the peer is still sending, or with unread bytes in its receive queue, ends in an RST, not a FIN.
 * An RST makes macOS drop the response the client has not read yet, so the client reports `ECONNRESET` and never sees the
 * status (Linux keeps the queued response readable, which is why the failure shows up on macOS only). Callers hold the end of
 * their response (`res.write(body)` with a `Content-Length`, `res.end()` when this resolves): the client gets the answer at
 * once, and the socket closes only after the last byte of the upload was read, which is a clean FIN.
 *
 * The linger is bounded in bytes and time so a refusal is no lever: a client that sends past `capBytes` or is still
 * sending after `maxMs` loses the connection (`req.destroy()`), which is the behaviour before the linger existed.
 * Resolves when the request ended, was destroyed, or a bound was hit; never rejects.
 */
export function lingerUnread(req: IncomingMessage, limits: LingerLimits): Promise<void> {
  if (req.complete || req.readableEnded || req.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let seen = 0; let settled = false;
    const finish = (abort: boolean): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.off("data", onData); req.off("end", onEnd); req.off("close", onClose);
      if (abort) req.destroy();
      resolve();
    };
    const onData = (chunk: Buffer): void => { seen += chunk.length; if (seen > limits.capBytes) finish(true); };
    const onEnd = (): void => finish(false);
    const onClose = (): void => finish(false);
    const timer = setTimeout(() => finish(true), limits.maxMs); timer.unref();
    req.on("data", onData); req.on("end", onEnd); req.on("close", onClose); req.on("error", () => {});
    req.resume();
  });
}

/**
 * The same for a socket Node has already given up parsing (`clientError`: a header block that is too large, a malformed
 * request, a request timeout). The caller has written its answer and half-closed (`socket.end(...)`); this keeps the socket
 * open, reading and discarding, until the peer has closed its side or a bound is hit, then destroys it. Returns whether it
 * took the socket on (false: it was destroyed already). Calling it again for the same socket only counts the bytes of
 * the new chunk (`more`) against the cap.
 */
const lingering = new WeakMap<Socket, { seen: number }>();
export function lingerSocket(socket: Socket, limits: LingerLimits, more = 0): boolean {
  if (socket.destroyed) return false;
  const state = lingering.get(socket);
  if (state) { state.seen += more; if (state.seen > limits.capBytes) socket.destroy(); return !socket.destroyed; }
  lingering.set(socket, { seen: more });
  const timer = setTimeout(() => socket.destroy(), limits.maxMs); timer.unref();
  socket.once("close", () => clearTimeout(timer));
  socket.on("error", () => {});
  socket.resume();
  return true;
}
