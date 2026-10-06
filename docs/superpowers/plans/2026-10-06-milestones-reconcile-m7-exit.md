# Task 10 — Reconcile `docs/milestones.md` and M7 exit package

**Goal.** (1) Make the §2 effort table of `docs/milestones.md` add up to its stated total without changing any scope. (2) Give M7 an exit package: an import guide and a test report in `docs/import.md`, mapping every item of the 12-point checklist in `docs/superpowers/plans/2026-10-05-m7-importers.md` to the test that proves it. Docs only; no code.

**Files.** `docs/milestones.md`, `docs/import.md`, this plan. A throwaway check script (not committed) verifies the sums and that every referenced test exists.

## Tasks

1. **Plan** (this file), first commit.
2. **Table reconciliation.** Rows take the range of their own section (M2 67–103, M3 40–60, M5 24–38, M6 32–48, M8 21–34, D1 22–33 per the Track D table, D2–D4 31–48 = 10–15 + 15–23 + 6–10). M1 becomes 49–76 (45–70 plus the D111 foundation 4–6 that the §2 total already counted). D109 (6–9 + 3–4 later surfaces) and D106 (7–11) get their own row, `M1b-2b additions`, 16–24. New total 343–527. One "Amended 2026-10-06" note lists every changed number.
3. **Import guide** in `docs/import.md` §10: OpenClaw and Hermes, dry run, apply, rollback, reports.
4. **Test report** in `docs/import.md` §11: the 12 checklist items, each with test file and test name, ticked only when proven; open items stay open with a reason.
5. **Verify**: sum script, test-reference script, `pnpm docs:check`.

## Acceptance → test

| Acceptance | Check |
|---|---|
| Table rows sum to the stated total | sum script (low and high) |
| Every row equals its section range | script compares rows with section `Effort` lines |
| Every ticked checklist item names an existing test | script greps each named file and test title |
| Docs generators stay green | `pnpm docs:check` |
