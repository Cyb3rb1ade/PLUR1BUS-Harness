# GP5 P1–P6: CI-Durchsatz und Merge-Queue-Bereitschaft

Stand: 2026-10-21. P6 ist ein echter Draft-Stack auf P5 #710 (`38d380ce022a71e31677e1be74372f332683bd84`),
das auf P2 #672 aufbaut. Vor Beginn wurden Verlauf von `origin/main` und alle offenen PRs erneut geprüft.
Main blieb bei `1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b`; P1 #668, P2 #672, P3 #673, P4 #695 und P5 #710
sind nicht integriert. **Eine Nachher-Messung und ein belegter Durchsatzgewinn liegen nicht vor.**

## Vorher: unveränderte P1-Auswertung

Der vorhandene P1-Snapshot `/tmp/gp5-ci-baseline.json` wurde offline erneut mit exakt
`scripts/ci/timings.mjs` aus P1-Commit `13edd6cd5858a43ce65757df1999f47baa18509e` ausgewertet.
Es wurden keine aktuellen CI-Laufstände abgefragt und keine laufenden Jobs gepollt. SHA-256 des verwendeten Skripts:
`edf68dd665a4bfb691554d63f645af740b837232412dcf41c991b2647e04c380`.

50 Runs, 15 noch unvollständig zum Erhebungszeitpunkt, 22 abgebrochen (44,0 %), 22 mögliche überholte Heads.
Erstellt zwischen 2026-10-20 11:08:56 UTC und 2026-10-21 01:31:06 UTC, Erhebung 01:33:47 UTC.
Die Frequenz verwendet wie P1 mindestens einen Tag als Nenner. Abbruchursachen sind aus der API nicht beweisbar.

| Messgröße | Vorher P1 | Nachher |
|---|---|---|
| Ubuntu Unit Dauer p50/p95 | 1455 / 1742 s, 17 Dauerproben | offen: P2–P5 nicht integriert |
| Ubuntu Unit Wartezeit p50/p95 | 2 / 2604 s, 19 Warteproben | offen |
| macOS Unit Dauer p50/p95 | 1675 / 3762 s, 16 Dauerproben | offen |
| macOS Unit Wartezeit p50/p95 | 2154 / 23283 s, 17 Warteproben | offen |
| Windows Unit Dauer p50/p95 | 2348 / 2381 s, 17 Dauerproben | offen |
| Windows Unit Wartezeit p50/p95 | 3 / 1570 s, 20 Warteproben | offen |
| Browser-Shard 1/4 Dauer p50/p95 | 455 / 657 s, 15 Dauerproben | offen |
| Unit-Läufe pro Tag im P1-Fenster | je 27 für Ubuntu/macOS/Windows | offen |
| Abgebrochene Runs | 22/50 (44,0 %) | offen |
| mögliche durch neueren Head ersetzte Runs | 22; Ursache nicht bewiesen | offen |

Die vollständige Vorher-Tabelle steht im P1-Handoff `2026-10-21-ci-baseline.md` nach dessen Integration.
Wartezeit ist `started_at - created_at` einschließlich Abhängigkeiten und Umgebung, keine reine Runner-Queue-Zeit.
P1 berücksichtigt bei laufenden Jobs nur bekannte Wartezeiten; abgebrochene Jobs tragen partielle Laufzeiten bei.
Diese Stichproben sind kein Benchmark einer vollständig erfolgreich durchlaufenen Suite.

## Was geändert beziehungsweise erhalten wird

| Phase | Ergebnis | Grenze |
|---|---|---|
| P1 #668 | Begrenzte Actions-Erhebung und identische Offline-Auswertung | Snapshot und Zensierung, kein Polling |
| P2 #672 | Konservative Pfadauswahl und fail-closed `ci-gate` | Unknown/Locks/Workflow/Engine-Pin lösen die volle Auswahl aus |
| P3 #673 | Vorhandenen PR-Abbruch getestet | Kein neuer Abbruch von Main-/Release-Läufen |
| P4 #695 | Vorhandene pnpm/Rust/Browser-Caches geprüft, Modell-Saves nur nach Erfolg, Browser-Key mit Architektur | Kein gemessener Hosted-Gewinn; kein sccache hinzugefügt |
| P5 #710 | Drei gemessene Ubuntu-Core-Shards, exakte Partition, Jobbudgets und Top 20 | 198/201/202 Dateien geplant; echte Nachmessung offen |
| P6 | Merge-Group-Trigger, voller Lauf ohne PR-Metadaten, Owner-Anleitung und Nachmessungs-Gate | Queue-Verfügbarkeit und Aktivierung sind Owner-Themen |

Bewusst nicht weiter gefiltert: Main-Push, Nightly, manuelle und Merge-Group-Läufe verwenden die volle CI-Auswahl.
Engine-Pin, Lockfiles, Workflows, unbekannte Pfade und operative Shard-/Messmetadaten werden konservativ behandelt.
Gemeinsame Schemas lösen Rust, TypeScript, Browser und Python aus. Runtime-nahe Service-, Sandbox-, Python-/WSL-
und Performance-Prüfungen bleiben bei Rust-/TypeScript-Änderungen ausgewählt. Plattformabhängige macOS-/Windows-
Core-Abdeckung bleibt vollständig. Unabhängige Desktop-/Container-/Release-Workflows behalten ihre bisherigen Regeln.
Ein Check wird nie wegen Fehler oder Abbruch als bewusst ausgelassen gewertet. Details und Top 20 stehen im P5-Handoff.

## Merge Queue und offene Owner-Frage

`ci.yml` reagiert auf `merge_group.checks_requested`. Planung und finaler Gate laufen auf dem Queue-Commit;
die Planung liest dafür keinen PR-Diff und keine PR-Metadaten. Jeder ausgewählte Job einschließlich aller Core-
und Browser-Shards muss erfolgreich sein. Der Trigger aktiviert keine Queue und ändert den Watcher nicht.

Die Repository-API meldet `private=false`, `owner.type=User`. Laut
[GitHub-Dokumentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
ist die GitHub.com-Funktion für Organisations-Repositories verfügbar. Offene Owner-Frage: Soll nach der technischen
Integration bei verfügbarer Funktion eine Queue aktiviert werden? Empfehlung: Für dieses persönliche Repository
zunächst den bestehenden Controller/Watcher beibehalten; eine mögliche Organisationsübertragung separat entscheiden.
Bei Freigabe und Verfügbarkeit: exaktes `main`, `ci-gate` als Required Check und zunächst Build-Concurrency 1.
Andere Required Checks brauchen vor Aktivierung ebenfalls einen Merge-Group-Trigger. Keine Einstellung wurde geändert.

## Ausführbares Gate für die echte Nachmessung

`.github/ci/throughput-integrations.json` enthält die überprüften P1–P5-Quell-Heads. Das Offline-Skript
`scripts/ci/throughput-after.mjs` verlangt für einen expliziten Integrations-Commit:

1. Alle fünf Quell-Heads sind Vorfahren dieses Commits. Bei Squash-/History-Änderungen müssen die Herkunftsanker
   erst nachvollziehbar neu geprüft werden; ein fehlender Anker wird nicht still akzeptiert.
2. Nur abgeschlossene Runs auf diesem Commit oder Nachfahren und nach dessen Commit-Zeit kommen in die Kohorte.
   Ein unbekannter Head ohne lokal prüfbare Abstammung liefert keinen Nachweis.
3. Mindestens ein Run enthält erfolgreiche Checks für `ci-gate`, `core-unit` und alle drei Core-Shards.
4. Erst dann schreibt es einen P1-kompatiblen Snapshot mit Herkunft und Anzahl ausgeschlossener Runs.

Der aktuelle Main-Head und der historische Snapshot werden mit `P1 is not integrated ...; no after measurement`
abgewiesen. Ein synthetischer vollständiger Git-/Actions-Fixture durchläuft das Gate; alte Heads, offene Runs,
fehlende Phasen und fehlende Core-Checks werden in Tests abgewiesen. Das ist keine echte Nachher-Akzeptanz.

Nach Integration und ausreichend abgeschlossenen Läufen einmalig ausführen, nicht in einer Polling-Schleife:

```bash
(
set -e
git fetch origin main
# Bei später fortgeschrittenem Main den damaligen Integrations-SHA einsetzen:
integration_head="$(git rev-parse origin/main)"
node scripts/ci/throughput-after.mjs --integration "$integration_head" --check-integration
# Exakt denselben P1-Auswerter für beide Seiten verwenden:
git show 13edd6cd5858a43ce65757df1999f47baa18509e:scripts/ci/timings.mjs > /tmp/gp5-p1-timings.mjs
p1_script="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' /tmp/gp5-p1-timings.mjs)"
node "$p1_script" --repo Cyb3rb1ade/PLUR1BUS-Harness --workflow ci.yml --runs 50 --out /tmp/gp5-ci-after-raw
node scripts/ci/throughput-after.mjs --input /tmp/gp5-ci-after-raw.json \
  --integration "$integration_head" --out /tmp/gp5-ci-after-validated.json
node "$p1_script" --input /tmp/gp5-ci-after-validated.json > /tmp/gp5-ci-after-validated.md
)
```

Der Integrations-Commit muss vor dem betrachteten Messfenster liegen und alle P1–P5-Heads enthalten. Sobald Main
später weitergelaufen ist, dafür den damaligen expliziten Integrations-SHA verwenden; ein zu neuer Main-Head kann
zu Recht eine leere Kohorte ergeben. Fehlende Run-Heads gezielt aus ihrer belegten Herkunft nachladen und das
gespeicherte Snapshot-Gate offline erneut auswerten; keine neuen CI-Abfragen dafür starten.

Für den abschließenden Vergleich auf beiden Seiten dieselbe Auswahl abgeschlossener Ereignis-/Branchklassen verwenden
und die tatsächlichen Nenner/Probenzahlen nennen. Die Roh-Baseline enthält noch laufende Runs; ihre Wartezeiten daher
nicht ungekennzeichnet gegen eine nur abgeschlossene Nachher-Kohorte vergleichen. Veränderte Jobnamen (neue Core-Shards
gegen den früher kombinierten Unit-Job) und zusätzliche Installationsarbeit getrennt berichten. Erst nach dieser
Auswertung die offenen Nachher-Zellen ersetzen. Der `/tmp`-Snapshot ist lokal und muss für spätere Reproduktion aufbewahrt werden.

## Lokale Prüfung

- Node `v24.21.0`; `node scripts/check-toolchain.mjs`: bestanden.
- TDD: Der Merge-Group-Trigger fehlte zunächst und der neue Trigger-Test war rot. Das Nachmessungs-Gate und sein
  Vorab-Prüfmodus wurden ebenfalls erst über scheiternde CLI-Fixtures eingeführt. Drei neue Tests bestehen.
- `node --test --test-timeout=120000 scripts/ci/*.test.mjs scripts/run-ts-tests.test.mjs scripts/lint-hygiene.test.mjs scripts/release/test/*.test.mjs`:
  Exit 0; 135 Tests, davon 134 bestanden, 0 fehlgeschlagen, 0 übersprungen und ein vorhandenes TODO
  `KNOWN GAP: an exception is not scoped to the package it was approved for`
  (`scripts/release/test/audit-policy.test.mjs`, Advisory-Ausnahmen nur nach ID).
- `node scripts/lint-hygiene.mjs`, `node scripts/check-doc-links.mjs`, actionlint `1.7.12` mit Repository-Konfiguration
  und `git diff --check`: bestanden. Die CI installiert weiterhin actionlint `1.7.7`.
- Die echte aktuelle Main-Quelle wird sowohl im Vorab-Modus als auch mit dem historischen Snapshot vom Nachmessungs-Gate
  abgewiesen. Es wurde kein echter Nachher-Snapshot erzeugt. Positiv-/Negativpfade des Gates liefen gegen temporäre
  Git-Commits und synthetische Actions-JSONs; keine Fake-Engine- oder Modell-Akzeptanz.
- `pnpm test`: versucht; im frischen Worktree scheitert `pretest` bei `config-schema gen` mit
  `ERR_MODULE_NOT_FOUND: ajv`, da Workspace-Abhängigkeiten fehlen. Die Paketsuite wurde nicht ausgeführt.

Keine neuen TODOs, keine CI-Einstellung, kein Merge, keine Engine-Pin-/Lockfile-Änderung und kein Polling.

## N1 follow-up: corrected integration ancestry and advisory contracts

P5 correction `9f571cb356ebf3372284c47eaf60afba47c139c6` is incorporated by a normal feature merge;
it contains P2 `f09ec4b29fce8491b0c13ecc2df2ca3690efb98f`. Shared Rust fixtures/source parity
select the real Core shards and partition check. Only the two performance diagnostic jobs accept
`success|failure|skipped`; required checks still fail for failure, cancellation, missing or unexpected skips.
Missing/cancelled performance results also fail. The #621 macOS-browser job remains outside this stack until
the Controller applies both sides of the integration recipe in the [N1 handoff](2026-10-21-gp5-n1-ci-contracts.md).

The post-integration preflight now requires corrected P1
`93462118ecf007a93592709d1029c04647201cff`, corrected P2 and corrected P5 above.
P3 `e831e2cbef22b6fe157486e65e8524c9be4b9e8c` and P4
`a2eddba2768cad8436419ad0384148b5a3ff3b24` still match their remote heads and are unchanged.
This prevents an integration containing only the earlier P1/P2/P5 commits from qualifying as corrected after evidence.
The historical baseline and its original collection source remain historical; no new hosted snapshot is claimed.

Node24.21: 61/61 CI script tests and 8/8 Python workflow tests pass. The broader N1 offline command
completes with 139 tests: 138 pass, zero failure/skip, one existing audit-policy TODO. Frozen dependency installation
succeeds unchanged. Toolchain, hygiene, source-quality, documentation links, actionlint and diff checks pass.
The full package suite and Windows baseline were not rerun for this script-only correction. Required-check migration
and merge-queue activation remain disabled until green Windows baseline, refreshed open heads and owner activation.
No Engine pin/lockfile setting or Controller/Watcher behavior changed; no CI polling or main/PR integration occurred.
