// Read-only verification of the audit chain: walks the rotated files in index order, then the active file, one bounded
// read at a time, and compares the end of the chain with the anchor file.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_FILE, GENESIS, forEachLine, hashLine, listRotated, parseLine, readAnchor, rotatedName } from "./chain.ts";

export const FINDING_CODES = ["hash-mismatch", "seq-gap", "bad-line", "rotation-gap", "anchor-mismatch", "anchor-missing"] as const;
export type FindingCode = (typeof FINDING_CODES)[number];
export const ANCHOR_STATES = ["match", "lag", "missing", "mismatch"] as const;
export type AnchorState = (typeof ANCHOR_STATES)[number];

export interface Finding {
  code: FindingCode;
  /** File name only. */
  file: string;
  /** 1-based line in that file; 0 for a finding about a whole file or the anchor. */
  line: number;
  /** A fixed phrase; never content of an audited event. */
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  files: number;
  lines: number;
  lastSeq: number;
  lastHash: string | null;
  anchor: AnchorState;
  findings: Finding[];
  findingsTruncated: boolean;
}

export const MAX_FINDINGS = 50;

export function verifyChain(dir: string): VerifyResult {
  const findings: Finding[] = [];
  let truncated = false;
  const add = (code: FindingCode, file: string, line: number, detail: string): void => {
    if (findings.length >= MAX_FINDINGS) { truncated = true; return; }
    findings.push({ code, file, line, detail });
  };

  const rotated = listRotated(dir);
  const paths: { name: string; path: string }[] = [];
  for (let i = 1; i <= (rotated.at(-1) ?? 0); i++) {
    if (rotated.includes(i)) paths.push({ name: rotatedName(i), path: join(dir, rotatedName(i)) });
    else add("rotation-gap", rotatedName(i), 0, "rotated file is missing");
  }
  if (existsSync(join(dir, ACTIVE_FILE))) paths.push({ name: ACTIVE_FILE, path: join(dir, ACTIVE_FILE) });

  let expectedPrev: string | null = GENESIS; // null: the previous line could not be hashed, accept the next one's claim
  let expectedSeq: number | null = 1;
  let lines = 0, lastSeq: number | null = null, lastHash: string | null = null, beforeLastHash: string | null = null;
  let files = 0;
  for (const f of paths) {
    let lineNo = 0;
    const read = forEachLine(f.path, (l) => {
      lineNo += 1; lines += 1;
      const parsed = l.overflow ? null : parseLine(l.raw);
      if (!parsed) {
        add("bad-line", f.name, lineNo, l.overflow ? "line exceeds the size limit" : "not a chain line");
        expectedSeq = null;
        lastSeq = null;
      } else {
        if (expectedPrev !== null && parsed.prev !== expectedPrev) add("hash-mismatch", f.name, lineNo, "previous-line hash does not match");
        if (expectedSeq !== null && parsed.seq !== expectedSeq) add("seq-gap", f.name, lineNo, `sequence number is not ${expectedSeq}`);
        expectedSeq = parsed.seq + 1;
        lastSeq = parsed.seq;
      }
      beforeLastHash = lastHash;
      lastHash = l.overflow ? null : hashLine(l.raw);
      expectedPrev = lastHash;
    });
    if (read) files += 1;
  }

  const anchor = readAnchor(dir);
  let anchorState: AnchorState;
  if (anchor === null) {
    anchorState = "missing";
    if (lines > 0) add("anchor-missing", "audit.chain.anchor", 0, "anchor file is missing or unreadable");
  } else if (lines === 0) {
    anchorState = "mismatch";
    add("anchor-mismatch", "audit.chain.anchor", 0, "chain is empty but the anchor records lines (truncated or deleted)");
  } else if (lastHash === anchor.hash && lastSeq === anchor.seq) {
    anchorState = "match";
  } else if (beforeLastHash === anchor.hash && lastSeq !== null && lastSeq === anchor.seq + 1) {
    anchorState = "lag"; // RULING B5-3: a crash between the line and the anchor leaves the anchor exactly one line behind
  } else {
    anchorState = "mismatch";
    add("anchor-mismatch", "audit.chain.anchor", 0, "end of the chain does not match the anchor (truncated, replaced or edited at the end)");
  }

  return { ok: findings.length === 0 && !truncated, files, lines, lastSeq: lastSeq ?? 0, lastHash, anchor: anchorState, findings, findingsTruncated: truncated };
}
