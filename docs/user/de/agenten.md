# Agenten verwalten

Ein Agent ist ein benannter Assistent mit eigenem Gedächtnis und eigenen Skills. Die Agenten-Seite (`#/agents`) listet sie, legt neue an und steuert ihren Lebenszyklus: pausieren, archivieren, exportieren und löschen. Den ersten Agenten legt `plur1bus setup` an, siehe [quickstart.md](quickstart.md). Die englische Version dieser Seite ist [../en/agents.md](../en/agents.md).

## Die Liste

Die Liste zeigt den neuesten Agenten zuerst. Jede Zeile hat den Namen, die ID, das Anlegedatum, die Zahl der Skills und ein Abzeichen für den Zustand: **Aktiv**, **Pausiert** oder **Archiviert**. Mit den Pfeiltasten wechselst du zwischen den Zeilen. Eine Zeile öffnet die Detailseite des Agenten (`#/agents/<id>`) mit Name, ID, Anlegedatum, Zustand, Skills und, wo es sie gibt, den ausdrücklichen Rechten einzelner Personen an diesem Agenten.

Die Detailseite enthält auch die Einstellungen, die dieser Agent überschreibt: die Echtzeit-Spracheinstellungen ([sprachfunktionen.md](sprachfunktionen.md)) und die Medieneinstellungen ([mediensuche.md](mediensuche.md)). Alles, was nicht überschrieben ist, kommt aus den globalen Einstellungen.

## Agent anlegen

Nur Owner und Admins können Agenten anlegen. Alle anderen sehen die Liste und einen Hinweis.

1. Wähle **Agent anlegen**.
2. **Name und ID:** Der Name steht in Listen und Chats (bis zu 80 Zeichen). Die Seite schlägt die ID aus dem Namen vor. Die ID besteht aus Kleinbuchstaben, Ziffern, `-` und `_`, beginnt mit einem Buchstaben oder einer Ziffer und hat höchstens 64 Zeichen. Sie lässt sich später nicht ändern. Eine ID, die es schon gibt, wird abgelehnt.
3. **Skills:** Hake installierte Skills an oder überspringe den Schritt. Skills verwaltest du unter [extensions.md](extensions.md).
4. **Prüfen**, dann **Agent anlegen**.

Ein Wizard-Durchlauf sendet einen Erstellungsschlüssel. Bricht die Verbindung ab, kannst du denselben Wizard erneut senden: Der Server liefert denselben Agenten, und die Seite sagt, dass ein früherer Versuch ihn schon angelegt hatte. Nichts wird doppelt geschrieben. Hat sich die Konfiguration inzwischen geändert, wird nichts geschrieben, und du legst den Agenten erneut an.

## Pausieren, archivieren, exportieren, löschen

Die Schaltflächen stehen auf der Detailseite unter **Lebenszyklus**.

- **Pausieren** hält neue Durchläufe und Hintergrundarbeit an und behält den gesamten Zustand. **Fortsetzen** macht es rückgängig.
- **Archivieren** setzt einen Agenten außer Dienst und behält seine Daten. **Wiederherstellen** holt ihn zurück und behält seinen Pausenzustand. Solange ein Agent archiviert ist, werden Pausieren und Fortsetzen nicht angeboten.
- **Bundle exportieren** lädt eine Datei `<id>-export.json` mit Konfiguration und Skills des Agenten herunter. Geheimnisse sind nicht enthalten.
- **Löschen** wird nur für archivierte Agenten angeboten. Du tippst den Namen des Agenten zur Bestätigung, und der Dialog bietet vorher einen Export an. Beim Löschen werden der Agent, seine Konfiguration und sein Gedächtnis entfernt; das lässt sich nicht rückgängig machen. In diesem Build fehlt dafür eine Funktion der Gedächtnis-Engine: Der Dialog sagt das dann, nichts wird gelöscht, und Archivieren und Exportieren bleiben verfügbar.

Die Seite aktiviert die Schaltflächen für Owner, Admins und für Personen mit dem ausdrücklichen Recht **manage** an diesem Agenten. Alle anderen sehen sie deaktiviert mit dem Grund. Das letzte Wort hat der Server: Er lässt Owner, Admins und Operatoren pausieren und fortsetzen, aber nur Owner und Admins archivieren, wiederherstellen, exportieren und löschen. Die Rechtetabelle steht in [../../rbac.md](../../rbac.md).

## Rechte pro Person

Owner und Admins haben über ihre Rolle jedes Recht an jedem Agenten, und ein Operator kann jeden Agenten nutzen und bedienen. Bei einem Member lässt das ausdrückliche Recht **use** ihn einen einzelnen Agenten sehen und mit ihm chatten, **manage** erlaubt zusätzlich, ihn zu ändern. Ein Viewer mit **use** kann den Agenten sehen. Diese Rechte setzen Owner und Admins, siehe [benutzer-rollen.md](benutzer-rollen.md), oder mit `plur1bus agent rights` weiter unten.

## Was zwischen Agenten getrennt ist

Die Listenseite hat einen eingeklappten Bereich **Agentenisolation**. Pro Agent getrennt sind: Konfiguration, Persona, Sitzungen, Gedächtnis-Pools, Secrets im Geltungsbereich des Agenten, Werkzeugsichten, MCP-Auswahl, Terminal-Umgebung und Budgetzähler. Gemeinsam genutzt werden: der Modellcache für Embeddings und Reranking, der HTTP-Listener, die Prozesssperre, der Betriebssystemprozess und die native Laufzeit. Derselbe Betriebssystemnutzer bleibt eine Vertrauensgrenze; Agenten sind nicht in einzelne Prozesse getrennt.

## Auf der Kommandozeile

Die Agent-Befehle sind in der Befehlsreferenz als experimentell markiert.

```sh
plur1bus agent list
plur1bus agent create notes
plur1bus agent create notes --config agent-settings.json
plur1bus agent validate agent-payload.json
plur1bus agent status notes
plur1bus agent pause notes
plur1bus agent resume notes
plur1bus agent archive notes
plur1bus agent unarchive notes
plur1bus agent export notes --offer-only
plur1bus agent import notes-export.json --on-conflict rename
plur1bus agent delete notes --confirm-name Notes --export-offer <offer>
plur1bus agent remove notes
plur1bus agent rights get notes
plur1bus agent rights set notes <user> use
```

- `agent create <id>` legt einen Agenten an. Mit `--config` liest es eine JSON-Datei mit `persona` (Klartext, bis zu 4000 Zeichen), `model` (ein vorhandenes Modellprofil), `memory`, `rights` und `channels`. Einstellungen brauchen einen laufenden Core in der passenden Version. `agent validate <file>` ist ein Probelauf für so eine Datei: Er meldet Fehler pro Wizard-Schritt und legt nichts an.
- `agent status <id>` zeigt, was der Agent gerade tut und wo sein Arbeitsbereich liegt. `agent list` zeigt die eingetragenen Agenten und, bei laufendem Core, ihre Aktivität.
- `agent export <id>` schreibt einen signierten Export ohne Geheimnisse. `agent import <file>` liest ihn ein und prüft Prüfsummen und Signatur, bevor etwas geschrieben wird; Zugangsdaten werden nicht importiert, fehlende Secrets setzt du mit `plur1bus secret set` ([secrets.md](secrets.md)). `--on-conflict` ist `fail` (Vorgabe) oder `rename`, das den nächsten freien Namen wie `notes-2` wählt.
- `agent delete` braucht `--confirm-name` und `--export-offer`; das Angebot kommt von `agent export <id> --offer-only`. Mit der aktuellen Gedächtnis-Engine meldet es, dass Löschen nicht verfügbar ist.
- `agent remove <id>` nimmt den Agenten nur aus dem Verzeichnis. Seine Daten bleiben unter `agents/<id>` liegen.
- `agent rights get <id>` listet die ausdrücklichen Rechte. `agent rights set <id> <user> <right>` nimmt `use`, `manage` oder `none`; `none` entfernt das ausdrückliche Recht.

## Weiter

- Wizard, Erstellungsschlüssel und Modelllizenzen: [agent-provisioning.md](agent-provisioning.md)
- Mit einem Agenten sprechen: [chat.md](chat.md)
- Was ein Agent sich merkt: [erinnerungen.md](erinnerungen.md)
- Rollen und Rechte: [benutzer-rollen.md](benutzer-rollen.md)
