# GP5 T3: Bewertung eines lokalen Engine-Fakes

Stand: 21.10.2026. Analyse auf `origin/main` `1dae60f2ae6d4f7b361cefa61e4717dfae00fa0b`, vor Beginn neu gefetcht; offene PRs geprüft. T1 [#691](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/691) und T2 [#700](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/700) sind noch offen. T2 wurde an Head `8adc955d0c25436d708926006452315d949137f6` gelesen, aber nicht in diesen Analysezweig übernommen. Eine Code-Abhängigkeit auf T2 ist für diesen Bericht nicht nötig.

## Ergebnis und Empfehlung

**Keinen allgemeinen Engine-Fake ergänzen.** Die Integrationstests behalten die echte, unverändert gepinnte Engine und ihre vorhandene modellfreie Schnittstelle. Lokale Vorbereitung erfolgt auf dieser Basis mit eingefrorener Installation und Generierung, künftig über T2 mit `pnpm test:prep`. Ein schmaler aufgezeichneter Port ist bereits für reine Harness-Logik vorhanden. Er ist etwas anderes als ein Ersatz für die Engine in Core-Integrationsläufen.

Eine gesonderte lokale Auflösung auf einen Fake ist technisch entwerfbar. Ein kleiner Ersatz für die genannten Testgruppen ist auf dieser Basis aber **nicht nachgewiesen**: Der Importgraph braucht mehr als `createEngine`, und ein Teil der Tests prüft absichtlich die Engine selbst. Ein leerer oder stets erfolgreicher Rückgabewert würde den Umfang dieser Prüfungen verändern. Deshalb enthält T3 nur die Bewertung, Messungen und eine Owner-Frage, keine neue Auflösungsbedingung, keinen Loader im Repository und keine Änderung am Produkt- oder CI-Pfad.

## Was die Tests tatsächlich brauchen

| Bereich | Vorhandene Abhängigkeit und Aussage | Folge für einen Fake |
|---|---|---|
| `rbac/core-integration.test.ts` | startet `createCore`, prüft echte Socket-RPCs, Verweigerungen und Audit; der Admin-Fall muss bis zur Engine gelangen | Ein bloßer Autorisierungs-Stub ersetzt die Integration in Engine-Start, Status, Agenten und Handlern nicht |
| `logs/rpc.test.ts` | startet einen echten Core, prüft Schema, Rollen, Redigierung und Live-Logstufen | Die Assertions betreffen vorwiegend Harness-Logik; der vollständige Core-Start importiert trotzdem die Engine und ihre Konfigurationsschema-Datei |
| `audit/rpc.test.ts` | startet einen echten Core, prüft Berechtigungen, Ketteneinträge und Manipulationsbefunde | Ebenfalls eine echte Core-Integration; vorhandene reine Kettentests benötigen keinen allgemeinen Engine-Ersatz |
| `identity/identity-rpc.test.ts` | baut RPC-Methoden mit einem schon heute kleinen Engine-Objekt (`contract`, `jobs.list`) | Der statische Import von `rpc/methods.ts` lädt `backup-ops.ts` und damit das Engine-Snapshot-Modul, auch wenn dieser Test keine Sicherung ausführt |
| `identity/backfill-recall.test.ts` | verwendet bereits `ScriptedEngine implements MetadataRebindPort`, einen Recorder mit vorgegebenen Ergebnissen | Diese schmale Schnittstelle prüft die Harness-Aufrufreihenfolge und Fehlerbehandlung bereits ohne Engine-Laufzeit; kein allgemeiner Fake nötig |
| `identity/service.test.ts` | prüft den echten Harness-Identitätsspeicher mit `node:sqlite`, ohne Engine-Laufzeit | Generatoren, Workspace-Pakete und Node-Version sind weiterhin erforderlich; ein Engine-Fake löst diese Voraussetzungen nicht |
| `identity/engine-rebind.test.ts` | importiert `createEngine` und `internalsOf`; prüft Besitzerwechsel, Sichtbarkeit, unveränderte Texte/Vektoren, Idempotenz und Rücknahme an echten Speicherzeilen | Ein Recorder könnte diese Zusicherungen nicht bestätigen; ein entsprechender Fake wäre eine zweite Implementierung der zu prüfenden Speichersemantik |

Quellstellen auf der oben genannten Basis:

- `packages/core/test/rbac/core-integration.test.ts:1,30,53`
- `packages/core/test/logs/rpc.test.ts:1,34`
- `packages/core/test/audit/rpc.test.ts:1,27`
- `packages/core/test/identity/identity-rpc.test.ts:31` und `packages/core/src/rpc/methods.ts:14`
- `packages/core/test/identity/backfill-recall.test.ts:19` und `packages/core/src/identity/backfill.ts:8`
- `packages/core/test/identity/engine-rebind.test.ts:1,27,42,79`

## Auflösung und Importgraph

Die private Abhängigkeit in `packages/core/package.json` bleibt exakt auf `98dfe2f03363f6291daa9f85e473578770fb5c55`. Der Core nennt Contract `1.16.0`, unterstützt Major 1 und akzeptiert mindestens Minor 8 (`packages/core/src/engine.ts:5-12`). T3 ändert keinen Vertrag.

`bindEngine` importiert `createEngine` statisch und reicht `testInternals` an dessen bestehende Test-Schnittstelle weiter (`engine.ts:1,35-38`). `test/helpers/flat-embedder.ts:24` ersetzt nur Embeddings und Reranker: Die Engine, ihre Speicherzugriffe und ihre Berechtigungslogik bleiben echt. Die Prozessvariante `--test-internals flat-embedder` verlangt zusätzlich `PLUR1BUS_ALLOW_TEST_INTERNALS=1` (`src/bin.ts:61-83`).

Weitere Laufzeitimporte umfassen:

- `engine-config.ts:1`: das installierte Engine-Konfigurationsschema als JSON, vor einer Engine-Erzeugung aufgelöst;
- `backup-ops.ts:15`: `SnapshotError`, `createSnapshot`, `verifySnapshot` aus dem Snapshot-Modul;
- `embedding-migrate/switch.ts:12-14`, `target.ts:7-8`, `probe.ts:4`: Fingerprint-, Laufzeitkonfigurations- und Normalisierungsfunktionen;
- `import/importers/hermes-stores.ts`, `hermes.ts`, `backfill.ts`, `openclaw.ts` sowie `import/rollback.ts`: weitere direkte Factory-Importe;
- `restore-reapply.ts:52`: ein zusätzlicher dynamischer Import bei der Wiederherstellung;
- `identity/engine-rebind.test.ts:27`: direkter Testzugriff auf `engine/internals.js`.

Im lokal installierten Paket am unveränderten Pin gibt es kein `exports`-Feld mit einer Testbedingung. `--conditions=source` des Harness-Testläufers wählt die Quellen der Workspace-Bibliotheken; es ersetzt keine fehlende externe Engine. Ein zusätzliches `--conditions=fake` allein würde daher keinen dieser Paketpfade umleiten. Ein eigener Harness-Import-Alias müsste diese direkten Importe zunächst einheitlich machen; ein Node-Auflösungshook müsste jeden benötigten Unterpfad ausdrücklich abdecken. Ein stiller pnpm-Link, eine Lockfile-Umleitung oder ein nachgebautes Paket im Produktpfad sind keine Optionen für diese Phase.

## Geprüfte Alternativen

| Variante | Nutzen | Grenze / Bewertung |
|---|---|---|
| T2-Vorbereitung plus echter Pin und Flat-Embedder | bereits vorhandene Integrationstests ohne Modell-Download; voller geprüfter Engine-Vertrag | braucht privaten Lesezugriff oder den exakten lokalen Paketcache; **empfohlen** |
| Vorhandene schmale Ports und Recorder | reine Harness-Logik ohne Speicher- oder Modellnachbildung prüfen | bereits im Identitätsbereich vorhanden; diese Tests nicht als echte Engine-Integration ausgeben |
| Gemeinsamer lokaler Engine-Fake per neuer Bedingung/Loader | könnte zusätzliche Harness-Handler ohne installiertes Engine-Paket ausführbar machen | mehrere Unterpfade/Schema nötig; getrennte Testauswahl und CI-Abwehr erst zu entwerfen und nachzuweisen; **hier nicht umgesetzt** |
| Dieselben Integrationsdateien automatisch auf Fake umleiten | weniger lokale Voraussetzungen | verändert die Aussage etwa der Rebind-Tests und macht ein grünes Ergebnis mehrdeutig; **nicht empfohlen** |

Falls später ein optionaler Fake beauftragt wird, muss die Freigabe mindestens Folgendes konkret festlegen: begrenzte erlaubte Testdateien, ausdrücklich lokale Aktivierung, Ablehnung dieses Modus unter CI, sichtbare Kennzeichnung des Laufs, kein Produktimport und kein Netzwerk-/Persistenzersatz für die echten Engine-Vertragstests. Eine Prüfung vor den CI-Läufen muss weiterhin die Auflösung des echten gepinnten Pakets nachweisen. Zusätzlich müssen fehlende oder unbekannte Fake-Operationen hart scheitern, statt Erfolg vorzutäuschen. Diese Anforderungen sind eine mögliche Folgespezifikation, keine in T3 implementierte Garantie.

## Lokale Evidenz

Node `v24.21.0`, pnpm `10.28.0`, macOS arm64. Neuer Worktree, zunächst ohne `node_modules`:

1. `pnpm install --frozen-lockfile --offline` bestand aus dem vorhandenen Cache: 254 Pakete wiederverwendet, kein Download. Die private Engine wurde weder entfernt noch ersetzt. Damit ist **kein** Zugriff ohne Cache oder ohne private Berechtigung nachgewiesen.
2. Der direkte Erstlauf der sechs unten genannten Dateien vor `pnpm gen` scheiterte in allen sechs Dateien bereits beim Modulimport: `packages/rpc-schema/generated/names.json` fehlte. Das war eine fehlende Vorbereitung, kein Engine-Verhaltensfehler; die Tests wurden weder übersprungen noch geändert.
3. `pnpm gen` bestand. Der folgende identische Testaufruf bestand mit **47/47**, acht Suites, null Skips/Todos, ungefähr 3,84 Sekunden auf diesem Rechner. Das ist kein Laufzeitbudget und keine Aussage über andere Plattformen oder die gesamte Suite.

Vom Repository-Root:

```sh
pnpm install --frozen-lockfile --offline
pnpm gen
cd packages/core
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 --test-timeout=120000 test/rbac/core-integration.test.ts test/logs/rpc.test.ts test/audit/rpc.test.ts test/identity/engine-rebind.test.ts test/identity/identity-rpc.test.ts test/identity/backfill-recall.test.ts
```

Die Integrationsdateien verwenden die echte Engine mit dem bestehenden Flat-Embedder. `identity/identity-rpc` verwendet sein schon vorhandenes schmales Engine-Objekt; `backfill-recall` seinen vorhandenen Recorder. Diese vorhandenen Testdoubles werden nicht als echte Engine-Prüfung gezählt. Die vier Fälle in `engine-rebind` prüfen die tatsächlichen Speicherzeilen.

### Kontrollversuch ohne Engine-Auflösung

Für die Importanalyse wurde ausschließlich in `/tmp` ein Node-Hook angelegt, der jeden Laufzeitimport mit Präfix `@cyb3rb1ade/plur1bus-memory` absichtlich wirft. Er liefert keine Fake-Engine und verändert keine installierte Datei. Der Prozess wurde mit `--import /tmp/gp5-t3-deny-engine-resolution.mjs` gestartet:

```js
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@cyb3rb1ade/plur1bus-memory")) {
    throw new Error(`T3 diagnostic: Engine resolution deliberately denied: ${specifier}`);
  }
  return nextResolve(specifier, context);
} });
```

- `identity/backfill-recall.test.ts` plus `identity/service.test.ts`: **39/39 bestanden**, null Skips/Todos. Das belegt für diese Auswahl, dass sie kein Engine-Laufzeitmodul braucht; Workspace-Abhängigkeiten und generierte Quellen waren vorhanden.
- `identity/identity-rpc.test.ts`: erwartetes Scheitern vor Testausführung am statischen Import `lib/snapshot/store-snapshot.js`. Das bestätigt die beiläufige Importabhängigkeit über den gemeinsamen RPC-Methodenbauer. Dieses absichtlich negative Experiment gehört **nicht** zu einem behaupteten grünen regulären Lauf.

Die 39 Fälle des Kontrollversuchs sind keine 39 zusätzlichen regulären Integrationsfälle: Die 22 Backfill-/Recall-Fälle überschneiden sich mit dem 47er-Lauf.

Ein separater späterer Refactor könnte den gemeinsamen Methodenbauer so aufteilen, dass reine Identitäts-RPC-Tests keinen Backup-Import mehr laden. Das wäre eine gezielte Importentkopplung, keine allgemeine Engine-Nachbildung; sie wird hier nur als mögliche Folgearbeit genannt.

## CI und offene Entscheidung

Auf dieser Basis installiert `.github/workflows/ci.yml:83` den eingefrorenen Workspace und führt nach Generierung/Build `pnpm test` aus (`:86-103`). `scripts/run-ts-tests.mjs` schließt nur die Desktop-UI aus; `scripts/test-package.mjs:21` führt mit `--conditions=source` aus, ohne Engine-Fake-Bedingung. Da T3 keinerlei Code- oder Workflow-Änderung enthält, erhalten diese Läufe weiterhin die echte gepinnte Engine. Es wurde kein CI-Lauf gepollt und kein neuer CI-Fake-Schutz als getestet behauptet.

**Owner-Frage:** Soll ein zusätzlicher allgemeiner Engine-Fake trotz der begrenzten Aussagekraft und des zusätzlichen Vertragsaufwands als eigenes Vorhaben verfolgt werden? **Empfehlung:** nein; T1/T2 integrieren und die echten Integrationsläufe erhalten. Bei Bedarf zuerst einzelne unnötige Laufzeitimporte und schmale Harness-Ports getrennt untersuchen. Wenn du dennoch einen Fake willst, beauftrage zunächst die explizite Testauswahl und den nachgewiesenen CI-Ausschluss; ändere keine bestehenden Integrationsläufe still.

Diese Analyse lässt den Modus unverändert und wartet nicht auf eine stillschweigende Freigabe. Keine neue Abhängigkeit, kein Engine-Pin-/Lockfile-Wechsel, keine neue Produktfunktion, kein Merge oder Deployment. Es gibt keine neue implementierte KNOWN GAP, die durch einen Todo-Test verdeckt würde; der bekannte fehlende Engine-Zugriff ohne Cache bleibt eine offen benannte Voraussetzung, keine bestandene Testabnahme.
