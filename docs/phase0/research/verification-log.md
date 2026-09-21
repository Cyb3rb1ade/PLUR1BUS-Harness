# Hands-on verification log (Phase 0)

Results of checks run directly rather than read from documentation. Each entry: what was run, where, result, date.

| ID | Check | Environment | Result | Date |
|----|-------|-------------|--------|------|
| V1 | `node:sqlite` FTS5 availability: `CREATE VIRTUAL TABLE t USING fts5(content)`, insert, `MATCH` + `bm25()` query, `PRAGMA compile_options` | macOS arm64 (owner's machine), Node v26.8.2 (Homebrew) | **OK.** SQLite 3.53.4; compile options include `ENABLE_FTS3, ENABLE_FTS3_PARENTHESIS, ENABLE_FTS5, ENABLE_MATH_FUNCTIONS, ENABLE_RTREE`. bm25 ranking works. | 2026-09-22 |
| V2 | Same as V1 | Linux x64 container, Node v22.22.2 | **OK.** SQLite 3.51.2, `ENABLE_FTS5`. | 2026-09-22 |
| V3 | `gh` CLI availability and auth on the owner's machine for repo creation | macOS arm64 | Logged in as Cyb3rb1ade with `repo` scope; `gh repo create Cyb3rb1ade/PLUR1BUS-Harness --public --license mit` succeeded. | 2026-09-22 |
| V4 | Toolchain on the owner's machine | macOS arm64 | node v26.8.2, pnpm 10.32.1, git 2.55.0 | 2026-09-22 |

Consequences:
- V1/V2: session storage and lexical search can use `node:sqlite` with FTS5 on Node ≥ 22.22 / 24 / 26 without a native add-on; `better-sqlite3` is not required. Windows arm64 and Linux arm64 still to be confirmed in CI (Node's official binaries bundle the same SQLite build, so no difference is expected).
- Not yet verified hands-on: `onnxruntime-node` and `@lancedb/lancedb` load on Windows arm64; `node-pty` prebuild on Windows arm64. Planned for the M1/M2 CI matrix.
