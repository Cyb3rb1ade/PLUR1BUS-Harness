# Allgemeine Einstellungen

Öffne **Einstellungen → Allgemein** (`#/settings/general`). Auch `#/settings` öffnet diesen Bereich. Die englische Fassung steht unter [general-settings.md](../en/general-settings.md).

## Zugriff und Felder

Owner und Admin dürfen die Konfiguration im Browser lesen und ändern. Operator, Member und Viewer erhalten von der Konfigurationsschnittstelle keinen Zugriff. Falls eine Ansicht lesbare Werte bereitstellt, sind ihre Eingaben für diese Rollen gesperrt; das erteilt ihnen keine zusätzlichen Rechte.

Die Seite zeigt den aktuellen Wert, den Konfigurationsschlüssel, vorhandene Standardwerte und Grenzen sowie die Auswirkung auf den laufenden Betrieb. Die englischen Feldnamen werden aus dem Schlüssel abgeleitet; der ausgeschriebene Schlüssel darunter macht die Zuordnung eindeutig.

Die Gruppen enthalten unter anderem:

| Gruppe | Einstellungen |
|---|---|
| Core | `core.logLevel`, Zeitbudgets und Textgrenze für Recall, Wartezeit für Capture, Budget zum Herunterfahren |
| Supervisor | Wartezeit zum Beenden (`supervisor.graceMs`), Abstand der Gesundheitsprüfung (`supervisor.healthIntervalMs`) |
| Logs | maximale Dateigröße (`logs.maxBytes`), Anzahl aufbewahrter Dateien (`logs.keep`) |
| Metrics | Metriken aktivieren (`metrics.enabled`), Port (`metrics.port`) |
| Sonstiges | `modules` als schreibgeschützte JSON-Ansicht |

Klappe Gruppen über ihre Überschrift auf. Strukturierte Werte erscheinen als JSON und lassen sich hier nicht bearbeiten. Felder, deren Schlüssel auf Geheimnisse hindeuten, werden ausgeblendet; gehe dafür zu [Geheimnisse](secrets.md).

## Änderungen prüfen und speichern

1. Ändere einen Wert. Noch wird nichts gespeichert. **Änderungen verwerfen** setzt den Entwurf auf die geladenen Werte zurück.
2. Wähle **Änderungen prüfen**. Ungültige Eingaben erhalten eine Meldung am Feld. Die Vorschau zeigt je Schlüssel den alten und neuen Wert und die nötige Neustartklasse.
3. Prüfe die Vorschau und wähle **Änderungen speichern**. **Zurück zum Bearbeiten** führt zum Entwurf. Ist die Vorabprüfung auf dem Server nicht verfügbar, kennzeichnet die Seite die Vorschau als im Browser berechnet; sie bestätigt damit noch keine gültige Speicherung.
4. Nach erfolgreichem Speichern nennt der Hinweis die geänderten Schlüssel und, soweit gemeldet, neu gestartete Einheiten.

**Live** gilt ohne Core-Neustart; **Core-Neustart** oder eine Modul-Neustartangabe kündigt die entsprechende Unterbrechung an. Ist die Klasse unbekannt, wird das angezeigt. Maßgeblich ist die Kennzeichnung am jeweiligen Feld und in der Vorschau.

Hat jemand die Konfiguration seit dem Laden geändert, wird dein Speichern abgelehnt. Lade die aktuellen Werte neu und nimm die Änderungen erneut vor. Beim Verlassen eines Bereichs mit ungespeicherten Änderungen fragt die Oberfläche nach; auch beim Schließen oder Neuladen des Tabs warnt der Browser.

## Weiter

- Ausgehende Verbindungen: [Netzwerk](einstellungen-netzwerk.md)
- Betrieb, Dienste und Konfiguration per CLI: [operations.md](operations.md)
- Ein Feld direkt finden: [Befehlspalette](befehlspalette.md)
