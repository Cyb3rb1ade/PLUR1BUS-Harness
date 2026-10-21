# A5 / #614 follow-up for #608 — 2026-10-21

The Web RPC table declares the complete `dreams.diary` result (nullable `path` included), the real-Engine test narrows unknown runtime LLM inputs, and the diary axe test supplies its label. Frozen installation uses the genuine Engine dependency at `98dfe2f03363f6291daa9f85e473578770fb5c55`; no dependency or committed lockfile changed.

OpenClaw `DREAMS.md` / `dreams.md` imports into `<agent workspace>/DREAMS.md`, consumed by Engine, status and RPC. Default skip preserves an existing file; rename stores history in `DREAMS.openclaw.md` (numbered when occupied); explicit replace uses the established rollback backup. Existing `dreaming.md` and source files remain untouched. Previously imported legacy diaries are not migrated automatically; no second diary writer is introduced. Schema, fixtures, import guide and ADR-003/009 document the workspace-root path; generated RPC docs and Python schema hash come from generation.

Current local evidence (Node 24.21 / pnpm 10.28 / Rust 1.95):

- The real installed dependency reproduced all eight reported type errors before the fixes; typecheck now passes.
- Import RED: five expected failures (canonical dry-run/apply path and skip/rename/replace); GREEN: 16/16 importer + real-Engine diary. Flat embeddings/fixture LLM produce an actual Engine diary, and RPC returns those bytes.
- After the main update: diary/Dreams plus previously failing Chat/Users Web files 39/39, no skips/TODOs, including DE/EN axe. The broader dreams/RPC suite is also rechecked after the update (314/314, no skips/TODOs).
- `pnpm gen`, `pnpm docs:gen`, `pnpm typecheck`, `pnpm lint`, `pnpm docs:check`, toolchain and diff checks pass.

The original full workspace run reported 17,853 tests: 17,616 pass / 11 fail / 50 skipped / 176 TODO. Two Web failures reproduced in isolation (8/10 pass): Chat keyboard stale-revision alert timeout and Users rights save missing the `main:null` write. A fresh exact-main `1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b` worktree passed those files 13/13, proving these were missing upstream fixes in this older branch, not a current-main baseline or proven load flake.

A normal **feature-branch** merge of that main commit brings its existing fixes without duplicate cherry-picks. Only the generated Python schema hash conflicted; `pnpm gen` resolved it. Dependency/pin/lockfiles were unchanged. The final PR diff against main contains A5 only; Chat/Users sources are inherited unchanged from main. The primary checkout and main branch were not modified. No second whole-workspace run is claimed after this update; focused checks above were rerun.

The remaining nine macOS containment/rollback failures belong to the main baseline fixed by #671. The current merged A5 source, original failing tests and helpers are byte-identical to main; a fresh focused run confirms 80 tests / 71 pass / the same nine fail. A2 independently reproduced them against matching-main code before its fix and passes 83/83 afterward. Integrate #671 through the Controller rather than duplicating those fixes here. Logs: `/tmp/memissues-a5-suite.log`, `/tmp/memissues-a5-merge-mac-baseline.log`, `/tmp/memissues-a2-main-baseline.md`. No separate full-main test run is claimed.

No Engine pin is needed for A5; `Closes #608` remains appropriate. No CI polling, PR integration merge or deployment occurred. Controller owns integration with A2/A3, especially the shared ADR edits.
