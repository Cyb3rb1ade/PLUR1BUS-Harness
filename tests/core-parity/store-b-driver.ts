// Store round trip, parity mode B (P4-03): the TypeScript side that `crates/plur1bus-store/tests/mode_b.rs` drives.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/store-b-driver.ts prepare <dir>
//   node ... tests/core-parity/store-b-driver.ts verify <dir>
//
// `prepare` writes real TypeScript store files into <dir>: the session store at every schema version through its own
// `migrate()` (`session-v<n>.sqlite`), a node:sqlite file that declares a foreign key without enabling enforcement
// (`fk-declared.sqlite`, the node:sqlite default the Rust store must keep), and `manifest.json` with the session schema
// version and the migration texts. The Rust test then reads and writes copies of them; `verify` reads what Rust left
// behind with the P4-02 helper (`StoreCopy`) and prints one JSON object. Test tooling only; no product code imports it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreCopy, createStoreAtVersion } from "./store-roundtrip.ts";
import { MIGRATIONS, SCHEMA_VERSION, migrate } from "../../packages/core/src/session/migrations.ts";

function prepare(dir: string): void {
  for (let v = 1; v <= SCHEMA_VERSION; v++) createStoreAtVersion({ path: join(dir, `session-v${v}.sqlite`), migrations: MIGRATIONS, version: v, migrate });
  const fk = new DatabaseSync(join(dir, "fk-declared.sqlite"));
  fk.exec("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id)); PRAGMA user_version = 1;");
  fk.close();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ sessionVersion: SCHEMA_VERSION, sessionMigrations: MIGRATIONS }));
}

/** `sqlite_master` without the rows SQLite generates itself, in a stable order: what a migration produced. */
function schemaOf(copy: StoreCopy): unknown[] {
  return copy.read("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
}

function verify(dir: string): Record<string, unknown> {
  const written = StoreCopy.open(join(dir, "session-rust.sqlite"));
  const fk = StoreCopy.open(join(dir, "fk-declared-rust.sqlite"));
  const migrated = StoreCopy.open(join(dir, "session-migrated-by-rust.sqlite"));
  const reference = StoreCopy.open(join(dir, `session-v${SCHEMA_VERSION}.sqlite`));
  try {
    return {
      session: {
        check: written.check(),
        sessions: written.read("SELECT id, kind, agent_id, owner FROM sessions ORDER BY id"),
        messages: written.read("SELECT id, session_id, seq, role, text FROM messages ORDER BY id"),
        search: written.read("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?", "rustwritten").length,
      },
      fkDeclared: { check: fk.check(), children: fk.read("SELECT pid FROM c ORDER BY pid") },
      migrated: {
        userVersion: migrated.userVersion(),
        sameSchema: JSON.stringify(schemaOf(migrated)) === JSON.stringify(schemaOf(reference)),
        integrity: migrated.check().integrity,
      },
    };
  } finally {
    for (const c of [written, fk, migrated, reference]) c.dispose();
  }
}

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== "prepare" && command !== "verify")) {
  console.error("usage: store-b-driver.ts prepare|verify <dir>");
  process.exit(2);
}
if (command === "prepare") prepare(dir);
else console.log(JSON.stringify(verify(dir)));
