# F4: System-One-Client, sichere lokale Abnahme

Basis F2 `c9632307cdd7ef173f2aa052528f7011cd28b76e`, echter Stack auf PR #627.
Die Kev-Messung ist vor Inferenz technisch blockiert: Metriken **null**, kein deutsches Gate,
keine Auslieferung oder automatische Auswahl von Kev. Jev wird in dieser Phase ausschließlich
gegen einen echten Loopback-HTTP-Stub geprüft. Es wurden keine bezahlten oder Cloud-Aufrufe ausgeführt.

## Ausführbarer Plan

1. Offizielle [System-One-OpenAPI](https://docs.typesafe.ai/api/system-one.md) und
   [Modellliste](https://docs.typesafe.ai/models.md) prüfen; `jev-1.13.0` pinnen.
2. Rote Tests für drei Primitive, geschlossene Cloud-Zulassung, Egress, Secret-Lease,
   SQLite-Budget, Fehler/Redirect, Abbruch und Kev-Rundung vor Implementierung ausführen.
3. Einen gemeinsamen Adapter und additive Composition-Hooks implementieren; alle Inhalte
   bleiben standardmäßig ohne Cloud-Freigabe. D105-Kompatibilität nutzt ausschließlich `role`.
4. Geschlossene `decision.systemOne`-Konfiguration mit deaktivierten Defaults ergänzen;
   Generatoren, Dokumentation, Config-/Rust-Parität und relevante Tests prüfen.
5. Kev-Preflight mit exakten Pins, Fehlerlogs und Lizenzmetadaten sichern; unabhängiges
   Root-Review vor regulärem Push und Draft-Stack-PR.

## Ergebnis und Zulassung

`packages/core/src/decision/system-one.ts` ist der gemeinsame Transportadapter für `jev` und
`kev`. Die Composition registriert beide im bestehenden DecisionClient, auch wenn noch kein
Chatprofil existiert; die Rollenfabrik ergänzt denselben Backend-Satz um `role`. Kein zweiter
Chatprovider und kein separater Egress-/Secret-/Budgetdienst wurde aufgebaut.

`cloudEligible` ist ein vertrauenswürdiges internes Kontextflag, standardmäßig falsch. Nur der
feste synthetische `decision.test`-Aufruf setzt es auf wahr. RPC-/Toolparameter können es nicht
setzen. `auto` überspringt Jev bei nicht freigegebenen Inhalten; eine explizite Jev-Auswahl wird
mit `privacy` abgelehnt. `privacy.localOnly` und `forceLocal` verhindern Jev auch mit diesem Flag.
D105 `triage-compat` nutzt unabhängig von der Auswahl ausschließlich `role`, einschließlich der
bisherigen langen Triage-Nachrichten. Rohes Pruning bleibt über `forceLocal` geschützt.

| Konfiguration | Standard / Bedeutung | Restart / Tier |
|---|---|---|
| `decision.systemOne.jev.enabled` | `false`; ein Secret allein aktiviert nichts | live / advanced |
| `.jev.model` | exakt `jev-1.13.0`, kein veränderlicher Alias | live / advanced |
| `.jev.secretRef` | optionaler Secret-Name, kein Inline-Key | live / advanced |
| `.kev.enabled` | `false`; zusätzlich nicht konfigurierbarer Spike-Nachweis erforderlich | live / advanced |
| `.kev.model` | explizit anzugeben, wenn eingeschaltet | live / advanced |
| `.kev.endpoint` | expliziter `/v1/systemone`-Endpunkt auf literal `127.x.x.x` oder `[::1]`; kein `localhost` | live / advanced |

Die Konfigurationsobjekte sind geschlossen. Ohne neue Schlüssel bleiben die vorhandenen
Rollen-Defaults erhalten. Kev bleibt in der Produktions-Composition **ineligible**, da der
native Spike keinen Nachweis liefern konnte. Der erfolgreiche Test mit einem Kev-Antwort-Stub
ist kein echter Kev-Backend-/Modellbeleg.

## Transport, Budget und Secrets

- Jev verwendet ausschließlich `https://api.typesafe.ai/v1/systemone`. Ein interner
  `testOrigin` kann nur eine literal Loopback-Origin sein und ist kein Schema-/RPC-Feld.
- POST läuft über `egress.request`, `maxRedirects=0`, JSON-Content-Type, maximal 65.536 Bytes
  pro Request und dekomprimierter Antwort, ohne Fehlerbody und ohne automatischen Retry.
  Der gemeinsame verbleibende Deadline-Rest und das Abbruchsignal begrenzen auch den HTTP-Aufruf.
- Vor dem Request reserviert das vorhandene SQLite-CallBudget unter dem vertrauenswürdigen
  Benutzer/Agent/Projekt. Input-Schätzung: UTF-8-Bytes des gesamten JSON-Bodys plus 1.024;
  endliche Output-Reserve: **65.536 Tokens**. Das ist bewusst konservativ. Ein kleines
  Tokenbudget kann deshalb bereits den synthetischen Test verweigern, obwohl der tatsächliche
  Verbrauch klein wäre. Nach erfolgreichem Aufruf wird die gültige API-Usage abgerechnet.
- Sobald ein Sendeversuch möglich war, verbraucht ein Fehler ohne verlässliche Usage die
  Schätzung. Nur sicher vor dem Sendeversuch wird eine ungenutzte Reservierung freigegeben.
  Ein Rollen-Fallback ist ein eigener, erneut budgetierter Aufruf; derselbe Backendaufruf
  wird nicht kostenlos wiederholt.
- Jev least den aktuellen Key pro Aufruf als Core mit `purpose=decision` und
  `profileId=decision-service`, liest die noch gültige Lease unmittelbar vor dem Request und
  widerruft sie im `finally`. Abbruch oder ein Wechsel des live Secret-Verweises verhindert
  den Versand mit der alten Zulassung. Der Key erscheint nur im Authorization-Header;
  Response-/Netzwerk-/JSON-Fehler werden als feste Decision-Fehler ausgegeben, nie als rohe Texte.

Noul wird auf `probability`, Choice auf ID/Verteilung/Konfidenz und Score anhand numerischer
Legendenschlüssel auf das geordnete Array des bestehenden F2-Vertrags abgebildet. Fremde IDs,
fehlende Optionen, Zusatzfelder, ungültige Werte, inkonsistente Wahl/Score oder ein fremder
Modellname werden abgelehnt. Jev behält die Summentoleranz `1e-6`. Ausschließlich beim Kev-Adapter
wird die dokumentierte API-Rundung auf vier Dezimalstellen korrigiert: maximal
`0.00005 * Optionsanzahl + 1e-12` Summenabweichung, danach Normalisierung. Der zentrale
DecisionClient wurde dafür nicht gelockert.

## Kev-Preflight und offene Abnahme

[Gesicherter Bericht](../evidence/decision-kev/README.md) mit exakten Git-/Hub-Pins,
Artefaktgrößen, Dependency-Lizenzmetadaten und den beiden unveränderten Fehlerlogs.
`files.pythonhosted.org` löst auf diesem Host auf `0.0.0.0`/`::` auf; frozen Online-Sync
scheitert am Download, frozen Offline-Sync an fehlenden Wheels. Keine DNS-Umgehung, keine
anderen Dependency-Versionen, kein großes Modell heruntergeladen, kein Server gestartet.

Offen bleiben der echte lokale Kev-MLX-Spike mit deutschen/englischen Fällen, Accuracy/Brier,
Cold-/Cache-Latenzen und RSS, unabhängige Labelprüfung sowie der Vergleich mit dem Rollenbackend.
Es gibt hier **keine** Freigabe von Kev und kein bestandenes deutsches Gate. Ein beaufsichtigtes
Python-Modul samt Manifest/README und Lebenszyklus muss erst nach diesem Nachweis integriert
werden. Auch Jev wurde nicht gegen den kostenpflichtigen Cloud-Endpunkt getestet; dafür ist eine
ausdrückliche Owner-Freigabe im Chat erforderlich. Die lokale API-Abnahme ersetzt sie nicht.

## Lokale Abnahme

- TDD: fehlender Adapter/Config rot; zusätzliche rote Assertion-Fälle für fehlerhaftes JSON
  und einen live geänderten Secret-Verweis, danach grün.
- **97/97 relevante Tests**, 0 skips/todos: vollständige Config-Schema-Suite, alle Decision-Tests
  und vorhandener POST-Guard. Echte Loopback-HTTP-Verbindungen über echten Egress, SQLite-
  Budget und Memory-Secret-Store; feste Antwort-Stubs, keine tatsächlichen Modellaufrufe.
- Eine echte Core-Instanz im Test prüft die registrierte Jev-Diagnose ohne Chatprofil,
  Secret-RPC, feste synthetische Nutzlast und Ablehnung freier RPC-Nutzlasten.
- Breite Core-Suite nach Workspace-Build: **9.673 Tests, 9.620 pass, 9 fail, 19 skip,
  25 todo**, 0 cancelled. Die neun Fehler betreffen ausschließlich unveränderte Importtests
  (`fs-atomic`: 3, `rollback-ledger`: 6). Dieselben Fehler wurden im G4-Baseline-Lauf auf
  Main `31f8dd62cb1bf022ae99cae58a9538e38df5c918` reproduziert (73 Importtests: 64 pass,
  9 fail); Importquellen und -tests sind gegenüber diesem Main-Stand unverändert.
  Die breite Suite ist deshalb ausdrücklich nicht vollständig grün. Keine neuen skips/todos.
- **59 Rust-Config-Tests** bestanden, einschließlich der neu generierten Defaults-, Restart-,
  Format- und Tier-Fixtures; keine Änderung oder Lockerung der Rust-Implementierung.
- Gesamt-Typecheck, `pnpm gen`, `pnpm docs:gen`, `pnpm docs:check`, Dokumentlinks und Hygiene
  bestanden. Generierte Settings-Palette und Config-Fixtures sind Teil der Änderung.
- Root hat Adapter, Zulassung, Composition, Lease-/Budget-Finally und Rundungsgrenze unabhängig
  geprüft. Keine weiteren umsetzbaren Befunde im vereinbarten Clientumfang.

Keine neuen SDK-/Produktabhängigkeiten; Engine-Pin und Lockfile unverändert. F5-Routing und
Providerdateien bleiben unberührt. Diese Phase liefert den sicher begrenzten Clientumfang,
behauptet aber nicht den Abschluss des blockierten gesamten F4-Spikes. Merge übernimmt der Controller.

## Ausführbare Acceptance-TODOs

`packages/core/test/decision/acceptance.todo.test.ts` ergänzt **2 neue TODO-Tests** auf dem
unveränderten echten Kev-Preflight: gestarteter lokaler MLX-Server mit Inferenz sowie
Cold-/Cache-Latenzen/RSS; unabhängig gelabelte, hashgleiche DE/EN-/Rollenmessung mit
Accuracy-/Brier-Grenzen vor deutscher Zulassung. Der dokumentierte DNS-/Wheel-Blocker
bleibt offen; `metrics: null`, `inferencePerformed: false` und fehlende Zulassung
werden nicht in Erfolg umgeschrieben. Bezahlte Jev-Aufrufe sind kein erforderlicher
Abnahmetest dieses Clientumfangs; die bestehende Loopback-Abnahme bleibt gültig.

Node 24.21, vollständiges `packages/core/test/decision/*.test.ts` mit
`--experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1`:
**33 Tests: 31 pass, 2 TODO, 0 fail, 0 skip**. Die zwei Bodies wurden ausgeführt und
scheiterten erwartungsgemäß an `inferencePerformed: false` beziehungsweise fehlenden
Messwerten. Bestehende Tests wurden nicht geändert oder zu TODOs gemacht. Native
Receipts und erfüllte Assertions sind vor Entfernen der TODO-Gründe erforderlich.
