// B5: the hash-chained audit file. Every line is `{ "seq", "prev", "rec" }` where `rec` is the unchanged D111 audit
// record and `prev` is the SHA-256 of the previous line (its bytes without the line terminator). An anchor in a
// separate file pins the newest (seq, hash), so cutting the tail off is caught too. Rotation renames the active file;
// the next line chains to the last hash of the old file, `seq` carries on.
// Files in `dir`: audit-chain.jsonl (active), audit-chain.<firstSeq:10>.jsonl (rotated), audit-chain.anchor,
// audit-chain.lock. See docs/audit-chain.md.
// Recovery: the one crash state a writer heals itself is "the newest line is fsynced but the anchor still names the line
// before it" (append writes the line first, the anchor second). Every other disagreement between chain and anchor stays a
// refusal; `plur1bus audit reanchor` (the Rust CLI) starts a new era and keeps the old files as `*.pre-reanchor-<ms>`.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { hostname, userInfo } from "node:os";
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
/** First event of a new chain era, written by `plur1bus audit reanchor`. */
export const REANCHORED_ACTION = "audit.chain.reanchored";
/** Written by a writer that moved a trailing anchor forward after an interrupted append. */
export const ANCHOR_ADVANCED_ACTION = "audit.chain.anchor-advanced";
// `audit-chain[.<seq:10>].jsonl.pre-reanchor-<ms>` and `audit-chain.anchor.pre-reanchor-<ms>`: a chain era set aside by a reanchor.
const ASIDE = /^(audit-chain(?:\.\d{10})?\.jsonl|audit-chain\.anchor)\.pre-reanchor-(\d{1,16})$/;
// The first-seq group of a rotated file set aside by a reanchor.
const ROTATED_ASIDE = /^audit-chain\.(\d{10})\.jsonl\.pre-reanchor-\d{1,16}$/;
const ASIDE_SUFFIX = /^pre-reanchor-\d{1,16}$/;
// RULING: 8 MiB per file; a chain file is read whole by the verifier, so its size is bounded.
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export type FindingCode =
  | "line-malformed" | "hash-mismatch" | "seq-gap" | "prefix-missing" | "file-name-mismatch" | "torn-tail"
  | "anchor-missing" | "anchor-invalid" | "anchor-mismatch" | "truncated";
export interface Finding { code: FindingCode; file: string; line: number | null; seq: number | null }
export type AnchorStatus = "match" | "behind" | "absent" | "invalid" | "ahead" | "mismatch";
/** A `audit.chain.reanchored` event in the current chain: an era boundary, reported as a note and never as a finding. */
export interface ReanchorNote { seq: number; file: string; line: number; at: number | null; suffix: string | null }
/** A chain era set aside by a reanchor, verified only up to its first deviation (the deviation is why it was set aside). */
export interface PreviousChain {
  /** `pre-reanchor-<ms>`: the suffix its files carry. */
  suffix: string;
  /** False when no reanchor event in the current chain names this suffix (a crash between the renames and the event, or files put there by hand). */
  announced: boolean;
  files: number; records: number; lastSeq: number; lastHash: string | null;
  /** Whether the whole set was read without a deviation and its anchor matched. */
  intact: boolean;
  firstBreak: Finding | null;
  anchor: { status: AnchorStatus; seq: number | null };
}
export interface VerifyResult {
  ok: boolean; records: number; files: number; lastSeq: number; lastHash: string | null;
  anchor: { status: AnchorStatus; seq: number | null };
  findings: Finding[]; findingsTotal: number;
  /** Era boundaries of the current chain. They do not make `ok` false. */
  reanchors: ReanchorNote[];
  /** Chains set aside by those reanchors, each checked up to its first deviation. They do not make `ok` false either. */
  previousChains: PreviousChain[];
}

export interface AuditChainOptions {
  dir: string;
  /** Applied once per file after it exists (Windows ACL via the host's `securePath`); POSIX gets 0600 either way. */
  securePath?: (p: string) => void;
  maxBytes?: number;
  lockTimeoutMs?: number;
}
export type ChainRecord = Omit<AuditEvent, "target"> & { target: string | null };
export interface AuditChain extends AuditSink {
  append(e: ChainRecord): void;
  /** Verifies every file and the anchor. Never changes a chain file; takes the writer lock so a line in flight is not seen half-written. */
  verify(): VerifyResult;
  /** Moves the active file aside (a no-op, `null`, when it holds no line). */
  rotate(): string | null;
  readonly dir: string;
}

/** The record must survive `JSON.stringify` unchanged: a NaN/Infinity `at` would become `null`, an `undefined` field would vanish. */
function assertRecordable(e: ChainRecord): void {
  const o = e as unknown as Record<string, unknown>;
  const actor = o.actor as Record<string, unknown> | null | undefined;
  const plain = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);
  const ok = typeof o.at === "number" && Number.isFinite(o.at) && o.at >= 0
    && plain(actor) && typeof actor?.user === "string" && typeof actor?.host === "string"
    && typeof o.action === "string" && (typeof o.target === "string" || o.target === null) && plain(o.detail);
  if (!ok) throw new Error("audit-chain: invalid event; refusing to record it");
}

export const hashLine = (line: string): string => createHash("sha256").update(line, "utf8").digest("hex");

interface Parsed { seq: number; prev: string; reanchor: { at: number | null; suffix: string | null } | null }
function parse(line: string): Parsed | null {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const rec = o.rec;
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 1 || typeof o.prev !== "string" || !HEX64.test(o.prev)) return null;
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) return null;
  // Only a reanchor event is looked into, and only for a timestamp and a suffix that matches the file naming: nothing else of a record is exposed.
  let reanchor: Parsed["reanchor"] = null;
  const r = rec as Record<string, unknown>;
  if (r.action === REANCHORED_ACTION) {
    const d = r.detail;
    const named = typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>).asideSuffix : undefined;
    reanchor = {
      at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : null,
      suffix: typeof named === "string" && ASIDE_SUFFIX.test(named) ? named : null,
    };
  }
  return { seq: o.seq as number, prev: o.prev, reanchor };
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

/** The newest line of the chain as the writers see it; `prev` is that line's own back-link (GENESIS for an empty chain). */
interface Tail { seq: number; hash: string; prev: string }

/**
 * What a writer does about the anchor. Only one disagreement is healed: the newest line is exactly one line past the anchor and
 * chains to the anchor's hash, i.e. the line is complete and correctly linked and only the anchor write after it was lost
 * (a crash or SIGKILL between the fsync of the line and the rename of the anchor). A missing anchor is never healed, not even
 * for a one-line chain: an existing test pins that deleting the anchor is a refusal, and a crash during the very first write
 * of an installation is left to `plur1bus audit reanchor`. Every other disagreement is a refusal as well. `append`
 * additionally checks that the line before the newest one really hashes to the anchor's hash (`lineBeforeTailHashes`).
 */
type Verdict = { kind: "agree" } | { kind: "advance" } | { kind: "refuse"; why: string };
function judge(st: Tail, a: AnchorRead): Verdict {
  if (a.kind === "invalid") return { kind: "refuse", why: "anchor is invalid" };
  if (a.kind === "absent") return st.seq === 0 ? { kind: "agree" } : { kind: "refuse", why: "anchor is missing" };
  if (a.anchor.seq > st.seq) return { kind: "refuse", why: "chain is shorter than its anchor" };
  if (a.anchor.seq === st.seq && a.anchor.hash === st.hash) return { kind: "agree" };
  if (st.seq === a.anchor.seq + 1 && st.prev === a.anchor.hash) return { kind: "advance" };
  return { kind: "refuse", why: "tail does not match the anchor" };
}

function actorOfThisProcess(): { user: string; host: string } {
  let user = "";
  try { user = userInfo().username; } catch { /* no passwd entry */ }
  return { user: user === "" ? "unknown" : user, host: hostname() || "localhost" };
}

export function createAuditChain(o: AuditChainOptions): AuditChain {
  const dir = o.dir;
  const active = path.join(dir, ACTIVE_NAME);
  const anchorPath = path.join(dir, ANCHOR_NAME);
  const lockPath = path.join(dir, LOCK_NAME);
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  const lockTimeoutMs = o.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const secured = new Map<string, string>();
  const secure = (p: string): void => {
    const st = statSync(p, { bigint: true });
    const inode = `${st.dev}:${st.ino}`;
    if (secured.get(p) === inode) return;
    if (process.platform !== "win32") chmodSync(p, 0o600); // an existing file may be looser
    o.securePath?.(p);
    secured.set(p, inode);
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
    try { secure(lockPath); return fn(); } finally { lock.release(); }
  };

  /** Suffixes (`pre-reanchor-<ms>`) of the chain eras a reanchor set aside, oldest first. */
  const asideSuffixes = (): string[] => {
    if (!existsSync(dir)) return [];
    const found = new Set<string>();
    for (const n of readdirSync(dir)) { const m = ASIDE.exec(n); if (m) found.add(`pre-reanchor-${m[2]}`); }
    return [...found].sort((x, y) => Number(x.slice("pre-reanchor-".length)) - Number(y.slice("pre-reanchor-".length)));
  };

  /**
   * One set-aside era, read like a chain but only up to its first deviation: that deviation is usually why it was set aside, so
   * it is reported here and never counted against the current chain. A set whose first line does not start at the genesis hash
   * is read the same way (a deviation at line 1).
   */
  const verifyAside = (suffix: string, announced: boolean): PreviousChain => {
    const names = readdirSync(dir).filter((n) => { const m = ASIDE.exec(n); return m !== null && `pre-reanchor-${m[2]}` === suffix && !m[1]?.endsWith(".anchor"); });
    // rotated files by their first seq (ten digits: lexical = numeric), the active file of that era last
    names.sort((x, y) => (x.startsWith(`${ACTIVE_NAME}.`) ? 1 : 0) - (y.startsWith(`${ACTIVE_NAME}.`) ? 1 : 0) || (x < y ? -1 : x > y ? 1 : 0));
    const anchorName = `audit-chain.anchor.${suffix}`;
    const a = readAnchor(path.join(dir, anchorName));
    let records = 0; let lastSeq = 0; let prevHash = GENESIS_HASH; let anchorHash: string | null = null;
    let firstBreak: Finding | null = null; let started = false;
    outer: for (const name of names) {
      const { lines, torn } = readLines(path.join(dir, name));
      const first = ROTATED_ASIDE.exec(name)?.[1];
      let firstSeqInFile: number | null = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string; const n = i + 1;
        const p = parse(line);
        if (!p) { firstBreak = { code: "line-malformed", file: name, line: n, seq: null }; break outer; }
        if (firstSeqInFile === null) firstSeqInFile = p.seq;
        if (!started) {
          if (p.prev !== GENESIS_HASH || p.seq !== 1) { firstBreak = { code: "prefix-missing", file: name, line: n, seq: p.seq }; break outer; }
        } else if (p.prev !== prevHash) { firstBreak = { code: "hash-mismatch", file: name, line: n, seq: p.seq }; break outer; }
        else if (p.seq !== lastSeq + 1) { firstBreak = { code: "seq-gap", file: name, line: n, seq: p.seq }; break outer; }
        started = true; lastSeq = p.seq; prevHash = hashLine(line); records++;
        if (a.kind === "ok" && p.seq === a.anchor.seq) anchorHash = prevHash;
      }
      if (first !== undefined && firstSeqInFile !== null && firstSeqInFile !== Number(first)) { firstBreak = { code: "file-name-mismatch", file: name, line: 1, seq: firstSeqInFile }; break; }
      if (torn !== null) { firstBreak = { code: "torn-tail", file: name, line: lines.length + 1, seq: null }; break; }
    }
    let anchor: PreviousChain["anchor"];
    if (a.kind === "absent") anchor = { status: "absent", seq: null };
    else if (a.kind === "invalid") anchor = { status: "invalid", seq: null };
    else if (a.anchor.seq > lastSeq) anchor = { status: "ahead", seq: a.anchor.seq };
    else if (anchorHash !== a.anchor.hash) anchor = { status: "mismatch", seq: a.anchor.seq };
    else anchor = { status: a.anchor.seq === lastSeq ? "match" : "behind", seq: a.anchor.seq };
    const intact = firstBreak === null && (anchor.status === "match" || anchor.status === "behind");
    return { suffix, announced, files: names.length, records, lastSeq, lastHash: records > 0 ? prevHash : null, intact, firstBreak, anchor };
  };

  /** (seq, hash) of the newest line in the chain, from the active file or else the newest rotated one. */
  const tailState = (): Tail => {
    const candidates = [active, ...rotatedFiles().reverse().map((n) => path.join(dir, n))];
    for (const f of candidates) {
      if (!existsSync(f)) continue;
      let t = scanTail(f);
      if (t.tornFrom !== null) {
        // RULING: an unterminated tail is a crashed write. It is moved to a `.torn-<ms>` file (evidence, never silently
        // dropped) and the file is cut back to its last complete line; the line never reached the anchor.
        const bytes = readFileSync(f).subarray(t.tornFrom);
        // Never overwrite earlier evidence: two crashes within one millisecond get distinct names.
        let tornPath = `${f}.torn-${Date.now()}`;
        for (let n = 1; existsSync(tornPath); n++) tornPath = `${f}.torn-${Date.now()}-${n}`;
        writeFileSync(tornPath, bytes, { mode: 0o600, flag: "wx" });
        secure(tornPath);
        truncateSync(f, t.tornFrom);
        t = scanTail(f);
      }
      if (t.lastLine === null) continue;
      const p = parse(t.lastLine);
      if (!p) throw new Error("audit-chain: the last line is not a chain line; refusing to append");
      return { seq: p.seq, hash: hashLine(t.lastLine), prev: p.prev };
    }
    return { seq: 0, hash: GENESIS_HASH, prev: GENESIS_HASH };
  };

  /** Whether the complete line before the newest one (across rotated files) hashes to `expected`: the anchored line is still what the anchor pinned. */
  const lineBeforeTailHashes = (expected: string): boolean => {
    let seen = 0;
    for (const f of [active, ...rotatedFiles().reverse().map((n) => path.join(dir, n))]) {
      if (!existsSync(f)) continue;
      const { lines } = readLines(f);
      for (let i = lines.length - 1; i >= 0; i--) if (++seen === 2) return hashLine(lines[i] as string) === expected;
    }
    return false;
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
    secured.delete(active); // the next active file is a new inode: re-secure it
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

  /** Rotates when the active file is full, then writes one line chained to `st` and moves the anchor. Returns the new tail. */
  const writeLine = (start: Tail, e: ChainRecord): Tail => {
    let st = start;
    if (existsSync(active) && statSync(active).size >= maxBytes) { rotateLocked(); st = tailState(); }
    const seq = st.seq + 1;
    const line = JSON.stringify({ seq, prev: st.hash, rec: { at: e.at, actor: e.actor, action: e.action, target: e.target, detail: e.detail } });
    const fd = openSync(active, "a", 0o600);
    try {
      secure(active);
      writeSync(fd, `${line}\n`); // one write on an O_APPEND handle
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const hash = hashLine(line);
    writeAnchor({ seq, hash });
    return { seq, hash, prev: st.hash };
  };

  return {
    dir,
    append(e: ChainRecord): void {
      assertRecordable(e);
      withLock(() => {
        let st = tailState();
        // Fail closed when the chain is not what the anchor remembers: appending would paper over the tampering.
        const verdict = judge(st, readAnchor(anchorPath));
        if (verdict.kind === "refuse") throw new Error(`audit-chain: ${verdict.why}; refusing to append`);
        if (verdict.kind === "advance") {
          // The extra line chains to the anchor's hash; the line the anchor pinned must still be that line.
          if (!lineBeforeTailHashes(st.prev)) throw new Error("audit-chain: tail does not match the anchor; refusing to append");
          // RULING: the one recoverable crash state (see `judge`). The anchor is pulled up to the line it missed, and that is
          // recorded in the chain itself, ahead of the event being appended, so the recovery is visible to every later verify.
          const from = st.seq - 1;
          writeAnchor({ seq: st.seq, hash: st.hash });
          st = writeLine(st, { at: Date.now(), actor: actorOfThisProcess(), action: ANCHOR_ADVANCED_ACTION, target: ANCHOR_NAME, detail: { fromSeq: from, toSeq: st.seq, writer: "core" } });
        }
        writeLine(st, e);
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
        const reanchors: ReanchorNote[] = [];
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
            if (p.reanchor) reanchors.push({ seq: p.seq, file: name, line: n, at: p.reanchor.at, suffix: p.reanchor.suffix });
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
        const named = new Set(reanchors.map((r) => r.suffix));
        const previousChains = asideSuffixes().map((suffix) => verifyAside(suffix, named.has(suffix)));
        return { ok: total === 0, records, files: files.length, lastSeq, lastHash: records > 0 ? prevHash : null, anchor, findings, findingsTotal: total, reanchors, previousChains };
      });
    },
  };
}

/** Writes to every sink; all of them are tried, and the first failure is rethrown (an event that one sink could not record is not recorded). */
export function teeAuditSinks(...sinks: { append(e: ChainRecord): void }[]): { append(e: ChainRecord): void } {
  return {
    append(e) {
      let failure: unknown; let failed = false;
      for (const s of sinks) { try { s.append(e); } catch (err) { if (!failed) { failed = true; failure = err; } } }
      if (failed) throw failure;
    },
  };
}
