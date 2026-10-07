// B5: the hash-chained audit file. Every line is `{ "seq", "prev", "rec" }` where `rec` is the unchanged D111 audit
// record and `prev` is the SHA-256 of the previous line (its bytes without the line terminator). An anchor in a
// separate file pins the newest (seq, hash), so cutting the tail off is caught too. Rotation renames the active file;
// the next line chains to the last hash of the old file, `seq` carries on.
// Files in `dir`: audit-chain.jsonl (active), audit-chain.<firstSeq:10>.jsonl (rotated), audit-chain.anchor,
// audit-chain.lock. See docs/audit-chain.md.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import type { AuditEvent, AuditSink } from "../rbac/audit.ts";

export const GENESIS_HASH = "0".repeat(64);
export const ACTIVE_NAME = "audit-chain.jsonl";
export const ANCHOR_NAME = "audit-chain.anchor";
const LOCK_NAME = "audit-chain.lock";
const ROTATED = /^audit-chain\.(\d{10})\.jsonl$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_FINDINGS = 50;
// RULING: 8 MiB per file; a chain file is read whole by the verifier, so its size is bounded.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export type FindingCode =
  | "line-malformed" | "hash-mismatch" | "seq-gap" | "prefix-missing" | "file-name-mismatch" | "torn-tail"
  | "anchor-missing" | "anchor-invalid" | "anchor-mismatch" | "truncated";
export interface Finding { code: FindingCode; file: string; line: number | null; seq: number | null }
export type AnchorStatus = "match" | "behind" | "absent" | "invalid" | "ahead" | "mismatch";
export interface VerifyResult {
  ok: boolean; records: number; files: number; lastSeq: number; lastHash: string | null;
  anchor: { status: AnchorStatus; seq: number | null };
  findings: Finding[]; findingsTotal: number;
}

export interface AuditChainOptions {
  dir: string;
  /** Applied once per file after it exists (Windows ACL via the host's `securePath`); POSIX gets 0600 either way. */
  securePath?: (p: string) => void;
  maxBytes?: number;
  lockTimeoutMs?: number;
}
export interface AuditChain extends AuditSink {
  /** Verifies every file and the anchor. Never changes a chain file; takes the writer lock so a line in flight is not seen half-written. */
  verify(): VerifyResult;
  /** Moves the active file aside (a no-op, `null`, when it holds no line). */
  rotate(): string | null;
  readonly dir: string;
}

export const hashLine = (line: string): string => createHash("sha256").update(line, "utf8").digest("hex");

interface Parsed { seq: number; prev: string }
function parse(line: string): Parsed | null {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const rec = o.rec;
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 1 || typeof o.prev !== "string" || !HEX64.test(o.prev)) return null;
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) return null;
  return { seq: o.seq as number, prev: o.prev };
}

const stripCr = (s: string): string => (s.endsWith("\r") ? s.slice(0, -1) : s);

/** Whole-file read: complete lines without terminators (CRLF tolerated), plus an unterminated tail if any. */
function readLines(file: string): { lines: string[]; torn: string | null } {
  const text = readFileSync(file, "utf8");
  if (text === "") return { lines: [], torn: null };
  const parts = text.split("\n");
  const last = parts.pop() as string;
  return { lines: parts.map(stripCr), torn: last === "" ? null : last };
}

/** Offset of the last "\n" strictly before byte `from`, or -1. */
function findNlBack(fd: number, from: number): number {
  const chunk = Buffer.allocUnsafe(65536);
  let pos = from;
  while (pos > 0) {
    const n = Math.min(chunk.length, pos);
    pos -= n;
    readSync(fd, chunk, 0, n, pos);
    const i = chunk.subarray(0, n).lastIndexOf(0x0a);
    if (i >= 0) return pos + i;
  }
  return -1;
}

/** The last complete line of a file without reading all of it, and where an unterminated tail starts. */
function scanTail(file: string): { lastLine: string | null; tornFrom: number | null } {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    if (size === 0) return { lastLine: null, tornFrom: null };
    const lastNl = findNlBack(fd, size);
    const tornFrom = lastNl + 1 < size ? lastNl + 1 : null;
    if (lastNl < 0) return { lastLine: null, tornFrom };
    const prevNl = findNlBack(fd, lastNl);
    const buf = Buffer.allocUnsafe(lastNl - (prevNl + 1));
    readSync(fd, buf, 0, buf.length, prevNl + 1);
    return { lastLine: stripCr(buf.toString("utf8")), tornFrom };
  } finally { closeSync(fd); }
}

function firstLine(file: string): string | null {
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(65536);
    let acc = Buffer.alloc(0); let pos = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n === 0) return null; // no complete line
      acc = Buffer.concat([acc, chunk.subarray(0, n)]); pos += n;
      const i = acc.indexOf(0x0a);
      if (i >= 0) return stripCr(acc.subarray(0, i).toString("utf8"));
    }
  } finally { closeSync(fd); }
}

function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

interface Anchor { seq: number; hash: string }
type AnchorRead = { kind: "absent" } | { kind: "invalid" } | { kind: "ok"; anchor: Anchor };
function readAnchor(file: string): AnchorRead {
  if (!existsSync(file)) return { kind: "absent" };
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (v.v === 1 && Number.isSafeInteger(v.seq) && (v.seq as number) >= 1 && typeof v.hash === "string" && HEX64.test(v.hash)) return { kind: "ok", anchor: { seq: v.seq as number, hash: v.hash } };
  } catch { /* invalid */ }
  return { kind: "invalid" };
}

export function createAuditChain(o: AuditChainOptions): AuditChain {
  const dir = o.dir;
  const active = path.join(dir, ACTIVE_NAME);
  const anchorPath = path.join(dir, ANCHOR_NAME);
  const lockPath = path.join(dir, LOCK_NAME);
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  const lockTimeoutMs = o.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const secured = new Set<string>();
  const secure = (p: string): void => {
    if (secured.has(p)) return;
    if (process.platform !== "win32") chmodSync(p, 0o600); // an existing file may be looser
    o.securePath?.(p);
    secured.add(p);
  };

  const rotatedFiles = (): string[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => ROTATED.test(n)).sort(); // ten digits: lexical = numeric
  };

  const withLock = <T>(fn: () => T): T => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + lockTimeoutMs;
    let lock = acquireExclusiveLock(lockPath);
    while (!lock) {
      if (Date.now() >= deadline) throw new Error("audit-chain: lock timeout");
      sleepSync(5);
      lock = acquireExclusiveLock(lockPath);
    }
    try { return fn(); } finally { lock.release(); }
  };

  /** (seq, hash) of the newest line in the chain, from the active file or else the newest rotated one. */
  const tailState = (): { seq: number; hash: string } => {
    const candidates = [active, ...rotatedFiles().reverse().map((n) => path.join(dir, n))];
    for (const f of candidates) {
      if (!existsSync(f)) continue;
      let t = scanTail(f);
      if (t.tornFrom !== null) {
        // RULING: an unterminated tail is a crashed write. It is moved to a `.torn-<ms>` file (evidence, never silently
        // dropped) and the file is cut back to its last complete line; the line never reached the anchor.
        const bytes = readFileSync(f).subarray(t.tornFrom);
        writeFileSync(`${f}.torn-${Date.now()}`, bytes, { mode: 0o600 });
        truncateSync(f, t.tornFrom);
        t = scanTail(f);
      }
      if (t.lastLine === null) continue;
      const p = parse(t.lastLine);
      if (!p) throw new Error("audit-chain: the last line is not a chain line; refusing to append");
      return { seq: p.seq, hash: hashLine(t.lastLine) };
    }
    return { seq: 0, hash: GENESIS_HASH };
  };

  const rotateLocked = (): string | null => {
    if (!existsSync(active)) return null;
    const first = firstLine(active);
    const p = first === null ? null : parse(first);
    if (!p) return null;
    const name = `audit-chain.${String(p.seq).padStart(10, "0")}.jsonl`;
    const target = path.join(dir, name);
    if (existsSync(target)) throw new Error("audit-chain: rotation target exists");
    renameSync(active, target);
    return name;
  };

  const writeAnchor = (a: Anchor): void => {
    const tmp = `${anchorPath}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, `${JSON.stringify({ v: 1, seq: a.seq, hash: a.hash })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    secure(tmp);
    renameSync(tmp, anchorPath); // replaces atomically; the anchor is never half-written
    secured.delete(anchorPath); // a new inode: re-secure
    secure(anchorPath);
  };

  return {
    dir,
    append(e: AuditEvent): void {
      withLock(() => {
        let st = tailState();
        // Fail closed when the chain is not what the anchor remembers: appending would paper over the tampering.
        const a = readAnchor(anchorPath);
        if (a.kind === "invalid") throw new Error("audit-chain: anchor is invalid; refusing to append");
        if (a.kind === "absent" && st.seq > 0) throw new Error("audit-chain: anchor is missing; refusing to append");
        if (a.kind === "ok") {
          if (a.anchor.seq > st.seq) throw new Error("audit-chain: chain is shorter than its anchor; refusing to append");
          if (a.anchor.seq === st.seq && a.anchor.hash !== st.hash) throw new Error("audit-chain: tail does not match the anchor; refusing to append");
        }
        if (existsSync(active) && statSync(active).size >= maxBytes) { rotateLocked(); st = tailState(); }
        const seq = st.seq + 1;
        const line = JSON.stringify({ seq, prev: st.hash, rec: { at: e.at, actor: e.actor, action: e.action, target: e.target, detail: e.detail } });
        const fd = openSync(active, "a", 0o600);
        try {
          secure(active);
          writeSync(fd, `${line}\n`); // one write on an O_APPEND handle
          fsyncSync(fd);
        } finally { closeSync(fd); }
        writeAnchor({ seq, hash: hashLine(line) });
      });
    },
    rotate(): string | null { return withLock(rotateLocked); },
    verify(): VerifyResult {
      return withLock(() => {
        const findings: Finding[] = [];
        let total = 0;
        const add = (f: Finding): void => { total++; if (findings.length < MAX_FINDINGS) findings.push(f); };
        const files = [...rotatedFiles(), ...(existsSync(active) ? [ACTIVE_NAME] : [])];
        const a = readAnchor(anchorPath);
        let records = 0; let lastSeq = 0; let prevHash = GENESIS_HASH; let anchorHash: string | null = null;
        let started = false; let known = true; // `known`: lastSeq/prevHash still mean something after a malformed line
        for (const name of files) {
          const { lines, torn } = readLines(path.join(dir, name));
          const rotatedSeq = ROTATED.exec(name)?.[1];
          let firstSeqInFile: number | null = null;
          lines.forEach((line, i) => {
            const n = i + 1;
            const p = parse(line);
            if (!p) { add({ code: "line-malformed", file: name, line: n, seq: null }); known = false; prevHash = hashLine(line); started = true; return; }
            if (firstSeqInFile === null) firstSeqInFile = p.seq;
            if (!started) {
              if (p.prev !== GENESIS_HASH || p.seq !== 1) add({ code: "prefix-missing", file: name, line: n, seq: p.seq });
            } else {
              if (p.prev !== prevHash) add({ code: "hash-mismatch", file: name, line: n, seq: p.seq });
              if (known && p.seq !== lastSeq + 1) add({ code: "seq-gap", file: name, line: n, seq: p.seq });
            }
            started = true; known = true; lastSeq = p.seq; prevHash = hashLine(line); records++;
            if (a.kind === "ok" && p.seq === a.anchor.seq) anchorHash = prevHash;
          });
          if (rotatedSeq !== undefined && firstSeqInFile !== null && firstSeqInFile !== Number(rotatedSeq)) add({ code: "file-name-mismatch", file: name, line: 1, seq: firstSeqInFile });
          if (torn !== null) add({ code: "torn-tail", file: name, line: lines.length + 1, seq: null });
        }
        let anchor: VerifyResult["anchor"];
        if (a.kind === "absent") {
          anchor = { status: "absent", seq: null };
          if (records > 0) add({ code: "anchor-missing", file: ANCHOR_NAME, line: null, seq: null });
        } else if (a.kind === "invalid") {
          anchor = { status: "invalid", seq: null };
          add({ code: "anchor-invalid", file: ANCHOR_NAME, line: null, seq: null });
        } else if (a.anchor.seq > lastSeq) {
          anchor = { status: "ahead", seq: a.anchor.seq };
          add({ code: "truncated", file: files.at(-1) ?? ACTIVE_NAME, line: null, seq: a.anchor.seq });
        } else if (anchorHash !== a.anchor.hash) {
          anchor = { status: "mismatch", seq: a.anchor.seq };
          add({ code: "anchor-mismatch", file: ANCHOR_NAME, line: null, seq: a.anchor.seq });
        } else {
          anchor = { status: a.anchor.seq === lastSeq ? "match" : "behind", seq: a.anchor.seq };
        }
        return { ok: total === 0, records, files: files.length, lastSeq, lastHash: records > 0 ? prevHash : null, anchor, findings, findingsTotal: total };
      });
    },
  };
}

/** Writes to every sink; all of them are tried, and the first failure is rethrown (an event that one sink could not record is not recorded). */
export function teeAuditSinks(...sinks: AuditSink[]): AuditSink {
  return {
    append(e) {
      let failure: unknown; let failed = false;
      for (const s of sinks) { try { s.append(e); } catch (err) { if (!failed) { failed = true; failure = err; } } }
      if (failed) throw failure;
    },
  };
}
