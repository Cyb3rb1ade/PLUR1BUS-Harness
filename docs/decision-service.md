# Entscheidungsdienst

F2 stellt einen gemeinsamen, speicherunabhängigen `DecisionClient` für Noul, Choice und Score
bereit. Konservative Fehler bleiben typisiert; der Dienst prüft aktuelle Privacy-Regeln vor dem
Backend-Aufruf und teilt das Deadline-Budget über Fallbacks. Eine Auswahl installiert kein Modell
und aktiviert kein fehlendes Backend. `role` bleibt die Voreinstellung.

## Web-Einstellungen (F7)

Unter **Einstellungen → Entscheidungsdienst** wählen angemeldete Personen mit Owner-/Admin-Rolle
`decision.backend` aus (`role`, `laya`, `kev`, `jev`, `auto`). Das bestehende Config-Formular verwendet
`config.get`, eine Änderungsvorschau mit `config.set(dryRun)` und dieselbe Revision beim Speichern.
Weitere vorhandene Decision-Konfigurationswerte bleiben sichtbar; F7 fügt keine F4-Konfigurationsfelder
oder neuen RPCs hinzu. Die Auswahl wirkt live; die Core-Validierung entscheidet verbindlich.

`decision.status` zeigt installierte Backends, Anfragen/Fehler, Fehlerrate und p50/p95. Der
Diagnoseknopf ruft ausschließlich das bestehende `decision.test({agentId})` auf: feste
Gerade/Ungerade-Frage für die Zahl 2, keine freien Prompts. Die Seite lädt `agent.list`, verwendet deterministisch den ersten registrierten Agenten
(nach ID sortiert) und zeigt das Ziel an. Ohne registrierte Agenten bleibt der Test gesperrt. Eine konfigurierte Cloud-Rolle kann durch
diesen ausdrücklichen Test Budget verbrauchen; unsere Tests verwenden ausschließlich feste Fakes.
Bei Navigation wird die UI-Anfrage abgebrochen. Das ist keine Zusage, einen bereits begonnenen
Backend-Aufruf rückgängig zu machen. Core/API prüfen die bestehenden Human-only-Einstellungsrechte;
die Web-Oberfläche zeigt Konfiguration und Diagnose nur angemeldeten Owner-/Admin-Personen.

Die Statuszahlen messen den laufenden Dienst. Davon getrennt sind statische, **vorläufige**
F3-Spikewerte: Apple M5 Pro CPU, macOS arm64, vier Threads, 180 Einzelaufrufe, p50 **110,0 ms**,
p95 **196,3 ms**, maxRSS **1.313.056 KiB**. Deutsch Accuracy **46,67 %**, Brier **0,64731**;
Englisch **65,00 %**, **0,45691** (je 60 Kernfälle). Labels sind nicht unabhängig validiert.
Das **Deutsch-Gate ist nicht bestanden**, automatische Deutsch-Auswahl bleibt gesperrt.
Windows 11 x64 auf der NAS-VM ist inzwischen gemessen: mit 2 Threads warm p50/p95
**524/822 ms** (179 Aufrufe), Laden **11.752 ms**, erster Aufruf **638 ms**;
VM-Diagnose, keine Bare-Metal-Abnahme. OS-Dateicache wurde nicht geleert, Defender
blieb unverändert. Linux-/Kev-Nachweise und ein kalibrierter role-Vergleich fehlen. Gleichzeitige lokale
Last beeinflusste die Messung; diese Zahlen sind keine Latenzgarantie oder Runtime-Freigabe.
Quelle: [F3-Handoff mit Rohdaten und Reproduktion](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/blob/f42fe3950c3edce876933752524f61cdc958a3be/docs/handoffs/2026-10-20-f3-laya.md), [F3-PR #626](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/626).

## TreeChooser-Port (F7, C3/C4 noch offen)

[`DecisionTreeChooser`](../packages/core/src/decision/tree-adapter.ts) adaptiert den bestehenden
Client für `TreeChooser.choose(query,candidates,signal)`. Der aufrufende Tree-Code muss vorher
Rechte, Beziehung und Sichtbarkeit prüfen. Er liefert ausschließlich sichtbare Kurzlisten mit
ID, Name und Summary; keine Store-Handles, Memories oder fremden Beziehungen. Der Adapter
öffnet keinen Store und registriert keinen Tree-Laufzeitpfad.

Maximal 24 Kandidaten plus `none`, Name bis 80 und Summary bis 160 Zeichen, Query bis 4096 Zeichen.
Der vertrauenswürdige Context-Provider liefert Agent/Privacy/Deadline; Signal stammt vom Aufrufer.
Über mehrere Zoom-Level muss derselbe absolute `context.deadline` gelten. Ein Aufruf ist zusätzlich
auf 150 ms begrenzt. `choice` läuft mit Use Case `zoom`; der vorhandene Client übernimmt lokale
Privacy-Prüfung und Deadline/Fallback. Rekursive Decision-Rollen-Kontexte werden abgewiesen.

Ergebnis: maximal zwei Picks mit `confidence` als **normalisierter Optionswahrscheinlichkeit**
(wenn die höchste Wahrscheinlichkeit mindestens 0,35 beträgt; der Aufrufer entscheidet anhand
seiner C3-Schwellen über einen oder zwei Picks), keine Aussage über empirische Kalibrierung. `none`, ungültige Antworten,
Abbruch, Timeout, Privacy-Verweigerung und andere Fehler liefern `[]`: Zoom stoppen, den flachen
Recall behalten. [C3/C4-Spezifikation](superpowers/specs/2026-10-20-memory-tree-relationships-design.md)
und [Plan](superpowers/plans/2026-10-20-memory-tree-relationships.md) bleiben maßgeblich.
TreeStore, Tree-RPC und echte C3/C4-Laufzeitintegration sind weiterhin offen.
