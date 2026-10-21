# A5 / #614 follow-up for #608 — 2026-10-21

The Web RPC table now declares `dreams.diary` with its complete result shape (including nullable `path`), the real-Engine test narrows unknown runtime LLM inputs instead of masking them, and the diary axe test supplies its label. A frozen install retained the genuine Engine dependency at `98dfe2f03363f6291daa9f85e473578770fb5c55`; no dependency or committed lockfile changed.

OpenClaw `DREAMS.md` / `dreams.md` now imports into `<agent workspace>/DREAMS.md`, the Engine diary consumed by status and RPC. Default skip preserves an existing file; rename stores history in `DREAMS.openclaw.md` (numbered suffixes when occupied); explicit replace uses the existing rollback backup. Existing `dreaming.md` and source files remain untouched. There is no automatic migration of previously imported legacy diaries and no new diary writer.

Schema descriptions, diary/status fixtures, the RPC index, import guide and ADR-003/009 agree on the workspace-root path. Historical D15 decisions remain labelled as historical. `pnpm gen` and `pnpm docs:gen` produced the RPC documentation and Python schema hash.

Local evidence:

- With the real dependency installed and generated types present, the pre-fix TypeScript check reproduced all eight reported errors; `pnpm typecheck` now passes.
- Import RED: five failures (dry-run/apply canonical path plus skip/rename/replace); GREEN: 16/16 tests across importer and real-Engine diary. The Engine capture test uses flat embeddings and an LLM fixture; the Engine itself writes the narrative and RPC returns those bytes.
- Broader dreams/RPC suite: 314/314, no skips or TODOs.
- Web diary + Dreams: 26/26, no skips, including DE/EN axe, escaped multiline content and refused/missing/empty/truncated states.
- `pnpm lint`, `pnpm docs:check`, toolchain check and `git diff --check` pass.
- Full workspace `pnpm test` was started and remains in progress at handoff; its result must be reported separately. No overall-pass claim is made. Log: `/tmp/memissues-a5-suite.log`.

No Engine pin is needed for A5. `Closes #608` remains appropriate. No CI polling, merge or deployment occurred. Controller owns integration with A2/A3, especially the shared ADR edits.
