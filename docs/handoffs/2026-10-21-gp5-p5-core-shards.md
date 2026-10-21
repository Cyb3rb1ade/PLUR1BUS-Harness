# GP5 P5: Gemessene Core-Shards und Zeitbudgets

Stand: 2026-10-21. Echter Draft-Stack auf P2 #672, Branch `codex/gp5-p2-ci-changes`,
Basis `383443a4b6ce94624104f72d1e382f624a6cd23d`. `origin/main` blieb bei
`1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b`. Verlauf und offene PRs wurden vor Beginn geprüft;
kein vorhandener P5-PR war offen. P4 #695 und S3 #674 werden nicht dupliziert.

## Messquelle und Aufteilung

Einmaliger historischer Abruf, kein CI-Polling:
[erfolgreicher Ubuntu-Lauf 39516791460](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/39516791460),
Head `1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b`, Artefakt `12310137290`
(`test-timings-ubuntu-24.04`). Abruf über
`gh api repos/Cyb3rb1ade/PLUR1BUS-Harness/actions/artifacts/12310137290/zip`.

Die JSON-Dateien des Artefakts enthalten 1137 Dateimessungen. Alle 601 aktuellen Core-Testdateien sind enthalten.
Der Reporter summiert nur Top-Level-Test-/Suitezeiten; verschachtelte Zeiten werden nicht doppelt gezählt.
Die 212,583 s für Core sind **keine** Paket-Wandzeit: Prozessstart, Modulimport und Vorbereitung fehlen.
Der gesamte TS-Schritt dieses Laufs dauerte 710 s, der Ubuntu-Unit-Job 1158 s. Der P1-Snapshot
`/tmp/gp5-ci-baseline.json` enthält zwölf erfolgreiche Ubuntu-Unit-Jobs mit p95 29,03 min;
er enthält keine erfolgreichen macOS-/Windows-Unit-Jobs für eine belastbare neue Budgetableitung.

Die Messwerte stehen mit Herkunft in `.github/ci/core-test-timings.json` und werden auf 0,001 ms gerundet.
Eine Änderung dieser operativen Datei selektiert über P2 konservativ alle Suiten, keinen Doku-only-Lauf.
Zur Aktualisierung die Prozess-JSONs eines abgeschlossenen Ubuntu-Artefakts zusammenführen, Core-Pfade auf
`test/**` relativieren und `durationsMs` erneuern; Herkunfts-Run, Artefakt und Head gemeinsam aktualisieren.

Längste Datei zuerst, jeweils auf den Shard mit der kleinsten bisherigen Summe. Die Reihenfolge bei gleichen
Gewichten ist lexikalisch und damit unabhängig von Glob-Reihenfolgen. Mindestgewicht 100 ms, ungemessene neue
Datei 1000 ms. Gelöschte Dateinamen im Profil werden nicht ausgeführt; neue Dateien werden nie herausgefiltert.
Die 100-ms-Grenze verhindert, dass viele sehr kurze Testkörper als kostenlose Dateien eingeplant werden.

| Ubuntu-Shard | Dateien | Gemeldete Testzeit | Planungsgewicht inklusive 100-ms-Grenze |
|---|---:|---:|---:|
| 1/3 | 198 | 71,012 s | 80,650 s |
| 2/3 | 201 | 71,056 s | 80,650 s |
| 3/3 | 202 | 70,514 s | 80,651 s |

Drei Shards verteilen die beobachtete Last annähernd gleichmäßig, ohne vier vollständige Installations-/Buildläufe
zu erzeugen. Das ist eine Planungsrechnung, keine bewiesene Verkürzung der GitHub-Warteschlange oder Laufzeit.
P1 muss nach Integration erneut messen; zusätzlicher Runner-Bedarf kann den Queue-Anteil verändern.

## Abdeckung und Gates

- Ubuntu `unit` führt alle bisherigen Pakete außer Core aus; derselbe Root-Runner mit Nichtleer-Guard bleibt erhalten.
- Drei unabhängige Ubuntu-Core-Jobs installieren dieselbe eingefrorene Workspace-Abhängigkeit, bauen die Pakete,
  stellen wie bisher Bubblewrap bereit und führen ihren Core-Dateianteil mit unverändertem Node-Testtimeout aus.
- macOS und Windows führen weiter die vollständige, ungeshardete Paketsuite aus. Keine ihrer Testbedingungen wurde gelockert.
- Jeder Shard schreibt ein Manifest. Der Gate-Job verlangt alle drei erfolgreichen Matrix-Läufe und eine exakte
  Partition des aktuellen Core-Inventars: keine Lücke, kein Duplikat, kein Fremdpfad, kein leerer Shard.
- P2 `ci-gate` erwartet sowohl `core-unit-shard` als auch `core-unit`, wenn `ts-core=true` ist. Bei reinem Rust,
  Doku oder Web bleibt die explizite P2-Auswahl gültig. Fehler und Abbruch sind kein zulässiger Skip.
- Die vier Browser-Shards bleiben beim bisherigen Round-Robin-Verfahren. Nur Core setzt das Timing-Profil.

## Zeitbudgets der CI-Jobs

P2 hatte bereits für jeden Job ein Limit. P5 erhält diese und ergänzt die zwei neuen Jobtypen. Die Ubuntu-Messung
ist keine Grundlage, macOS-/Windows-Limits zu senken. Es werden keine längeren Testlimits eingeführt, um Tests grün zu machen.

| Job | Minuten | Grundlage |
|---|---:|---|
| `changes`, `ci-gate` | je 5 | vorhandene lokale Planung/Ergebnisprüfung |
| `docs-hygiene` | 25 | vorhandene Installations-, Rust-/Dokugenerierungsgrenze |
| `unit` | 65; Windows 90 | vorhandene Gesamtgrenze; Ubuntu p95 29,03 min liegt darunter |
| `core-unit-shard` | 20; Testschritt 15 | mehrere Minuten Setup plus <2 min gemeldete Testzeit je Shard, Reserven für Imports/IO/shared Runner |
| `core-unit` | 5 | Artefakte laden und Dateipartition prüfen |
| `system` | 30 | bestehende Stack-, Recall- und Kill-Soak-Akzeptanz |
| `service` | 20 | bestehende Service-Manager-Grenze |
| `python-host` | 45 | bestehende Python-/synthetische Live-Host-Grenze |
| `wsl` | 20 | bestehende Setup-Retry- und Migrationsgrenze |
| `web-browser-build` | 30 | bestehender Rust-/Web-Build |
| `web-browser-shard` | 40; Testschritt 35 | bestehende vier Browser-Suiten |
| `web-browser` | 10 | bestehendes Manifest-/Ergebnis-Gate |
| `release-scripts` | 10 | bestehende Offline-Skripte und actionlint |
| `sandbox` | 20 | bestehende Kernel-/Rust-Helfer-Proben |
| `perf-startup`, `perf-budgets` | je 60 | bestehende echte Modell-/Performance-Messungen |
| `documents-golden` | 15 | bestehender Chrome-Rendervergleich |

## Global langsamste 20 Dateien des Artefakts

Die Ursachen sind aus dem jeweiligen Testcode abgeleitet, keine CPU-Profilierung. Vorschläge sind spätere
Untersuchungen; P5 ändert keine dieser Testdateien, Fallzahlen, Assertions, Sleeps oder Sicherheitsgrenzen.

| Datei unter `packages/` | Sekunden | Im Code sichtbare Arbeit | Vorschlag bei weiterem Engpass |
|---|---:|---|---|
| `core/test/core-supervised.test.ts` | 36,799 | reale Core-/Supervisor-Verbindungen, Lifecycle-/Grace-Waits | Vorbereitungsanteil getrennt messen; echte Stop-/Restart-Proben behalten |
| `core/test/core.test.ts` | 21,312 | viele Core-Starts, persistente Stores, Crash-/Restart-Fälle | immutable Fixture-Erzeugung profilieren; Zustandsisolation erhalten |
| `media/test/adapters.test.ts` | 16,232 | acht Adapter, HTTP-Status-, Retry-, Timeout- und Pollingpfade | Retry-Warteanteil separat messen; alle Protokoll-/Abbruchfälle erhalten |
| `core/test/bin.test.ts` | 13,332 | mehrfacher CLI/Core-Kindprozessstart und Shutdown | Startkosten je Fall berichten; Prozessgrenzen nicht wegmocken |
| `module-api/test/framing-fuzz.test.ts` | 12,334 | deterministischer Fuzz mit tiefen JSON-/großen Frame-Eingaben | Allokationsprofil prüfen; Seed, Fallzahl und Größenbegrenzungsfälle erhalten |
| `core/test/mcp/registry-races.test.ts` | 9,487 | absichtlich verkeilter Server, zwei Grace-Phasen, Ersatzprozess | spätere Timer-Koordination untersuchen; echten SIGKILL-/Reaping-Fall behalten |
| `module-api/test/runtime.test.ts` | 8,651 | Runtime-Kindprozesse, Lock-/Signaltests, doppelte Grace-Wartezeit | Setup und reale Grace-Beobachtung trennen, Assertions unverändert |
| `core/test/host-tools/exec-descendants.test.ts` | 6,563 | echte Prozessgruppen und zwei 3-s-Zeitgrenzen | Schutzprobe bewusst behalten, nur unnötige Setup-Arbeit suchen |
| `core/test/mcp/timeouts.test.ts` | 5,571 | Fristablauf plus reales Kindprozess-Cleanup trotz FakeClock | Timer- und Prozessdauer einzeln protokollieren |
| `core/test/core-drain.test.ts` | 5,043 | blockierte Speicheroperationen, Stop-Zeitpunkt und Restart | Fixture-Aufbau profilieren, Drain-Rennen erhalten |
| `api/test/chats-core.test.ts` | 4,503 | HTTP-Chat über einen realen Core mit synthetischem Provider | Core-Setup gegenüber HTTP-/Turn-Laufzeit messen |
| `documents/test/render-e2e.test.ts` | 4,367 | echte Chromium-PDF-Ausgabe für jedes Template | Browserstartanteil messen; alle Templates und Font-/PDF-Prüfungen erhalten |
| `core/test/mcp/registry.test.ts` | 4,341 | viele MCP-Prozess-/Cache-/Idle-Lifecycle-Fälle | Start-/Teardown-Anteile messen, vollständige Scope-Matrix behalten |
| `remote-access/test/hardening-pairing.test.ts` | 4,277 | Tausende generative Code-/Proof-/Store-Prüfungen | Hotspots der Generierung bestimmen; Fallzahlen/Sicherheitsgrenzen erhalten |
| `providers/test/secrets.test.ts` | 4,237 | Fehler-/Streaming-/Timeoutpfade plus rekursiver Secret-Scan | Wartezeiten und Scan-CPU trennen; alle Ausgabeflächen weiter prüfen |
| `api/test/redteam.test.ts` | 3,639 | HTTP-/Socket-Grenzen, Fristen, Abuse-/Autorisierungsmatrix | Socket-Warteanteil messen; tatsächliche Netzwerk-Grenzproben behalten |
| `core/test/attestation/service-hardening.test.ts` | 3,434 | viele externe Helferprozesse, TTL-/Mismatch-/Abbruchfälle | Helferstartanteil messen, echte Terminierung behalten |
| `core/test/bin-entry.test.ts` | 3,332 | CLI-Starts für Argumente, Fehler, SIGINT und SIGTERM | Dateivorbereitung profilieren, Exit-/Signalbeobachtung erhalten |
| `core/test/logs/logs-writer.coverage.test.ts` | 3,323 | Writer-/Sink-/Rotations-/Retry-Grenzpfade | IO- und Stringverarbeitungs-Hotspots lokalisieren |
| `core/test/integration/core-pipeline.test.ts` | 3,315 | vier Protokolle über Core, Secret-Lease, Tool, Audit und Capture | Fixture-/Core-Startzeit messen; alle vier echten Kompositionspfade erhalten |

## Lokale Verifikation

- Node `v24.21.0`; `node scripts/check-toolchain.mjs`: bestanden.
- TDD: Neue Tests zeigten zuerst die bisherige Round-Robin-Zuordnung statt gemessener Balance,
  fehlende Timing-Datenvalidierung und fehlende Core-Gate-Auswahl. Der reale Test-Paket-Runner wurde mit vier
  temporären Testdateien ausgeführt; anschließend waren ausschließlich die beiden erwarteten Dateien ausgeführt
  und im Manifest verzeichnet. Unbekannte Profilversionen scheitern vor der Testausführung.
- `node --test --test-timeout=120000 scripts/ci/*.test.mjs scripts/run-ts-tests.test.mjs scripts/lint-hygiene.test.mjs scripts/release/test/*.test.mjs`:
  Exit 0, 132 Tests, davon 131 bestanden, 0 fehlgeschlagen, 0 übersprungen und ein vorhandenes TODO:
  `KNOWN GAP: an exception is not scoped to the package it was approved for`
  (`scripts/release/test/audit-policy.test.mjs`, Advisory-Ausnahmen nur nach Advisory-ID gebunden).
- Der Live-Dateikatalog ergibt 601 Dateien in den drei disjunkten Manifesten; die Vereinigung ist exakt vollständig.
  Neue/geänderte/entfernte Dateien, fehlende Shards, Duplikate, deterministische Zuordnung, fehlerhafte Gewichte,
  Gate-Fehler/Abbruch/Skip und die tatsächlichen Jobbedingungen werden offline geprüft.
- `node scripts/lint-hygiene.mjs`, `node scripts/check-doc-links.mjs`, actionlint `1.7.12` mit der
  Repository-Konfiguration sowie `git diff --check`: bestanden. CI bleibt bei actionlint `1.7.7`.
- `pnpm test`: versucht; schon `pretest` scheitert bei `config-schema gen` mit
  `ERR_MODULE_NOT_FOUND: ajv`. Der frische Worktree hat keine installierten Workspace-Abhängigkeiten.
  Die vollständige Paketsuite und die drei echten Core-Shards wurden lokal daher nicht ausgeführt.

Die Runner-Integration benutzt synthetische minimale Testdateien; Gate-/Classifier-Prüfungen benutzen synthetische
Ergebnisse beziehungsweise temporäre Git-Fixtures. Das sind keine Fake-Engine-Akzeptanzen. Keine neuen TODOs,
keine Engine-Pin-/Lockfile-Änderung, keine zusätzlichen Abhängigkeiten, keine Modell-Akzeptanz und kein Polling
laufender CI-Läufe. Die offenen Grenzen sind die lokale Paketvorbereitung und die noch fehlende P1-Messung nach Integration.
