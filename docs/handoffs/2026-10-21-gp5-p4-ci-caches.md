# GP5 P4: Cache-Inventar und Speicherbedingungen

Stand: 2026-10-21. Basis: `origin/main` bei `1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b`.
Verlauf und offene PRs wurden vor Beginn geprüft. P2 #672 und S3 #674 sind unabhängig offen;
deren Betroffenheitsanalyse und Pin-Korrektur werden hier nicht erneut umgesetzt.

## Vorhandene Caches und geprüfte Action-Quellen

Die Quellen wurden am 2026-10-21 über die GitHub-API **am verwendeten Commit** gelesen.
Die Prüfung löst keine Workflows aus und liest keine CI-Laufstände.

| Cache | Key und Inhalt | Speicherbedingung |
|---|---|---|
| pnpm über `setup-node` | OS, Architektur, Paketmanager, Hash des Root-Lockfiles; nur der von `pnpm store path --silent` gemeldete Store | `post-if: success()` |
| Rust über `rust-cache` | Job, OS, Architektur, `rustc`-Identität, Toolchain-/Cargo-Konfiguration, Manifeste und Lockfile des jeweiligen Workspaces; Cargo-Registry, Git-Quellen, installierte Cargo-Binaries und Workspace-Target | `post-if: success() || env.CACHE_ON_FAILURE == 'true'`; Restore exportiert ohne Opt-in `CACHE_ON_FAILURE=false` |
| Playwright | OS, neu Architektur, Hash von `pnpm-lock.yaml`; `~/.cache/ms-playwright` | Kombinierte `actions/cache`-Action: `post-if: success()` |
| Modelle | Bestehende modellbezogene Keys; ausschließlich `${{ github.workspace }}/.models-cache` | Standalone-Save nach Erfolg, bei Miss und vorhandenem Inhalt |

Primärquellen der verwendeten Pins:

- `setup-node` [v7.1.0 Action](https://github.com/actions/setup-node/blob/949feb2413d6458794dcd2491c4babbbce0c15c1/action.yml),
  [Key-Bildung](https://github.com/actions/setup-node/blob/949feb2413d6458794dcd2491c4babbbce0c15c1/src/cache-restore.ts),
  [Store-Pfad](https://github.com/actions/setup-node/blob/949feb2413d6458794dcd2491c4babbbce0c15c1/src/cache-utils.ts).
  Der vorhandene [v7.0.0 Pin](https://github.com/actions/setup-node/blob/820762786026740c76f36085b0efc47a31fe5020/action.yml)
  und dessen `src/cache-restore.ts` wurden ebenfalls geprüft: dieselbe Erfolgsbedingung und dieselben Key-Dimensionen.
- `rust-cache` [Action](https://github.com/Swatinem/rust-cache/blob/49a0bdc70d2e1b713ca9e2869b211fcce03d3c1c/action.yml),
  [Konfiguration](https://github.com/Swatinem/rust-cache/blob/49a0bdc70d2e1b713ca9e2869b211fcce03d3c1c/src/config.ts),
  [Restore](https://github.com/Swatinem/rust-cache/blob/49a0bdc70d2e1b713ca9e2869b211fcce03d3c1c/src/restore.ts).
  Beim vorhandenen [v2.9.1 Pin](https://github.com/Swatinem/rust-cache/blob/c19371144df3bb44fab255c43d04cbc2ab54d1c4/action.yml)
  wurden Action-Metadaten sowie `src/config.ts` und `src/restore.ts` ebenfalls geprüft.
- `actions/cache` [v6 Action](https://github.com/actions/cache/blob/55cc8345863c7cc4c66a329aec7e433d2d1c52a9/action.yml)
  bestätigt die Erfolgsbedingung der kombinierten Browser-Action.

`rust-cache` berücksichtigt standardmäßig den Lockfile-Hash im vollständigen Key. Sein absichtlicher Restore-Präfix
ohne Lockfile-Anteil kann ältere Abhängigkeiten unter derselben Toolchain wiederverwenden; Cargo baut die tatsächlich
benötigten Versionen. Eine zweite manuelle Rust- oder pnpm-Cache-Action würde vorhandene Arbeit duplizieren.
Cargo-Credentials und `~/.gitconfig` gehören nicht zu den gecachten Cargo-Pfaden. Kein Cache-Pfad wurde erweitert.
Die private Engine-Abhängigkeit und ihr Installationsweg bleiben erhalten.

## Änderung und Abgrenzung

- Zwei Nightly-Modell-Saves verwendeten `always()`. Sie verlangen jetzt `success()`; ein fehlgeschlagener oder
  abgebrochener Lauf veröffentlicht keinen möglicherweise unvollständigen Modell-Cache.
- Der vorhandene Playwright-Key erhält `${{ runner.arch }}`. Beim ersten Lauf wird ein neuer Cache aufgebaut;
  Linux-Bibliotheken und lockfilepassende Browser werden weiterhin bei jedem Lauf installiert/geprüft.
- Neue Offline-Tests laufen im bestehenden `release-scripts`-Job. Weder Testbefehle noch Matrixabdeckung werden entfernt.
- Kein neuer Action-Pin, kein neues Paket, keine Engine-Pin- oder Lockfile-Änderung.

`sccache` wird nicht hinzugefügt. Es könnte Kompilate zwischen Läufen wiederverwenden, bringt aber ein weiteres
Werkzeug mit eigener Versions-, Lizenz- und Cache-Pflege. Die vorhandenen Cargo-Caches erfüllen P4 bereits;
ein späterer P1-Vergleich sollte erst zeigen, ob Compiler-Misses einen relevanten Restengpass bilden. Es wird
kein Cloud-Backend eingerichtet und kein Durchsatzgewinn ohne Messung behauptet.

## Lokale Prüfung

TDD: Vor den Workflow-Änderungen schlugen der Fehlerfall-Save und die Architektur-Isolation rot fehl.
Nach der Änderung bestehen alle drei Cache-Policy-Tests ohne Skip oder TODO. Die Bedingungen werden mit
Erfolg/Fehler/Abbruch, Hit/Miss und leerem/befülltem Inhalt ausgewertet; der Browser-Key wird mit veränderten
OS-, Architektur- und Lockfile-Werten geprüft. Das sind Offline-Konfigurationsprüfungen mit synthetischen
Auswertungskontexten, keine Messung des GitHub-Cache-Dienstes.

- Node `v24.21.0`; `node scripts/check-toolchain.mjs`: bestanden.
- `node --test --test-timeout=120000 scripts/ci/cache-policy.test.mjs`: 3 bestanden,
  0 fehlgeschlagen, 0 übersprungen, 0 TODOs.
- `TMPDIR=/private/tmp node --test --test-timeout=120000 scripts/ci/*.test.mjs scripts/release/test/*.test.mjs scripts/lint-hygiene.test.mjs`:
  Exit 0; 92 bestanden, 0 fehlgeschlagen, 0 übersprungen, 1 vorhandenes TODO:
  `KNOWN GAP: an exception is not scoped to the package it was approved for`
  (`scripts/release/test/audit-policy.test.mjs`, Audit-Ausnahmen nur nach Advisory-ID).
- Derselbe breite Lauf mit dem voreingestellten macOS-Temp-Pfad: 91 bestanden, 1 fehlgeschlagen,
  0 übersprungen, 1 vorhandenes TODO. Der unveränderte Test
  `the command line runs from a path with spaces (the entry guard used to compare against a raw file:// string)`
  in `scripts/ci/macos-plan.test.mjs` scheitert am Temp-Pfad-Alias: Node realisiert den Skriptpfad,
  der Entry-Guard vergleicht ihn mit dem lexikalischen Aufrufpfad. Der gleiche Fehler wurde im zweiten
  Worktree `gp5-s3-action-pins` mit unveränderten `macos-plan`-Dateien reproduziert (8 bestanden, 1 fehlgeschlagen).
  Der kanonische Temp-Pfad ermöglicht die Vergleichsprüfung; P4 ändert diesen Test und dessen Produktivcode nicht.
- `node scripts/lint-hygiene.mjs`, actionlint `1.7.12` mit der Repository-Konfiguration und
  `git diff --check`: bestanden. Die CI installiert unverändert actionlint `1.7.7`.
- `pnpm test`: im frischen Worktree versucht; `pretest` bricht bereits bei `config-schema gen`
  mit `ERR_MODULE_NOT_FOUND: ajv` ab, weil Workspace-Abhängigkeiten nicht installiert sind.
  Die vollständige Paketsuite wurde nicht ausgeführt. Engine- oder Modell-Akzeptanz lief nicht.

CI wurde nicht gepollt. Keine offene Owner-Frage für P4; keine neuen TODOs.
