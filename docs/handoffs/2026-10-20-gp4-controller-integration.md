# Großpaket 4 — Controller-Integration und offene Abnahmen

Stand: 20.10.2026. Diese Übersicht behauptet keine gemeinsame Abnahme der noch
getrennten Branches. Merge, reguläres Zusammenführen und Engine-Pin gehören dem
Controller; kein CI-Polling oder Deployment wurde vorgenommen.

## Reihenfolge

| Phase | PR | Basis und Umfang |
| --- | --- | --- |
| F1 | [#619](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/619) | main; Vertrag/Config/ADR-015 |
| F2 | [#627](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/627) | F1; gemeinsamer Client, Rollenbackend, RPC |
| F3 | [#626](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/626) | F1; gemessener Laya-Spike, Produktionsintegration offen |
| F4 | [#637](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/637) | F2; System-One-Adapter, Jev-Loopback, Kev-Preflight blockiert |
| F5 | [#635](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/635) | F2; Modellpolicy und Session-Bindung |
| F6 | [#638](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/638) | F2; Dreiweg-Pruning und finale Skill-Auswahl |
| F7 | [#642](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/642) | TreeChooser-Schnittstelle und Web; C3/C4 nicht duplizieren |
| G0 | [#618](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/618) | main; Föderations-Gatetabelle |
| G4 | [#624](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/624) | main; reines Leihmodell und Fakes, keine Laufzeit |
| H1 | [Engine #248](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/pull/248) | Engine main regulär zusammengeführt; Vertrag 1.19.0 |
| H2 | [#636](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/636) | Harness main; Medienverdrahtung gegen Vertrags-Fakes |

F4–F7 sind Geschwister auf F2, keine lineare Kette. F3 kann unabhängig von diesen
Verbrauchern geprüft werden. G0/G4/H2 hängen nicht vom F1/F2-Stack ab.

## Konflikte additiv auflösen

- `composition/index.ts`: F4 Backend-Factory/`hooks.backends` und synthetisches
  `cloudEligible`, F5 `SessionModelRouting`/Restore/Modell-Event und F6
  `selectSkills` erhalten. Genau einen DecisionClient und den bestehenden
  Rollen-/ProviderRouter beibehalten.
- `composition/provider.ts`: F5 temporären profilgebundenen Failover und F6
  finale Skill-Auswahl im dynamischen Suffix gemeinsam übernehmen.
- `SessionEventType` und `EVENT_TYPES`: Vereinigung von `decision.completed`,
  `model.selected`, `compaction.prune` und `skills.selected`. Kein Enum durch die
  Version nur eines Branches ersetzen.
- Schemas zuerst zusammenführen, danach `pnpm gen`/`pnpm docs:gen` laufen lassen.
  Python-Schema, RPC-/OpenAPI-Dokumentation, Fixtures und Settings-Index aus den
  vereinigten Quellen erzeugen. Engine-Pin und Lockfile bleiben Controller-Arbeit.
- H2 ergänzt Media-Codecs und `mediaHostFetchReady`; #602 ergänzt Host Fetch und
  Modellports. Fetch muss vor Engine-Erzeugung tatsächlich am Host installiert
  sein; H2 entfernt den Engine-Medienblock ohne diesen Port vollständig.
  Zusätzlich lässt nur ein `media`-Objektschema im installierten öffentlichen
  Engine-Vertrag diese Projektion zu, da ältere Pins auch `enabled:false` als
  unbekannte Eigenschaft zurückweisen. Beide Fähigkeiten
  erhalten, keine Versionsprüfung als Ersatz für den Fetch-Port.
- F7-TreeChooser ist nur ein Store-freier Adapter. Sobald D116 C3/C4 auf main
  sind, deren reale Verbraucher anbinden und die entsprechenden Tests ergänzen.

Danach gemeinsam die Zusammensetzung, Session-/Event-Inventare, Modell-Failover,
Privacy-Wechsel, Skill-Pins/Blocks, Präfix-Hashes und Web-RPC-Grenzen prüfen.
Getrennte grüne Branch-Tests belegen noch keine konfliktfrei vereinigte Laufzeit.

## Gültige Gates

F3: Laya-DE-Kandidatenlabels erreichen 46,67 % gegenüber EN 65 %; die Labels sind
agentenerstellte Spike-Kandidaten, keine unabhängig bestätigte Goldmenge. Das
Deutsch-Gate ist nicht bestanden. Windows-x64-NAS-Messungen sind inzwischen in #626 geliefert (Node 24.21,
1/2 Threads, je 180 Fälle; 2 Threads warm p50/p95 524/822 ms). Linux x64
wartet noch auf SSH-Einrichtung. Rollenvergleich, unabhängige Labels und
Produktions-/Katalogintegration bleiben offen. Die VM-Werte sind keine
Bare-Metal-Abnahme; OS-Dateicache wurde nicht geleert, Defender blieb unverändert.

F4: Jev wurde ausschließlich an Loopback geprüft. Nur der feste synthetische
Owner/Admin-Test wird als cloud-geeignet zertifiziert. Natürliche Aufgaben,
Modellrouting und Skill-Auswahl erhalten keine solche Freigabe. Kev scheitert im
Preflight an der eingefrorenen Python-Abhängigkeitsbeschaffung; Inferenz-,
Latenz- und Deutschmetriken sind unbekannt, nicht null gemessen. Keine
Auslieferung als erfolgreicher Kev-Spike.

G1 wartet auf Föderations-S0 und Peer-Principal/P9. G2 wartet zusätzlich auf
Phase P; G3 benötigt WP2/WP3. SSH-S0 ist kein Ersatz für Föderations-S0. G4
Laufzeit wartet auf D116 C3/C4, WP3/WP4 und P8.

H1 hat echte lokale Gemma-Bild-/Audio-Messungen mit blockiertem globalem Fetch.
Das belegt die Engine, nicht H3 über den produktiv gepinnten Harness. H2 benötigt
Controller-Pin auf den passenden Engine-Vertrag, #602 Host Fetch und für echte
Cloud-Einheitenbudgets #603. Unterschiedliche globale Medienmodelle/Dimensionen
pro Agent sind durch Engine 1.19.0 nicht abgedeckt und werden abgewiesen.
H3 bleibt bis zur realen Harness-Abnahme offen. Kein bezahlter Provider wurde
aufgerufen, keine Credentials werden in diesem Handoff wiedergegeben.
