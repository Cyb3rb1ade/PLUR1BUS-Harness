# Chat

Auf der Chat-Seite (`#/chat`) sprichst du mit einem Agenten. Links steht die Liste deiner Chats, rechts das Gespräch. Deine Chats sind privat: nur du siehst sie. Die englische Version dieser Seite ist [../en/chat.md](../en/chat.md).

## Chat starten

1. Wähle **Neuer Chat**.
2. Wähle den **Agenten**. Die Liste zeigt die Agenten dieser Installation.
3. Setze das Häkchen bei **Diesen Chat nicht merken**, wenn nichts davon ins Gedächtnis gelangen darf. Das gilt ab dem Start und lässt sich später nicht ändern. Ein solcher Chat trägt das Abzeichen **Nicht gemerkt**.
4. Schreibe die **Erste Nachricht** und wähle **Chat starten**.

Ein hier gestarteter Chat gehört zu keinem Projekt. Ist kein Agent verfügbar, sagt die Seite das; lege dann zuerst einen an, siehe [agenten.md](agenten.md). Ist kein Modellanbieter eingerichtet, kann der Agent nicht antworten: du bekommst den Hinweis, unter Modelle einen einzurichten, siehe [providers.md](providers.md). Der Chat besteht trotzdem, und der Text deiner ersten Nachricht steht wieder im Eingabefeld.

## Schreiben und stoppen

- **Enter** sendet, **Umschalt+Enter** fügt eine Zeile ein.
- Während der Agent antwortet, zeigt seine Nachricht **Schreibt …**, und **Senden** wird zu **Stopp**. Eine von dir abgebrochene Antwort zeigt **Gestoppt**, eine fehlgeschlagene zeigt **Fehlgeschlagen** mit dem Grund, eine fertige zeigt **Fertig**.
- Das Gespräch zeigt deine Nachrichten, die des Agenten, Werkzeugausgaben und Systemnachrichten. Ein Bild, das der Agent erzeugt hat, erscheint in seiner Nachricht mit einem Download-Link.
- Lässt sich eine Nachricht nicht senden, bleibt dein Text im Eingabefeld. Sende ihn erneut.
- Du kannst einer Antwort beim Entstehen folgen. Ist der Live-Kanal nicht verfügbar, fragt die Seite jede Sekunde nach der Antwort, solange eine läuft, und sagt dir das.

## Der Verlauf

Die Liste zeigt deine direkten Chats: Titel (oder **Chat ohne Titel**), Agent, das Abzeichen **Nicht gemerkt**, wo es zutrifft, und das Datum der letzten Antwort. Sie enthält die neuesten 100 Chats; gibt es mehr, weist ein Hinweis darauf hin. Archivierte Chats stehen nicht in der Liste und lassen sich nicht fortsetzen. Öffnest du einen über seinen Link, steht dort **Chat ist archiviert**. Einen Chat archivierst du auf der Kommandozeile, siehe unten.

## Modell und Denkaufwand

Im Chat-Kopf stehen zwei Auswahlfelder für das Modell und die Denktiefe dieses Chats. Eine Änderung gilt ab der nächsten Antwort. Wie das funktioniert und was es kostet, steht auf [chat-modelle.md](chat-modelle.md).

## Chat zu einem Projekt befördern

Das Menü **Chat-Aktionen** im Chat-Kopf enthält **Chat befördern oder verknüpfen**. Während eine Antwort entsteht, ist es nicht verfügbar. Der Chat selbst bleibt privat; kopiert wird nur der Inhalt, den du auswählst.

1. Wähle das **Ziel**: **Bestehendes Projekt verknüpfen**, **Projektkarte erstellen** oder **Neues Projekt erstellen**. Bei den ersten beiden wählst du das **Projekt**, beim letzten gibst du den **Namen des neuen Projekts** an (bis zu 160 Zeichen).
2. Lege den **Titel der Zielkarte** fest (Vorgabe *Gesprächsnotizen*, bis zu 256 Zeichen).
3. Wähle den **Inhalt zum Kopieren**: **Kein Inhalt** (Vorgabe), **Schriftliche Zusammenfassung** (du schreibst sie), **Ausgewählte Nachrichten** (du hakst sie an) oder **Vollständiges Protokoll**.
4. Wähle **Auswahl vorschauen**, lies, was kopiert würde, und wähle **Beförderung bestätigen**.

Jede Änderung nach der Vorschau verlangt eine neue Vorschau. Die Vorschau gilt zehn Minuten. Systemnachrichten werden nie kopiert, und zu großer Inhalt (mehr als 64 KiB) wird abgelehnt statt abgeschnitten. Der ursprüngliche Chat bleibt unverändert. Gewählter Inhalt landet in einer neuen Karte auf dem Board des Projekts; bei **Kein Inhalt** wird nichts aus dem Chat kopiert. Projekte, die schon mit dem Chat verknüpft sind, listet der Dialog auf. Mehr zu Boards steht in [projekte.md](projekte.md).

## Auf der Kommandozeile

```sh
plur1bus chat --agent main "Which database is staging?"
plur1bus chat --agent main --no-memory "Draft a status mail"
plur1bus chat --session <id> "Where did we leave off?"
plur1bus session list --archived any --search staging
plur1bus session show <id> --messages 50
plur1bus session archive <id>
```

- `plur1bus chat` sendet eine Nachricht oder liest Zeilen von der Standardeingabe bis zum Ende. `--no-memory` entspricht dem Häkchen oben, `--session` setzt einen Chat fort, `--model <profile>` wählt für die Sitzung ein eingerichtetes Modellprofil.
- `plur1bus session list` listet deine Chats. `--agent`, `--kind` (`direct`, `card`, `project`, `channel` oder `acp`), `--archived` (`only` oder `any`), `--search` (Titel und Nachrichten) und `--limit` grenzen die Liste ein.
- `plur1bus session show` gibt die letzten Nachrichten aus (standardmäßig 20). `plur1bus session archive` archiviert einen Chat; nichts wird gelöscht.

## Wenn etwas schiefgeht

| Meldung | Was du tun kannst |
|---|---|
| Kein Modellanbieter eingerichtet, der Agent kann nicht antworten | Richte einen ein, siehe [providers.md](providers.md). |
| Der Agent antwortet noch | Warte die Antwort ab oder wähle **Stopp**. |
| Der Harness kennt diesen Agenten nicht | Der Agent wurde entfernt. Wähle einen anderen. |
| Du darfst das nicht tun | Deine Rolle erlaubt den Chat mit diesem Agenten nicht. Siehe [benutzer-rollen.md](benutzer-rollen.md). |
| Chat nicht verfügbar | Dieser Build hat keinen Chat-Dienst, oder er ist gerade nicht erreichbar. Versuche es gleich noch einmal. |
| Chat nicht gefunden | Den Chat gibt es nicht, oder er gehört dir nicht. |

## Weiter

- Chat-Modelle und Denkaufwand: [chat-modelle.md](chat-modelle.md)
- Lange Gespräche und Zusammenfassungen: [lange-gespraeche.md](lange-gespraeche.md)
- Agenten verwalten: [agenten.md](agenten.md)
- Was ein Agent sich merkt: [erinnerungen.md](erinnerungen.md)
