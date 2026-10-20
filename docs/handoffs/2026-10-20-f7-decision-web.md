# F7 — Entscheidungsdienst: Web und TreeChooser-Port

Stack: `codex/gp4-f7-decision-web` auf F2 `codex/gp4-f2-decision-service` (#627).
Draft, weil die vorhandenen F2-RPCs und der Client noch nicht auf main sind. Kein F4/F5/F6-Import,
keine neuen RPC-/Config-Schemata, Dependencies, Engine-Pins oder Lockfile-Änderungen.

Web: neue Settings-Route `/settings/decision`, vorhandenes Config-Formular mit Dry-run/CAS-Save,
Backend-Auswahl aus F1, bestehende weitere Decision-Config-Blätter, getrennte Laufzeitmetriken
und statische F3-Evidenz. Owner/Admin-Personen erhalten Konfiguration/Diagnose; andere und
unbekannte Rollen erhalten nur den Hinweis und die öffentlichen Spikemesswerte. Core behält
Human-only-RBAC; API ergänzt nur die expliziten Allowlist-Einträge `decision.status` und
`decision.test`. Der API-Test delegiert an die echten Core-Guards, keine kopierten Regeln.

Die Diagnose nutzt eine feste synthetische Gerade/Ungerade-Frage im F2-Core. Die Web-Seite liest
`agent.list`, zeigt deterministisch die erste registrierte ID an und sendet diese. Kein freies
Promptfeld; leere/fehlgeschlagene Registry sperrt den Knopf. Navigation bricht UI-Delivery ab.
Ein ausdrücklich angeforderter Test kann eine konfigurierte Cloud-Rolle aufrufen; die lokalen
Tests rufen ausschließlich feste Mock-Antworten ab. Keine Cloud-/bezahlten Tests ausgeführt.

F3-Messungen stammen aus [#626](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/626),
Commit `f42fe3950c3edce876933752524f61cdc958a3be`, Handoff und JSON-Receipts dort.
Die Oberfläche benennt vorläufige, nicht validierte Labels, nicht bestandenes Deutsch-Gate,
Windows-x64-NAS-Nachmessung (2 Threads warm p50/p95 524/822 ms; VM-Diagnose) sowie
weiterhin fehlende Linux-/Kev-Nachweise und fehlenden kalibrierten role-Vergleich ausdrücklich.
Sie aktiviert keinen nativen Backend-Installer oder automatische Deutsch-Auswahl.

TreeChooser: store-freier Adapter zum selben F2 DecisionClient; vertrauenswürdiger Context-Provider,
aktuelles localOnly/Deadline, maximal 24 sichtbare Kandidaten plus none, Name80/Summary160,
150-ms-Callcap. Aufrufer hält dieselbe absolute Deadline über Zoom-Levels. Top2-Optionswahrscheinlichkeiten
bleiben `confidence` in der Tree-Pick-Struktur; keine empirische Kalibrierung behauptet. Gewinner
unter 0,35, none, rekursive Decision-Rolle, ungültige Antwort, Abbruch/Timeout/Privacy/Fehler liefern
`[]`. C3-Aufrufer entscheidet anhand 0,6-/0,35-Schwellen über 1/2 Picks. Keine TreeStore-Handles,
keine neue TreeStore-Implementierung und kein Laufzeitpfad, solange C3/C4 fehlen. Spezifikation und
Plan haben additive Links zum Port. [Vertrag](../decision-service.md).

## Lokale Validierung

Node24.21.0/pnpm10.28; frozen-lock/ignore-scripts installiert. Keine CI-Abfragen.

```bash
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 \
  packages/web/test/decision-settings.test.ts packages/web/test/settings-config-model.test.ts \
  packages/web/test/i18n.test.ts packages/api/test/web-rpc.test.ts
node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 packages/core/test/decision/*.test.ts
pnpm exec tsc -p tsconfig.base.json --noEmit
node scripts/lint-hygiene.mjs
git diff --check
```

TDD: Web-Route/Bedienung zuerst rot; echte axe-Landmark-Fehler geschlossen; rollenabhängige
Controls, revisionierter Save, feste Testfrage, DE-Hinweise, Erfolg/Verweigerung/Privacyfehler,
Status-Ausfall und Abbruch bei Navigation. Agent-Registry-Regression: ausschließlich `main`
sendet `main`, leere Registry sendet keinen Diagnose-RPC. Tree: Deadline/rekursive Rolle,
Top2-Wahrscheinlichkeiten, Kandidatenbegrenzung, Privacy und ungültige Daten rot→grün.

Final: Web/API/Metadata/i18n **36/36 bestanden**, davon **10 UI-Tests** mit echten Chromium-/axe-Prüfungen; gesamtes Decision-Verzeichnis **28/28 bestanden**, davon **10 Adapter-Tests**. Keine Skips/Todos. Direkter Typecheck, Hygiene und Diffcheck bestanden. `pnpm gen` und Workspace-Build abgeschlossen; keine generierten Änderungen oder Schemadiffs. Refresh lädt Status und Agent-Registry erneut; der leere→main-Fall wurde rot→grün geschlossen. Gesamtsuite wird hier nicht erneut
angestoßen; H2s bereits laufender Workspace-Test ist ein separater Lauf. Externe CI unbestätigt.

## Offene Abnahme

F7 liefert UI und vorbereiteten Port. C3/C4-Sichtbarkeitsenumeration, TreeStore und Runtime-Wiring
sind weiterhin ausstehend. Echte native Decision-Backend-Installation/Plattformabnahme ist F3,
kein UI- oder Fake-Test ersetzt sie. F4-Optionen werden nicht dupliziert. Controller integriert
den echten Stack; F7 allein auf main ist nicht lauffähig.


## Nachtrag: Windows-NAS-Evidenz aus F3

Nach der tatsächlichen Messung in #626 behaupten beide Sprachfassungen nicht
mehr, der Windows-Nachweis fehle. Angezeigt werden 2 Threads, 179 Warmaufrufe,
p50/p95 524/822 ms und der VM-Vorbehalt. Das Deutsch-Gate bleibt gesperrt;
Linux, Kev, unabhängige Labels und Rollenvergleich bleiben offen. Der deutsche
400-px-Browsertest wurde zuerst mit dem neuen Windows-Nachweis rot beobachtet,
danach mit den korrigierten Sprachstrings grün; die bisherigen Rechte-, Diagnose-,
CAS-, Abbruch- und axe-Assertions bleiben erhalten. Kein RPC-/Schema-/Backendwechsel.
