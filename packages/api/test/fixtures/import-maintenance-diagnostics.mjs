/** Metadata-only diagnostics use the same full mutable-root and logical SQLite identity as production. */
import { join } from "node:path";
import { readColdBytes, normalizedRoots, scanMutationRoot, streamRegular } from "../../../core/src/import/maintenance-files.ts";
import { logicalSqliteFingerprint } from "../../../core/src/import/sqlite-fingerprint.ts";

export async function snapshot(roots) {
  const result = [];
  for (const root of normalizedRoots(roots)) {
    const sqlite = new Set();
    const value = await scanMutationRoot(root, { file: async (full, path) => {
      if (["-wal", "-shm"].some(suffix => path.endsWith(suffix) && sqlite.has(path.slice(0, -suffix.length)))) {
        return { sha256: "0".repeat(64), size: 0 };
      }
      const logical = await logicalSqliteFingerprint(full);
      if (logical) { sqlite.add(path); return { sha256: logical, size: 0 }; }
      return streamRegular(full);
    } });
    result.push({ root: root.id, kind: root.kind, existed: value.existed,
      entries: value.entries.filter(entry => !["-wal", "-shm"].some(suffix =>
        entry.path.endsWith(suffix) && sqlite.has(entry.path.slice(0, -suffix.length)))) });
  }
  return result;
}

export function diff(before, after) {
  const rows = snapshot => new Map(snapshot.flatMap(root => [
    [`${root.root}\0`, { root: root.root, path: ".", kind: root.kind, existed: root.existed }],
    ...root.entries.map(entry => [`${root.root}\0${entry.path}`, { root: root.root, ...entry }]),
  ]));
  const prior = rows(before), current = rows(after), result = [];
  for (const key of [...new Set([...prior.keys(), ...current.keys()])].sort()) {
    const left = prior.get(key) ?? null, right = current.get(key) ?? null;
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    const metadata = value => { if (!value) return null; const { root: _root, path: _path, ...rest } = value; return rest; };
    const entry = right ?? left;
    result.push({ root: entry.root, path: entry.path, before: metadata(left), after: metadata(right) });
  }
  return result;
}


/** Fixed labels and counts only; never emit report messages, source paths or card content. */
export function summarizeReport(report) {
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : null;
  const knownReasons = new Set(["source-unreadable", "entity-failed", "duplicate-agent-id",
    "rejected", "timeout", "aborted", "test-entity-failed"]);
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  const reasons = {};
  for (const error of errors.slice(0, 100)) {
    const reason = knownReasons.has(error?.reason) ? error.reason : "other";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { status: "read", errors: count(errors.length), reasons, reasonsTruncated: errors.length > 100,
    agentsRejected: count(report?.counts?.agentsRejected),
    memoryCardsImported: count(report?.counts?.memoryCardsImported),
    memoryCardsRejected: count(report?.counts?.memoryCardsRejected),
    skillsFailed: count(Array.isArray(report?.skills)
      ? report.skills.filter(skill => ["failed", "refused"].includes(skill?.outcome)).length : 0) };
}

export async function failureReports(home, runId) {
  const result = {};
  for (const [label, parts] of [["import", []], ["skills", ["skills"]]]) {
    try {
      const bytes = await readColdBytes(join(home, "imports", runId, ...parts, "report.json"), 512 * 1024);
      result[label] = summarizeReport(JSON.parse(bytes.toString("utf8")));
    } catch {
      result[label] = { status: "unavailable" };
    }
  }
  return result;
}
