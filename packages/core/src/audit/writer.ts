// The append side of the audit chain: lock, tail, rotate, write one line, move the anchor.
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent, AuditSink } from "../rbac/audit.ts";
import { ACTIVE_FILE, ANCHOR_FILE, GENESIS, LOCK_DIR, encodeLine, hashLine, listRotated, parseLine, readAnchor, readTail, rotatedName, type Anchor } from "./chain.ts";
import { verifyChain, type VerifyResult } from "./verify.ts";

export interface AuditChainOptions {
  /** The logs directory (`<home>/logs`). Nothing is created until the first append. */
  dir: string;
  /** Rotate when the active file would grow past this (default 8 MiB). */
  maxBytes?: number;
  /** Applied to every file this creates (Windows ACL via the host's `securePath`); POSIX gets 0600 either way. */
  securePath?: (path: string) => void;
  /** How long an append waits for the lock before it throws (default 5000). */
  lockTimeoutMs?: number;
  /** A lock whose owner is gone, or older than this (default 30000), is taken over. */
  lockStaleMs?: number;
}

export interface AuditChain {
  /** Appends one event; throws when it could not be recorded (same contract as `AuditSink`). */
  append(event: AuditEvent): { seq: number; hash: string };
  readonly sink: AuditSink;
  verify(): VerifyResult;
}

const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function lockIsStale(lock: string, staleMs: number): boolean {
  let owner: { pid?: unknown; at?: unknown } | null = null;
  try { owner = JSON.parse(readFileSync(join(lock, "owner"), "utf8")) as { pid?: unknown; at?: unknown }; } catch { /* between mkdir and the owner file, or unreadable */ }
  if (owner && typeof owner.pid === "number" && typeof owner.at === "number") {
    if (!pidAlive(owner.pid)) return true;
    return Date.now() - owner.at > staleMs;
  }
  try { return Date.now() - statSync(lock).mtimeMs > staleMs; } catch { return false; }
}

/** A short-lived exclusive lock: a directory next to the files (`mkdir` is atomic on every platform we run on). */
export function withChainLock<T>(dir: string, o: { lockTimeoutMs?: number; lockStaleMs?: number }, fn: () => T): T {
  const lock = join(dir, LOCK_DIR);
  const timeout = o.lockTimeoutMs ?? 5000, staleMs = o.lockStaleMs ?? 30000;
  const deadline = Date.now() + timeout;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (lockIsStale(lock, staleMs)) {
        // rename first: of several processes taking over the same stale lock only one rename succeeds
        const aside = `${lock}.stale.${process.pid}.${Date.now()}`;
        try { renameSync(lock, aside); rmSync(aside, { recursive: true, force: true }); } catch { /* somebody else did */ }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`audit lock: timed out after ${timeout} ms waiting for ${lock}`);
      sleep(3);
    }
  }
  try {
    try { writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* the lock still holds; staleness falls back to the directory's mtime */ }
    return fn();
  } finally { try { rmSync(lock, { recursive: true, force: true }); } catch { /* a leftover lock goes stale */ } }
}

export function createAuditChain(o: AuditChainOptions): AuditChain {
  const dir = o.dir;
  const maxBytes = o.maxBytes ?? 8 * 1024 * 1024;
  const active = join(dir, ACTIVE_FILE);
  const secure = (p: string): void => {
    if (process.platform !== "win32") { try { chmodSync(p, 0o600); } catch { /* best effort on exotic filesystems */ } }
    o.securePath?.(p);
  };

  /** `{ seq, hash }` of the last line on disk: the active file, else the newest rotated one, else the genesis. */
  function state(): { seq: number; hash: string; torn: boolean } {
    const anchor = readAnchor(dir);
    const files = [active, ...listRotated(dir).reverse().map((i) => join(dir, rotatedName(i)))];
    for (const f of files) {
      const t = readTail(f);
      if (t === null || t.raw === null) continue;
      const parsed = t.overflow ? null : parseLine(t.raw);
      // an unparseable last line keeps the chain going from its bytes; its seq comes from the anchor
      const seq = parsed ? parsed.seq : (anchor?.seq ?? 0);
      return { seq, hash: t.overflow ? GENESIS : hashLine(t.raw), torn: !t.terminated && f === active };
    }
    return { seq: 0, hash: GENESIS, torn: false };
  }

  function writeAnchor(a: Anchor): void {
    const tmp = join(dir, `${ANCHOR_FILE}.${process.pid}.tmp`);
    const fd = openSync(tmp, "w", 0o600);
    try { secure(tmp); writeSync(fd, JSON.stringify(a) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, join(dir, ANCHOR_FILE)); return; }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // Windows refuses to replace a file another process has open for a moment
        if (attempt < 20 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) { sleep(5); continue; }
        try { unlinkSync(tmp); } catch { /* leftover tmp is harmless */ }
        throw e;
      }
    }
  }

  function append(e: AuditEvent): { seq: number; hash: string } {
    mkdirSync(dir, { recursive: true });
    return withChainLock(dir, o, () => {
      const st = state();
      const seq = st.seq + 1;
      const line = encodeLine(e, seq, st.hash);
      const bytes = Buffer.from(line + "\n", "utf8");
      if (existsSync(active) && statSync(active).size > 0 && statSync(active).size + bytes.length > maxBytes) {
        const idx = (listRotated(dir).at(-1) ?? 0) + 1;
        renameSync(active, join(dir, rotatedName(idx)));
      }
      const fd = openSync(active, "a", 0o600);
      try {
        secure(active);
        // RULING B5-2: an unterminated last line (torn write) is closed with a newline, never glued onto; it stays in
        // the chain as a line that fails to parse, and verify reports it.
        const lead = fstatSync(fd).size > 0 && st.torn ? Buffer.from("\n") : Buffer.alloc(0);
        writeSync(fd, lead.length ? Buffer.concat([lead, bytes]) : bytes); // one write on an O_APPEND handle
        fsyncSync(fd);
      } finally { closeSync(fd); }
      const hash = hashLine(line);
      writeAnchor({ v: 1, seq, hash, file: ACTIVE_FILE });
      return { seq, hash };
    });
  }

  return {
    append,
    sink: { append: (e) => { append(e); } },
    verify: () => {
      if (!existsSync(dir)) return verifyChain(dir);
      return withChainLock(dir, o, () => verifyChain(dir));
    },
  };
}
