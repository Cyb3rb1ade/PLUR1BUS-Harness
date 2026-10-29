/** Metadata-only diagnostics use the same full mutable-root and logical SQLite identity as production. */
import { normalizedRoots, scanMutationRoot, streamRegular } from "../../../core/src/import/maintenance-files.ts";
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
