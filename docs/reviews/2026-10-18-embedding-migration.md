# Unabhängiges Review: Embedding-Migration (#571)

| | |
|---|---|
| **Thema** | Embedding-Migration in alle Richtungen (`memory reembed` lokal↔Cloud, Cloud→Cloud, lokal↔lokal), Budget-Schranken, Abbruch-Sicherheit & Cloud→Cloud-Datenschutz (#571) |
| **Geprüfter Commit / Branch** | Branch `origin/feat/reembed-cloud-targets` @ `3dbf67408c8d9727824f8e9c1ef45dcbdf6e2560` (Basis: `origin/main` @ `2b5a435c0`) |
| **Datum** | 2026-10-18 |
| **Reviewer** | agy (unabhängiger Reviewer; hat den Code nicht verfasst) |
| **Empfehlung an den Owner** | **abnahmefähig mit Auflagen** (Keine Blocker, keine Majors; 2 Minor-Befunde zu Re-Check des Egress bei Resume und unbepreisten Modellen im Budget) |

---

## 1. Übersicht und Abnahmekriterien

PR #571 setzt die Owner-Entscheidung vom 17./18.10.2026 um:
- `memory reembed` unterstützt Migrationen in **alle Richtungen** (lokal↔Cloud, Cloud→Cloud, lokal↔lokal).
- Keine Einschränkungen durch künstliche Richtungsfilter; Begrenzung erfolgt ausschließlich über die Provider-Regeln (`resolveEmbeddingProvider`: Modell-Details, `apiKeyEnv`, `privacyAck`, `privacy.localOnly`) und die Egress-Entscheidung.
- Bei Abbruch oder Fehlschlag bleibt stets die **alte Konfiguration aktiv**.
- Der Call-Budget-Stopp greift vor jedem Batch und pausiert den Lauf kontrolliert.
- Bei Cloud→Cloud-Migrationen ist eine explizite Bestätigung erforderlich (`--acknowledge-privacy` / `acknowledgePrivacy: true`), die erst beim atomaren Switch wirksam wird.

### Abnahmekriterien & Prüfpunkte:

1. **Freie Richtungswahl (lokal↔Cloud, Cloud→Cloud, lokal↔lokal):**
   - In `packages/core/src/embedding-migrate/target.ts` (`targetFromSpec`) und `switch.ts` (`targetSelection`) wurden provider-spezifische Richtungsbeschränkungen entfernt.
   - Alle 4 Kombinationsrichtungen (`local -> local`, `local -> cloud`, `cloud -> local`, `cloud -> cloud`) sind in `packages/core/test/embedding-migrate/directions.test.ts` lückenlos abgedeckt und verifiziert. (Erfüllt)

2. **Unveränderte Konfiguration bei Abbruch / Fehler:**
   - Ein Abbruch (durch Benutzer, Netzwerkfehler, 5xx nach Retries oder Budget-Stopp) versetzt den Checkpoint in Phase `"aborted"` oder `"failed"`.
   - Die bestehende Konfiguration (`engine.embedding`, `engine.reembedding`) wird **nicht verändert**.
   - Die Aktivierung erfolgt ausschließlich über einen expliziten Switch (`switchLocked` bzw. `d.switchPort.apply`), der erst nach vollständiger Validierung der neuen Generation (`ready-to-switch`) ausgelöst werden kann. Bis dahin beantwortet weiterhin die alte Generation alle Recall-Anfragen. (Erfüllt)

3. **Call-Budget-Stopp:**
   - Vor jedem Batch (`driver.ts:oneBatch`) erfolgt eine Vorab-Reservierung über `d.budget.admit({ provider, model, estimatedTokens })`.
   - Bei Erreichen des Token- oder Kostenlimits verweigert das Budget das Ticket; der Lauf stoppt sauber mit Phase `"aborted"` und Fehlercode `"budget-exceeded"`.
   - Nach einer Budgeterhöhung kann der Lauf mit `--run` an der vorherigen Batch-Position fortgesetzt werden, ohne bereits verarbeitete Zeilen doppelt abzurechnen. (Erfüllt)

4. **Datenschutzbestätigung bei Cloud→Cloud:**
   - Bei Wechsel von Cloud A auf Cloud B deckt das bestehende `memory.embedding.privacyAck` (ausgestellt für Provider A) den neuen Provider B nicht ab.
   - `admin.reembed.plan` erzwingt in diesem Fall den Parameter `acknowledgePrivacy: true` (CLI: `--acknowledge-privacy`).
   - Fehlt die Bestätigung, weist `resolveEmbeddingProvider` die Planung mit `E_DENIED privacy-acknowledgment-required` ab.
   - Bei Vorhandensein wird die neue Bestätigung im Checkpoint zwischengespeichert und beim atomaren Switch in derselben `config.set`-Transaktion mit dem neuen Embedding-Block geschrieben. (Erfüllt)

---

## 2. Ausgeführte Tests & Verifikation

Lokal auf Branch `feat/reembed-cloud-targets` geprüft:
- `packages/core/test/embedding-migrate/directions.test.ts` (8 Tests, alle bestanden)
- `packages/core/test/embedding-migrate/switch.test.ts` (14 Tests, alle bestanden)
- `packages/core/test/embedding-migrate/target.test.ts` (12 Tests, alle bestanden)
- `packages/core/test/embedding-migrate/state.test.ts` (10 Tests, alle bestanden)

*Hinweis zur Testumgebung:* Echte externe Provider-Aufrufe (z. B. Live-OpenAI oder OpenRouter-Endpunkte) wurden auftragsgemäß nicht ausgeführt, sondern über die Harness-eigene Fake-Engine mit Mock-HTTP-Antworten und deterministischen Fehlerfolgen (429, 503) geprüft.

---

## 3. Befunde

### Blocker
Keine.

### Major
Keine.

### Minor / Nit

#### m1 (Minor) — Egress-Recheck bei Resume prüft Ziel-Endpunkt nicht erneut (`packages/core/src/embedding-migrate/driver.ts:251`)
- **Datei:Zeile:** `packages/core/src/embedding-migrate/driver.ts:251`
- **Begründung:**
  In `driver.ts` wird beim Aufruf von `start()` über `d.admitRun?.(publicView(c))` geprüft, ob die Provider-Regeln (wie `privacy.localOnly`) weiterhin gelten. Die separate Egress-Policy-Prüfung (`checkEngineEgress`) wird jedoch nur in `rpc.ts` während `admin.reembed.plan` ausgeführt.
  Wurde eine Migration geplant und zwischenzeitlich die Egress-Firewall verschärft, bevor der Lauf via `plur1bus memory reembed --run` gestartet oder fortgesetzt wird, greift die Egress-Sperre erst auf Socket-Ebene beim ersten Netzwerkaufruf, anstatt den Start im RPC-Layer mit einem klaren `E_DENIED egress-denied` abzufangen.
- **Empfohlene Behebung:**
  In `admitRun` bzw. im `start()`-Hook vor dem Batch-Start auch `checkEngineEgress` aufrufen, falls `c.remote` gesetzt ist.

#### m2 (Minor) — Unbepreiste Modelle führen bei gesetztem Kostenbudget zu sofortigem Abbruch ohne Vorwarnung im Plan (`packages/core/src/embedding-migrate/budget.ts:18`)
- **Datei:Zeile:** `packages/core/src/embedding-migrate/budget.ts:18`
- **Begründung:**
  Wenn ein Cloud-Modell nicht in der Preistabelle (`PriceBook`) hinterlegt ist und ein hartes globales Kostenlimit (`costMicros`) aktiv ist, verweigert `budget.checkBeforeCall` die Reservierung mit `unpriced-model`.
  Im Planungsaufruf (`admin.reembed.plan`) wird `cloud.estimatedCostMicros: null` zurückgegeben, was im CLI als `--` formatiert wird. Der Benutzer erfährt jedoch erst beim Start von `memory reembed --run`, dass der Lauf wegen des unbepreisten Modells unter der aktiven Budget-Policy gar nicht starten kann.
- **Empfohlene Behebung:**
  In `admin.reembed.plan` eine Warnung in der Plan-Rückgabe ausgeben, wenn ein Kostenbudget aktiv ist und das gewählte Zielmodell keinen Preislisteneintrag besitzt.

---

## 4. Zusammenfassung & Empfehlung

Die Implementierung in PR #571 ist architektonisch sauber, folgt strikt den Vorgaben des Reembedding-Designs und wahrt alle Datenschutz- und Budgetgarantien.
Das Review empfiehlt dem Owner die Abnahme mit den oben genannten Minor-Auflagen zur nächsten Wartungsrunde.
