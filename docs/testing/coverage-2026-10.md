# Coverage-Offensive 2026-10: Tests für die Module ohne aktive Arbeit

Dieser Bericht gehört zum Branch `haiku/test-coverage-offensive` (Basis `origin/main`, Stand `f250d8f5`).
Der Auftrag war, die Testabdeckung schwach abgedeckter Module zu erhöhen, **ohne Produktionscode zu ändern**.
Alles, was dabei auffiel, steht in den Abschnitten „Bugs“ und „Unklar“ unten.

## Zusammenfassung

- **25 neue Testdateien**, alle neu angelegt. `git diff --name-status origin/main` zeigt nur `A`-Einträge.
- **Befunde:** 7 Bugs (`BUG:`-Skips) und 3 offene Fragen (`UNKLAR:`-Skips). Jeder Skip verweist auf einen Abschnitt in diesem Bericht.
- **Zeilen- und Zweigabdeckung** der 25 Zieldateien: nach der Arbeit 92.5–100 % Zeilen (nur `owner-token.ts` unter 100 %, wegen des Windows-Pfads); die Zweigdeckung steigt in den meisten Dateien auf 96–100 % (Tabelle unten).
- **Stabilität:** jede neue Datei einzeln dreimal hintereinander ausgeführt, alle Läufe grün.
- **Vorbefund auf `main`:** `test/integration/core-pipeline.test.ts` („real RPC approval …“, `surface-untrusted`) schlägt auch ohne diese Änderungen fehl. Die Suite hat deshalb `fail 1`. Dieser Test ist nicht Teil dieses Auftrags.

## Methode

- **Test-Runner:** Die Pakete nutzen `node:test`, nicht vitest. Die Vorgaben wurden entsprechend übertragen:
  `vi.useFakeTimers` → `t.mock.timers`, `it.each` → Schleife mit einem `it` je Fall, `it.skip` → `{ skip: "BUG: …" }` bzw. `{ skip: "UNKLAR: …" }`.
- **Coverage-Messung:** `node --experimental-test-coverage` mit `--test-coverage-include='src/**/*.ts'` und `--test-coverage-include-all`, damit nie geladene Dateien mit 0 % erscheinen.
  Die Ausgangslage wurde mit denselben Testdateien ohne die 25 neuen Dateien gemessen (das reproduziert den ursprünglichen Lauf).
- **Auswahl der 25 Dateien:** Ranking nach der Summe aus ungedeckten Zeilen und ungedeckten Zweigen über die erlaubten Bereiche.
  Ausnahmen und Gründe stehen unten unter „Bewusst ausgelassen“.
- **Bugs nachgeprüft:** Alle sieben BUG-Tests wurden in einer Kopie ohne `skip` ausgeführt und schlagen wie erwartet fehl. Zusätzlich schlägt der UNKLAR-Test zum Budget in `logs-methods` fehl (erwartet, weil er die offene Frage prüft). Die Kopien wurden danach wieder gelöscht.

## Neue Testdateien

| Paket | Datei | Ziel (`src/…`) | Tests (pass / skip) |
|---|---|---|---|
| `packages/api` | `test/api-routes.coverage.test.ts` | `routes.ts` | 155 / 0 |
| `packages/api` | `test/api-index.coverage.test.ts` | `index.ts` | 24 / 0 |
| `packages/api` | `test/api-server.coverage.test.ts` | `server.ts` | 98 / 3 |
| `packages/api` | `test/api-ports.coverage.test.ts` | `ports.ts` | 6 / 0 |
| `packages/api` | `test/api-core-link.coverage.test.ts` | `core-link.ts` | 9 / 0 |
| `packages/api` | `test/api-owner-token.coverage.test.ts` | `owner-token.ts` | 20 / 0 |
| `packages/core` | `test/a2a/a2a-push.coverage.test.ts` | `a2a/push.ts` | 78 / 1 |
| `packages/core` | `test/a2a/a2a-turn-port.coverage.test.ts` | `a2a/turn-port.ts` | 43 / 0 |
| `packages/core` | `test/a2a/a2a-tasks.coverage.test.ts` | `a2a/tasks.ts` | 71 / 1 |
| `packages/core` | `test/a2a/a2a-card.coverage.test.ts` | `a2a/card.ts` | 69 / 0 |
| `packages/core` | `test/a2a/a2a-handler.coverage.test.ts` | `a2a/handler.ts` | 228 / 2 |
| `packages/core` | `test/a2a/a2a-index.coverage.test.ts` | `a2a/index.ts` | 32 / 0 |
| `packages/core` | `test/a2a/a2a-server.coverage.test.ts` | `a2a/server.ts` | 54 / 0 |
| `packages/core` | `test/acp/acp-server.coverage.test.ts` | `acp/server.ts` | 74 / 1 |
| `packages/core` | `test/acp/acp-backend.coverage.test.ts` | `acp/backend.ts` | 22 / 0 |
| `packages/core` | `test/acp/acp-main.coverage.test.ts` | `acp/main.ts` | 16 / 0 |
| `packages/core` | `test/embedding-migrate/embedding-migrate-driver.coverage.test.ts` | `embedding-migrate/driver.ts` | 53 / 0 |
| `packages/core` | `test/embedding-migrate/embedding-migrate-port.coverage.test.ts` | `embedding-migrate/port.ts` | 6 / 0 |
| `packages/core` | `test/secrets/secrets-store.coverage.test.ts` | `secrets/store.ts` | 53 / 1 |
| `packages/core` | `test/logs/logs-writer.coverage.test.ts` | `logs/writer.ts` | 70 / 0 |
| `packages/core` | `test/logs/logs-lines.coverage.test.ts` | `logs/lines.ts` | 50 / 1 |
| `packages/core` | `test/logs/logs-output.coverage.test.ts` | `logs/output.ts` | 55 / 0 |
| `packages/core` | `test/logs/logs-methods.coverage.test.ts` | `logs/methods.ts` | 60 / 2 |
| `packages/core` | `test/logs/logs-sink.coverage.test.ts` | `logs/sink.ts` | 59 / 0 |
| `packages/core` | `test/logs/logs-query.coverage.test.ts` | `logs/query.ts` | 84 / 0 |

## Coverage vorher → nachher je Datei

Zeilen und Zweige in Prozent. „vorher“ ist die Suite ohne die neuen Dateien, „nachher“ die vollständige Suite.

| Datei | Zeilen vorher | Zeilen nachher | Zweige vorher | Zweige nachher |
|---|---|---|---|---|
| `core` `a2a/push.ts` | 97.5 | 100.0 | 67.5 | 99.2 |
| `core` `a2a/turn-port.ts` | 96.5 | 100.0 | 73.3 | 100.0 |
| `core` `a2a/tasks.ts` | 98.8 | 100.0 | 88.4 | 98.8 |
| `core` `a2a/card.ts` | 100.0 | 100.0 | 78.7 | 100.0 |
| `core` `a2a/handler.ts` | 99.4 | 99.7 | 94.8 | 99.6 |
| `core` `a2a/index.ts` | 0.0 | 100.0 | n/a | 100.0 |
| `core` `a2a/server.ts` | 100.0 | 100.0 | 82.4 | 90.6 |
| `core` `acp/server.ts` | 97.4 | 100.0 | 84.9 | 99.3 |
| `core` `acp/backend.ts` | 100.0 | 100.0 | 67.6 | 100.0 |
| `core` `acp/main.ts` | 85.7 | 100.0 | 75.0 | 95.5 |
| `core` `embedding-migrate/driver.ts` | 96.8 | 100.0 | 87.6 | 100.0 |
| `core` `embedding-migrate/port.ts` | 81.1 | 100.0 | n/a | 100.0 |
| `core` `secrets/store.ts` | 100.0 | 100.0 | 88.7 | 96.8 |
| `core` `logs/writer.ts` | 100.0 | 100.0 | 83.9 | 96.9 |
| `core` `logs/lines.ts` | 98.2 | 100.0 | 86.3 | 98.9 |
| `core` `logs/output.ts` | 88.7 | 100.0 | 90.2 | 98.1 |
| `core` `logs/methods.ts` | 96.1 | 100.0 | 93.5 | 98.7 |
| `core` `logs/sink.ts` | 100.0 | 100.0 | 79.5 | 98.4 |
| `core` `logs/query.ts` | 100.0 | 100.0 | 96.0 | 100.0 |
| `api` `routes.ts` | 99.8 | 100.0 | 84.9 | 100.0 |
| `api` `index.ts` | 0.0 | 100.0 | n/a | 100.0 |
| `api` `server.ts` | 99.2 | 100.0 | 93.3 | 97.1 |
| `api` `ports.ts` | 76.9 | 100.0 | n/a | 100.0 |
| `api` `core-link.ts` | 100.0 | 100.0 | 69.6 | 100.0 |
| `api` `owner-token.ts` | 92.5 | 92.5 | 81.8 | 96.7 |

Die Restlücken sind größtenteils Windows-Pfade, Fehlerpfade nach Systemaufrufen und defensive Zweige, die über die öffentliche API nicht auslösbar sind (siehe unten).

## Paketsummen

| Paket | Dateien | Zeilen vorher → nachher | Zweige vorher → nachher | Tests vorher → nachher |
|---|---|---|---|---|
| `packages/core` | 366 | 96.4 → 96.6 | 86.7 → 87.9 | 3715 → 4901 (fail 1 vorher und nachher) |
| `packages/api` | 26 | 96.4 → 98.2 | 92.0 → 97.2 | 209 → 524 |

`packages/core` gewinnt insgesamt wenig, weil die 25 Zieldateien nur einen Teil der 366 Quelldateien ausmachen.
Die Zieldateien selbst haben deutlich zugelegt (Tabelle oben).

## Bugs

Jeder Bug steht als Test mit dem **korrekten** Erwartungswert im Testfile, markiert mit `skip`. Der Quelltext ist unverändert.

### a2a-push-preaborted-unhandled-error

- **Datei/Zeile:** `packages/core/src/a2a/push.ts:77`
- **Erwartung:** Ein bereits abgebrochenes `AbortSignal` lehnt den Push mit `aborted` ab und sendet nichts.
- **Ist:** `req.destroy()` ohne `error`-Listener erzeugt ein unbehandeltes `error`-Ereignis (`socket hang up`), das den Prozess beendet.
- **Reproduktion:** Test `a pre-aborted signal rejects with 'aborted' and sends nothing` (`a2a-push.coverage.test.ts`) ohne `skip` ausführen.
- **Schweregrad:** P3 (nur bei bereits abgebrochenem Signal).

### a2a-tasks-noprovider-unhandled-rejection

- **Datei/Zeile:** `packages/core/src/a2a/tasks.ts:108` und `:119` (`rec.done = this.#run(...)`)
- **Erwartung:** Ein nicht blockierender Start, dessen Turn mit `no-provider` scheitert, darf keine unbeobachtete Rejection hinterlassen.
- **Ist:** `rec.done` wird rejected, ohne dass `start()` einen Handler anhängt; die Rejection bleibt unbeobachtet.
- **Reproduktion:** Test `a non-blocking start whose turn throws no-provider must not leave an unhandled rejection` (`a2a-tasks.coverage.test.ts`).
- **Schweregrad:** P2 (Prozessabsturz möglich, wenn der Provider fehlt).

### a2a-handler-verifybearer-unknown-peer

- **Datei/Zeile:** `packages/core/src/a2a/handler.ts:177`
- **Erwartung:** Ein verifizierter Peer ohne Eintrag in der Peer-Tabelle wird mit 404 abgelehnt.
- **Ist:** `o.peers.find(...)!.grants` wirft einen `TypeError`, weil `find` `undefined` liefert und der Non-null-Operator das nicht abfängt.
- **Reproduktion:** Test `a verified peer that has no entry in the peer table is denied, not crashed` (`a2a-handler.coverage.test.ts`).
- **Schweregrad:** P3 (der Fehler landet im RPC-Pfad als Serverfehler, nicht als Zugriff).

### a2a-handler-resubscribe-unknown-task-stream

- **Datei/Zeile:** `packages/core/src/a2a/handler.ts:202` (`tasks/resubscribe`)
- **Erwartung:** `tasks/resubscribe` mit unbekannter Task-ID antwortet mit JSON-RPC-Fehler `-32001` (TaskNotFound).
- **Ist:** Die Antwort ist `200 text/event-stream`. Der Fehler entsteht erst beim Iterieren des Streams.
- **Reproduktion:** Test `tasks/resubscribe for an unknown task answers TaskNotFound as a JSON-RPC error` (`a2a-handler.coverage.test.ts`).
- **Schweregrad:** P2 (falscher Statuscode und Protokollform für einen regulären Fehlerfall).

### secrets-lease-label-coercion

- **Datei/Zeile:** `packages/core/src/secrets/store.ts:156`
- **Erwartung:** `purpose` muss ein String sein, sonst `invalid-value`.
- **Ist:** `LABEL.test(o2?.purpose ?? "")` wandelt Nicht-Strings in Strings um. `purpose: 5` wird deshalb akzeptiert.
- **Reproduktion:** Test `BUG: a non-string purpose is refused` (`secrets-store.coverage.test.ts`).
- **Schweregrad:** P3 (Eingabevalidierung, keine Rechteausweitung).

### logs-tail-preaborted-signal

- **Datei/Zeile:** `packages/core/src/logs/methods.ts:79` (`ctx.signal.addEventListener("abort", …)`)
- **Erwartung:** Ein bereits abgebrochenes `ctx.signal` beendet ein wartendes `logs.tail` sofort.
- **Ist:** Der `abort`-Listener feuert bei einem bereits abgebrochenen Signal nie. Der Aufruf pollt bis `waitMs` abgelaufen ist.
- **Reproduktion:** Test `an already aborted connection signal does not wait` (`logs-methods.coverage.test.ts`).
- **Schweregrad:** P3 (verschwendete Zeit bis zum Timeout, kein Fehlverhalten der Daten).

### api-server-audit-token-id-redacted

- **Datei/Zeile:** `packages/api/src/server.ts:274` (`audit.emit("auth.denied", …, { token: tokenInfo.id, … })`) und `packages/api/src/redact.ts` (`redactFields`)
- **Erwartung:** Der Audit-Eintrag einer Token-Ablehnung enthält die Token-ID, damit er zugeordnet werden kann.
- **Ist:** `redactFields` ersetzt das Feld `token` durch `[redacted]`, weil der Name einem Credential-Muster entspricht. Die ID geht verloren.
- **Reproduktion:** Test `BUG: the audit entry of a token denial keeps the token id` (`api-server.coverage.test.ts`).
- **Schweregrad:** P3 (Nachvollziehbarkeit im Audit, keine Freigabe von Geheimnissen).

## Unklar

Hier ist die Spezifikation nicht eindeutig. Die Tests sind als `UNKLAR:` markiert und nicht geraten.

### logs-methods-truncated-without-cursor

- **Datei/Zeile:** `packages/core/src/logs/methods.ts:89–98`
- **Frage:** Ist das Scan-Budget kleiner als der erste Lese-Block, liefert `logs.query` `truncated: true` mit `nextCursor: null`. Soll ein Fortsetzungs-Cursor zurückkommen?
- **Test:** `a budget smaller than the first read still gives a continuation cursor when truncated`.
- **Schweregrad:** P3 (Fortsetzung nur über einen neuen Aufruf mit anderem Budget möglich).

### logs-lines-unterminated-too-long-asymmetry

- **Datei/Zeile:** `packages/core/src/logs/lines.ts:51`, `:107`
- **Frage:** `forwardLines` meldet eine unterminierte, überlange letzte Zeile als `tooLong`, `backwardLines` ignoriert sie. Die Modul-Doku sagt „unterminierte Zeilen werden nie geliefert“. Ist das Verhalten beabsichtigt, und was soll gemeldet werden?
- **Test:** `an unterminated over-long tail is not reported as a (corrupt) line …`.
- **Schweregrad:** P3.

### acp-resource-link-double-space

- **Datei/Zeile:** `packages/core/src/acp/server.ts:183`
- **Frage:** Ein `resource_link` ohne Namen wird als `[resource:  uri]` mit doppeltem Leerzeichen gerendert. Ist ein leerer Name erlaubt, und soll das Leerzeichen dann entfallen?
- **Test:** `UNKLAR: a resource link without a name is rendered with a single space`.
- **Schweregrad:** P3 (kosmetisch).

## Bewusst ausgelassen

- **Verbotene Bereiche** (laut Auftrag): `auth`, `openai-auth`, `voice`, `session`, `tools`, `policy`, `approvals`, `grants`, `budget`, `collab`, `identity`, `attestation`, `mcp`, `composition`, `packages/web`, `packages/media`, `packages/providers`, `packages/hostctl`, `packages/channels-*`, `crates/`, `apps/`, `.github/`.
- **Nicht vorhanden** auf `origin/main`: `test/config/`, `test/supervisor/`, `test/scheduler/`, `test/recall/`, `test/memory/`, `test/doctor/`, `test/devices/`, `packages/sdk/`, `packages/remote-access/` (#291). `packages/core/src/dreams/` hat keinen Testordner `test/dreams/`; die Regel „nur existierende Ordner“ hat ihn ausgeschlossen. Seine Dateien liegen bereits bei 99.8 % Zeilen.
- **Remote-Access (#291):** In `packages/api/src` gibt es keinen Tailnet-, Exposure- oder Remote-Zugriffscode. Die Treffer auf „remote“ sind `remoteAddress` und ein Kommentar zu CSP. Es wurde daher nichts ausgeschlossen.
- **Nicht unter den 25**, obwohl im Ranking vorhanden: `packages/api/src/bin.ts` (CLI-Einstieg, nur über einen Prozessstart prüfbar, 37 ungedeckte Zeilen), `packages/log-schema/src/index.ts` (9 Zweige/Zeilen offen) und `packages/config-schema/src/index.ts` (19 offen). Diese Auswahl ist eine Abweichung vom reinen Ranking und wird im Folgepaket nachgeholt.

## Restlücken, die bewusst bleiben

- Windows-Zweige (`owner-token.ts` DACL-Pfad, `sink.ts` `chmod` unter Windows), die auf macOS nicht erreichbar sind.
- Nur über Systemfehler erreichbare Zweige, etwa `writer.ts` Wiedereintritts-Sperre und `RangeError` für zu große Datensätze. Der Redactor kürzt überlange Werte vorher.
- `api-server.coverage.test.ts`: zwei Rate-Limit-Tests (pro Principal, pro Token) brauchen zusätzliche Loopback-Adressen (`127.0.0.2` ff.) und werden auf macOS übersprungen. Auf Linux-CI sollten sie laufen; hier nicht verifiziert.
- `ports.ts` enthält nur Interfaces. Die Tests prüfen, dass das Modul keine Laufzeit-Exporte hat, und dass die Memory-Stores die Port-Verträge erfüllen.

## Neue Testdateien: Stabilität und Lint

- Jede der 25 Dateien einzeln dreimal hintereinander ausgeführt, alle Läufe mit `fail 0`.
- Die Dateien verwenden `t.mock.timers`, `mkdtemp` unter `os.tmpdir()` mit Aufräumen im `afterEach`, Port 0 und keine Netzwerkzugriffe.
- `pnpm typecheck`: grün. Vier Typfehler in neuen Dateien wurden vor dem Abschluss behoben (`exactOptionalPropertyTypes`).

## Empfehlungen für Folgepakete

1. Die sieben BUG-Skips in eigene Fix-PRs überführen. P2 zuerst: `a2a-tasks-noprovider-unhandled-rejection` und `a2a-handler-resubscribe-unknown-task-stream`.
2. Die drei UNKLAR-Fragen mit dem Modul-Owner klären und danach entweder den Test anpassen oder den Fehler beheben.
3. `packages/log-schema/src/index.ts`, `packages/config-schema/src/index.ts` und `packages/api/src/bin.ts` in einem eigenen Paket angehen.
4. `core-pipeline`-Fehler auf `main` beheben. Er betrifft die Suite unabhängig von diesem Branch.
