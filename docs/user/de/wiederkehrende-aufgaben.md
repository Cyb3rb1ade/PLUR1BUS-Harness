# Wiederkehrende Aufgaben

Wiederkehrende Aufgaben führen geplante Hintergrundoperationen wie periodische Wartungen, Synchronisierungen und
automatisierte Arbeitsabläufe aus. Diese Seite beschreibt die Überwachung und manuelle Ausführung geplanter Aufgaben.
Die englische Version dieser Seite ist [../en/recurring-tasks.md](../en/recurring-tasks.md).

In der Weboberfläche befinden sich geplante Aufgaben und deren Ausführungsverlauf unter **Recurring Tasks**
(`#/recurring`).

## Geplante Aufgaben anzeigen

Die Weboberfläche listet alle im System hinterlegten Aufgaben auf (`jobs.list`). Jeder Eintrag enthält:

- **Name und Kennung**: Aufgabenbezeichnung und Funktion.
- **Zeitplan**: Cron-Ausdruck oder Ausführungsintervall.
- **Laufzeiten**: Zeitpunkt des letzten Laufs sowie der nächste geplante Lauf.
- **Status**: Aktueller Betriebszustand (aktiv, pausiert oder deaktiviert).

Beim Auswählen einer Aufgabe wird der Verlauf früherer Ausführungen angezeigt (`jobs.history`), inklusive Laufzeiten,
Status und Fehlerberichten.

## Aufgabe sofort ausführen

Geplante Aufgaben können bei Bedarf manuell außerhalb ihres regulären Intervalls ausgelöst werden. Ein Klick auf
**Jetzt ausführen** öffnet einen Bestätigungsdialog, bevor die Ausführung (`jobs.run`) gestartet wird.

## Konfiguration und Einschränkungen

In der aktuellen Version von Plur1bus stellt das RPC-Backend Methoden zum Auflisten von Aufgaben, Abrufen des Verlaufs
und Auslösen von Läufen bereit (`jobs.run`). Das Anlegen neuer Aufgaben oder Bearbeiten bestehender Zeitpläne über RPC
wird vom Backend-Schema noch nicht unterstützt (siehe [../../web-ui.md](../../web-ui.md)). Die Weboberfläche weist auf
diese Lücke mit einem verständlichen Hinweistext hin.
