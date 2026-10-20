# F6 — Pruning und Skill-Injection

Basis: F2 `c9632307cdd7ef173f2aa052528f7011cd28b76e`, echter Draft-Stack auf #627.
Kein Engine-Pin, Lockfile, neue Abhängigkeit oder Cloud-Aufruf.

## Verhalten

D33 nutzt denselben DecisionClient für `choice keep|truncate|drop`. Rohe Tool-Paare
bleiben durch `forceLocal` auf lokale Backend-Kandidaten begrenzt. Unsicherheit,
Fehler und Fristüberschreitung behalten Ausgaben. Die vorhandene explizite
Heuristik bleibt kompatibel; das fehlende lokale Rollenbackend führt nicht zu
verstecktem heuristischem Ersatz im Produktionsport.

Der Hintergrundjob schützt letzte K Turns, laufende Turns, offene Folgeaufrufe,
aktuelle Referenzen, Approval-/Audit-Daten und explizit wiederhergestellte Paare.
Nach jedem Await werden Revision und Schutzregeln erneut geprüft. `truncate`
zeigt Kopf und Ende mit Originalref; `drop` zeigt Namen, Argument-SHA256, Status
und Originalreferenzen. Migration 6 ergänzt nur die Sichtbarkeitstabelle.
Originale Tool-Events und Nachrichten werden nicht überschrieben. Overlay und
`compaction.prune`-Ereignis werden in derselben Transaktion geschrieben.

`/compact --explain` zeigt maximal 50 Entscheidungen und aggregierte Metriken;
es erzwingt keinen neuen Kompaktierungslauf. `/compact --restore event:123`
stellt ein Paar der bereits autorisierten eigenen Session wieder her. Beide
Befehle laufen im zentralen TurnRunner ohne Modell, Recall oder Capture und
funktionieren auch ohne konfigurierten Chat-Provider. Die Erklärung enthält
keine Originalausgaben oder Argumente. Administrative Antworten gelten nicht
als semantische Referenz, die verborgene Ausgaben automatisch einblendet.

`tokensSaved` ist die positive Differenz der Zeichenzahl/4-Schätzungen für
Original und tatsächlich gerenderte Ansicht, keine Provider-Tokenmessung.
`refetches` zählt explizite Restores; `refetchRate = refetches / pruned` verwendet
alle jemals erzeugten Overlay-Zeilen, auch bereits wiederhergestellte. Das ist
eine Restore-Rate; gewöhnliche gleichartige Tool-Aufrufe werden nicht als
Wiederherstellung erkannt. Unveränderte binäre Altports haben keine
nachträglich erfundenen Einsparungswerte.

D69 behält Rechteprüfung, Keyword- und lokale Embedder-Vorstufe des vorhandenen
LiveCapabilityIndex. Der gleiche DecisionClient wählt aus maximal 12 Kandidaten
schrittweise eine ID oder `none` unter einer gemeinsamen Frist. Es werden nur
Metadaten und ein begrenzter Aufgabenexcerpt übergeben, keine Skill-Anweisungen.
Block gewinnt gegen Pin; Pins belegen einen der höchstens drei Plätze.
Unsicherheit/fehlendes Backend fügt keine automatische Auswahl hinzu, gültige
Pins bleiben. Dadurch kann ein vormals rein lexikalisch injizierter Skill ohne
geeignete Entscheidungsrolle entfallen; das ist die konservative D69-Auswahl.

Anweisungen werden erst nach der Auswahl aus dem aktuellen Katalog gelesen und
nur im dynamischen Suffix gerendert; Prefix-Hashes bleiben stabil. Änderungen
an Blocklisten werden nach dem Await erneut beachtet. `skills.selected` enthält
IDs, Herkunft und Konfidenz, keine Anweisungen oder Aufgabeninhalte. Voice nutzt
die vorhandene `decisionService`-Featurefrist und Pins als Fallback.

## Prüfung und Review

Neue Tests wurden vor Implementierung rot ausgeführt. Unabhängiges Review fand,
dass die Explain-Antwort durch enthaltene Refs Originale wieder einblendete;
Regression rot, Fix und unabhängige Nachprüfung grün. Zusätzlich schützt ein
Rollback-Test gegen einen fremden Turn in der Overlay-/Trace-Transaktion.
Finale Zahlen stehen im PR. Keine Tests werden übersprungen oder gelockert.
Der bestehende D103-Integrationstest behält alle Lifecycle-Assertions; sein
Rollen-Fake beantwortet neben Triage jetzt den neuen Choice-Vertrag.

## Grenzen und Integration

Laya-Produktion, erfolgreiche deutsche Kalibrierung, Kev und Native-x64-Evidenz
bleiben den F3/F4-Gates unterworfen. Diese Phase behauptet keine reale lokale
Modellqualität. F4, F5 und F7 sind parallele echte F2-Stacks; gemeinsame
Composition-Hooks und SessionEventType-Erweiterungen müssen beim regulären
Zusammenführen additiv erhalten bleiben. Kein Merge, Deployment oder CI-Polling.

Lokale Prüfbilanz: Decision/Session/Live-Index 138 Tests bestanden, kein Skip/TODO;
Composition/Triage/Toolcall 912 gesamt, 906 bestanden, 0 Fehler, 1 vorhandener
Live-Opt-in-Skip und 5 unveränderte TODOs (darunter die bekannten Dialekt- und
Idempotenzfälle); RPC-Schema 56 bestanden; Rust-RPC 89 bestanden, 0 ignoriert.
`pnpm gen`, `pnpm docs:gen`, `pnpm docs:check`, Workspace-Typecheck, Hygiene,
Source-Quality, Doclinks und `git diff --check` bestanden.
