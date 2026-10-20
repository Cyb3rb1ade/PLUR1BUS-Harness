# Großpaket 4 G4: Leihe-Datenmodell

Basis: `31f8dd62cb1bf022ae99cae58a9538e38df5c918`.

## Ausführbarer Kurzplan

1. [Föderations-Spec](../superpowers/specs/2026-10-19-federation-cluster-design.md) §7.3/Q9/Q10/Q13/Q14,
   [WP12](../superpowers/plans/2026-10-19-federation-cluster.md) und
   [D116 §12](../superpowers/specs/2026-10-20-memory-tree-relationships-design.md) prüfen.
2. Zuerst rote Tests unter `packages/core/test/federation/` für Fristen, Terminalzustände,
   Projektbindung, gruppierten Rückfluss und wiederholte Bestätigungen ausführen.
3. Reine Modelle unter `packages/core/src/federation/loan-model.ts` und
   `loan-memory-policy.ts` implementieren. Keine Laufzeitintegration.
4. Föderationstests, Typecheck, Dokumentlinks und Diff prüfen; Transitionen unabhängig
   von den Implementierungszweigen gegen die Fristen und Terminalinvarianten lesen.
5. Handoff mit Ergebnissen und Grenzen ergänzen; Owner-Commit, regulärer Push, Ready-PR.

Die beiden lokalen Sichten bleiben getrennt: beim Entleiher endet die Mission nach 24 h
fehlendem Kontakt zum Verleiher; beim Verleiher zählt sie nach 15 min fehlendem Kontakt
zum Entleiher als zurückgegeben. Ein gültiger später Kontakt darf keinen bereits erreichten
Terminalzustand wieder öffnen. Zeitgrenzen gelten einschließlich ihres Ablaufzeitpunkts.
Die letzte gültige Bestätigung ist der konservative Startpunkt der Offline-Frist.

## Ergebnis und Vertragsgrenzen

`loan-model.ts` enthält ausschließlich unveränderliche Zustände und reine Übergänge.
Angebot → Annahme → aktiv/pausiert setzt eine Lease voraus; Recall, Widerruf, Rückgabe,
Ablehnung, Ablauf und Offline-Timeout sind terminal. Ein Tick und jede neue Transition
werten zuerst die Fristen aus, damit ein verspätetes Renewal nicht wiederbelebt.
Die reine Arbeitsentscheidung prüft die Fristen zusätzlich ohne vorherigen Tick.

| Regel | Modell |
|---|---|
| Lease / Heartbeat | 120 s / 30 s; Lease nie über Missionsende hinaus |
| Verleiher unerreichbar | Entleiher pausiert bei Lease-Ablauf; nach 24 h endet die lokale Mission |
| Entleiher unerreichbar | Verleiher meldet nach 15 min `returned-by-timeout` |
| Missionsdauer | höchstens 30 Tage ab Angebot; Ablauf einschließlich Grenzzeitpunkt |
| Projekt | genau ein `borrowerProjectId`, nur im lokalen Entleiherzustand; Verleihersicht und Batches enthalten es nicht |
| Eigentum | bleibt beim Verleiher; das Modell sperrt den heimischen Agenten nicht |

`loan-memory-policy.ts` enthält nur Referenzen und Inhalts-Hashes, keine Erinnerungsinhalte.
Kontinuierliche Batches sind sofort bildbar, auch für den abschließenden Rückfluss. Sie sind
nach Beziehung **und** Stufe getrennt, kanonisch sortiert und durch SHA-256 identifiziert.
`receiveMemoryBatch` liefert direkt importierbare **Deskriptoren**, aber führt keinen Import aus.
Es prüft Mission/Agent/Peer, bewahrt `rel:<agentId>:peer:<borrowerFingerprint>:<personKey>`,
Stufe, Missionskontext, Herkunft und Taint. Exakte Wiederholungen und überlappende Batches
importieren im Modell jede Erinnerungs-ID nur einmal. Abweichender Hash, Beziehung oder Stufe
bei bereits angenommener ID ist ein Konflikt, keine stillschweigende Änderung.
Bestätigungen sind an Mission und Batch gebunden und idempotent.

Die internen Modellstufen `shareable`, `confidential`, `private` entsprechen D116
`teilbar`, `vertraulich`, `privat`. Fremde private Einträge ergeben die Regel `exclude`,
vertrauliche `use-without-disclosure`, teilbare `show-with-origin`. Private Heimaterinnerungen
werden bei der expliziten Auswahl abgelehnt; Standardauswahl ist leer.
Nach Missionsende bleiben unbestätigte Referenzen im Outbox-Modell; bestätigte werden entfernt,
außer das Angebot erlaubt ausdrücklich Kopien. Eine Bestätigung allein erteilt keine Erlaubnis.
Das Angebot akzeptiert Secret-Namen, keine Secret-Werte oder beliebige Zusatzfelder.

## Bewusste konservative Annahmen

- Die Uhr ist vertrauenswürdig und monoton; Rücksprünge werden abgelehnt. Lease-Zeitstempel
  müssen in derselben Zeitdomäne liegen. Netzwerk-Uhrabgleich und Toleranz sind Laufzeitarbeit.
- Die Offline-Frist beginnt beim letzten erfolgreichen Kontakt, nicht erst beim Entdecken
  des Ausfalls. Beide Sichtweisen können deshalb vorübergehend verschiedene Zustände haben.
  Nach Kontakt muss die bereits terminale Verleihersicht maßgeblich bleiben.
- Renewal braucht einen neueren Ausstellungszeitpunkt. Direkt vor Missionsende darf die
  gedeckelte Ablaufzeit gleich bleiben. Fremde/replayte/abgelaufene Leases werden abgelehnt.
- Entfernen-Bestätigungen sind Modellereignisse, kein Nachweis tatsächlicher Löschung.
- IDs sind im Modell auf ASCII-Buchstaben, Ziffern, Bindestrich und Unterstrich begrenzt;
  die endgültige RPC-/Engine-Abbildung ist noch kein Bestandteil dieses internen Vertrags.

## Unabhängiger Selfreview vor dem Push

Die Übergänge wurden nochmals von den Invarianten her gelesen: keine Arbeitsentscheidung vor
Annahme plus Lease; keine Wiederbelebung nach einem Terminalzustand; gleicher Grenzzeitpunkt in
Tick, Renewal und Arbeitsentscheidung; 15-min-/24-h-Frist an der jeweils richtigen lokalen Sicht;
keine Änderung der Projektbindung nach Annahme; kein Projektfeld in Verleihersicht/Batches;
keine Löschentscheidung für unbestätigte Batches. Die Randprüfung ergab zusätzliche rote Tests
für überlappende Batches, Konflikte, Snapshot-Mutation, Renewal am Missionsende und Rückgabe
vor Annahme; nach den Korrekturen sind diese grün.

## KNOWN GAPs: keine Laufzeitintegration

Diese Module werden weder aus dem Core-Einstieg exportiert noch von einem Dispatcher aufgerufen.
Es gibt keine RPC-/Config-/RBAC-Änderung, keinen Transport, keine Signaturprüfung, keinen Timer,
keine Modell-/Toolausführung, keine tatsächlichen Speicherimporte, Löschungen oder Prompts.
Hash-Deskriptoren ersetzen keine Prüfung der später übertragenen Inhalte auf Secret-Werte.
Eine Modell-Bestätigung ersetzt keine authentifizierte Peer-Antwort.

Die Laufzeit wartet weiterhin auf WP3/WP4, D116 C3/C4 und die übrigen WP12-Voraussetzungen
(P8/D109, M5, Export/Import, Modellzuordnung). Dort erforderlich: signierte Leases und Peer-Auth,
Check vor **jedem** Modell- und Toolaufruf, Cancel/Hold laufender Ergebnisse, lokale Outbox mit
Secret-Store-Verschlüsselung und Frist/Purge, atomare Speicherung von Import und Batch-Receipt,
Wiederherstellung nach Neustart, Revocation, projektbezogene RBAC- und Privacy-Checks sowie
Marker-Abnahme über echte Recall-/Prompt-/Exportpfade. Revisionen bestehender Missions-Erinnerungen
brauchen einen gesonderten Vertrag; das Modell lehnt widersprüchliche Wiederverwendung einer ID ab.
D115-Berichte über die Projektebene und D116-Hand-over (§13) werden hier nicht implementiert.
Keine Owner-Frage wird erneut geöffnet; Merge und Engine-Pin übernimmt der Controller.

## Lokale Abnahme

- Node 24.21.0, keine neuen Abhängigkeiten (`node:crypto` für SHA-256).
- 32/32 Föderations-Modelltests, 0 skips, 0 todos. Explizite Uhrzeiten ersetzen die Uhr;
  synthetische Erinnerungsreferenzen ersetzen Inhalte. Ein deterministisch gesetzter Zufallsstart
  deckt 500 Renewal-/Ausfallübergänge ab. Keine Engine und kein Provider wird aufgerufen.
- Rote Läufe vor den neuen Modulen; zusätzliche Assertion-Fehler vor den Randfallkorrekturen.
  Danach grüner Nachlauf beider Dateien mit den vorgeschriebenen Node-Flags.
- Gesamt-Typecheck (`tsc -p tsconfig.base.json --noEmit`), Dokumentlinks und Hygiene bestanden.
- `pnpm gen`/`pnpm build` bereiten lokale generierte Dateien und dist vor; keine Änderung an
  Schema, Engine-Pin oder Lockfile. Die installierten Abhängigkeiten wurden lokal über ignorierte
  Verknüpfungen wiederverwendet; Workspace-Verknüpfungen zeigen auf diesen Worktree.

Der vollständige Core-Paketlauf endete mit **9.672 Tests: 9.609 bestanden, 18 fehlgeschlagen,
20 bestehende skips, 25 bestehende todos**. G4 fügt keine skips/todos hinzu. Er startete vor dem lokalen Build;
seine neun `test/bin.test.ts`-Fehler wegen fehlendem `dist/core.js` sind nach `pnpm build`
im gezielten Nachlauf **9/9 grün**. Weitere neun Fehler liegen in unveränderten Importtests.
Reproduktion mit `git archive origin/main` (Core-Quellen und Importtests der Basis, ohne G4):
**73 Tests, 64 bestanden, dieselben 9 fehlgeschlagen**. Betroffene Tests:

| Datei | Testname |
|---|---|
| `packages/core/test/import/fs-atomic.test.ts` | `is true for the root itself and for descendants, also for paths that do not exist` |
| `packages/core/test/import/fs-atomic.test.ts` | `'..' segments are resolved before the comparison` |
| `packages/core/test/import/fs-atomic.test.ts` | `a dangling symlink is judged by its own (unresolvable) path, not by what it points to` |
| `packages/core/test/import/rollback-ledger.test.ts` | `classifies pre-import files as unchanged, revert or restore` |
| `packages/core/test/import/rollback-ledger.test.ts` | `reports the snapshot, the report path and the manifest hash it verified` |
| `packages/core/test/import/rollback-ledger.test.ts` | `a file the import deleted comes back from the snapshot` |
| `packages/core/test/import/rollback-ledger.test.ts` | `a report that names a different run than the directory it sits in is refused (report-missing / report-outside-home)` |
| `packages/core/test/import/rollback-ledger.test.ts` | `manifest content: not JSON, wrong schema, wrong run id, no files map, a snapshot file missing or altered` |
| `packages/core/test/import/rollback-ledger.test.ts` | `a failure while restoring a deleted file leaves the home as it was for that file and the retry restores it` |

Keine dieser Importquellen oder Tests wurde verändert, übersprungen oder gelockert.
