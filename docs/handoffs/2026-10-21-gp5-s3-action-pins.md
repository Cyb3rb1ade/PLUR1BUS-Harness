# GP5 S3: Workflow-Pins auf Commit-Objekte vereinheitlicht

Stand: 2026-10-21. Basis: `origin/main` bei `1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b`.
Vor Beginn wurden dessen Verlauf und alle offenen PRs geprüft. #655 liefert HYG-016 bereits;
ein offener S3-PR war nicht vorhanden. Drei vorhandene pnpm-Pins verwendeten schon den Commit.

## Verifizierte Auflösung und Änderung

`git ls-remote https://github.com/pnpm/action-setup.git 'refs/tags/v6' 'refs/tags/v6^{}'`
lieferte am 2026-10-21:

| Referenz | SHA |
|---|---|
| `refs/tags/v6` (annotiertes Tag-Objekt) | `f520eceda224fe1a4aed5a2a27a194379a409996` |
| `refs/tags/v6^{}` (Commit) | `0977fd99725f1db4007ccb2928dbb4e90d06cc86` |

Alle 16 verbliebenen Tag-Objekt-Pins in sechs Workflows verwenden jetzt den Commit:
`ci.yml` (9), `nightly.yml` (3), `hermes-host.yml`, `release-quality.yml`,
`release-smoke.yml` und `release.yml` (je 1). Jede ersetzte Stelle trägt `# v6`.

HYG-016 prüft zusätzlich eine kleine, gepflegte Liste bekannter Tag-Objekt-SHAs.
Sie arbeitet ohne Netz und zusätzliche Abhängigkeiten, auch für zitierte Referenzen und
Action-Unterverzeichnisse. Die Liste belegt keine beliebigen Git-Objekttypen; neue Pins
müssen weiterhin am Ursprungsrepository geprüft werden. Pflegeweg und Grenze stehen in
`docs/ci.md` sowie direkt an der Liste. Engine-Abhängigkeit, Engine-Pin und `pnpm-lock.yaml`
bleiben unverändert.

## Lokale Prüfung

- Node `v24.21.0`; `node scripts/check-toolchain.mjs`: bestanden.
- TDD: Der neue Tag-Objekt-Test schlug zuerst fehl, weil HYG-016 den SHA akzeptierte.
  Nach der Änderung: `node --test --test-timeout=120000 scripts/lint-hygiene.test.mjs`,
  38 bestanden, 0 fehlgeschlagen, 0 übersprungen, 0 TODOs.
- `node scripts/lint-hygiene.mjs`: bestanden.
- `actionlint -shellcheck= -config-file scripts/release/actionlint.yaml .github/workflows/*.yml`:
  bestanden mit lokalem actionlint `1.7.12` (CI installiert unverändert `1.7.7`).
- `node --test --test-timeout=120000 scripts/release/test/*.test.mjs`: Exit 0,
  37 bestanden, 0 fehlgeschlagen, 0 übersprungen, 1 bestehendes TODO:
  `KNOWN GAP: an exception is not scoped to the package it was approved for`
  (`audit-policy.test.mjs`, Audit-Ausnahmen sind nur nach Advisory-ID gebunden).
- `git diff --check`: bestanden.
- `pnpm test`: versucht, aber schon im `pretest` bei `config-schema gen` mit
  `ERR_MODULE_NOT_FOUND: ajv` abgebrochen. Der frische Worktree hat keine installierten
  Workspace-Abhängigkeiten; die vollständige Paketsuite wurde deshalb nicht ausgeführt.

Die Hygiene-Regressionen verwenden temporäre Git-/Workflow-Fixtures; Release-Tests ihre
bestehenden lokalen Fixtures. Es lief keine Engine- oder Modell-Akzeptanz. CI wurde nicht gepollt.
Für S3 gibt es keine offene Owner-Frage und keine neuen TODO-Tests.
