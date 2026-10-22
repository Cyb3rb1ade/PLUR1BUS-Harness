# Medien-Bibliothek

Du öffnest die Bibliothek über **Aufbau → Bibliothek** (`#/library`). Die englische Fassung steht unter [library.md](../en/library.md).

## Verfügbarkeit und Rechte

**In diesem Stand ist die Web-Anbindung der Bibliothek unvollständig.** Schon das Laden der Medienliste wird von der Web-API abgelehnt. Die Seite zeigt deshalb **Der Mediendienst ist auf dieser Harness nicht verfügbar** und bietet einen erneuten Versuch an. Die folgenden Abschnitte erklären die bereits vorhandenen Bedienelemente für einen Stand mit verfügbarer Medienanbindung. Sie sind keine Zusage, dass diese Abläufe in diesem Build über den Browser funktionieren. Das vorhandene CLI-Gegenstück steht unter [media.md](media.md).

Laut Rechtetabelle dürfen Owner, Admin, Operator, Member und Viewer Medien lesen. Zusätzlich entscheidet der Zugriff auf den Agenten, der das Medium erzeugt hat: Member und Viewer brauchen dafür ein Nutzungsrecht; Listen lassen unzugängliche Agenten aus. Erzeugen, Bearbeiten, Abbrechen und Löschen erlauben Owner, Admin, Operator und Member. Operator und Member brauchen zusätzlich ein Nutzungsrecht am Agenten; Viewer dürfen diese Aktionen nicht ausführen. Beschreibungen ändern ist ebenfalls diesen vier Rollen vorbehalten und setzt Bearbeitungsrechte am Medium voraus. Ein sichtbarer Knopf ersetzt diese Prüfung nicht.

## Galerie und Vorschau

- **Typ** filtert nach allen Medien, Bildern, Videos oder Audio. Die Galerie zeigt zunächst 24 Einträge; **Mehr anzeigen** erweitert sie um jeweils 24.
- Eine Karte zeigt Prompt, vorhandene Beschreibung, Agent und gegebenenfalls Adapter. Öffne sie über **Vorschau**, durch Anklicken des Vorschaubereichs oder mit Eingabe beziehungsweise Leertaste auf diesem Bereich.
- Die Vorschau lädt die gespeicherte Datei. Videos und Audio verwenden einen Player; Bilder zeigen eine Vorschau mit Download-Link. Unter **Manifest** kannst du die aufgelisteten Metadaten lesen.
- Mit **Beschreibung bearbeiten** änderst du den Text und wählst **Beschreibung speichern** oder **Abbrechen**. Die Beschreibung dient bei Bildern auch als Alternativtext; ohne sie verwendet die Ansicht den Prompt.
- **Löschen** verlangt eine Bestätigung. Die Oberfläche bietet dafür kein Rückgängigmachen an.
- **Zur Mediensuche wechseln** öffnet die separate [Mediensuche](mediensuche.md). Der Typfilter der Galerie ist keine inhaltliche Suche.

## Generieren und Bearbeiten

**Generieren** öffnet einen Dialog. Wähle Art, Adapter und Modell, gegebenenfalls den Agenten, und gib einen Prompt ein. Angeboten werden Bilder oder Videos entsprechend den Fähigkeiten der verfügbaren Adapter. Der Dialog bietet keine Audio-Erzeugung an. Ein Negativ-Prompt erscheint für Bilder; weitere Parameter, etwa Größe, Anzahl, Seed oder Dauer, hängen vom Adapter ab. Nicht jeder Adapter bietet jedes Feld an.

**Bearbeiten** an einem Bild oder Video bietet nur die vom Adapter unterstützten Operationen an: Prompt-Bearbeitung, Inpainting, Bild zu Video oder Videobearbeitung. Inpainting braucht ein anderes Bild aus der Bibliothek als Maske. Audio hat keinen Bearbeiten-Knopf.

Bei einem Cloud-Adapter folgt vor dem Senden eine Bestätigung: Prompt und ausgewählte Referenzmedien gehen an diesen Anbieter. Datenschutzregeln, Rechte, Freigaben, Lizenzbestätigung und Budget können den Auftrag weiterhin ablehnen. Die Oberfläche zeigt dann den Fehler und, falls vorhanden, Code und Grund. Hinweise zu Anbietern findest du unter [media.md](media.md), zu Datenschutz unter [datenschutz.md](datenschutz.md).

## Jobs und Voreinstellungen

Ein gestarteter Auftrag erscheint in **Jobs**, mit Zustand und während der Ausführung mit Fortschritt. **Job abbrechen** fordert den Abbruch an. Nach Erfolg öffnet **Ergebnis öffnen** das Medium; **Ausblenden** entfernt einen abgeschlossenen Job aus dieser Ansicht. Neben laufenden Jobs werden bis zu fünf der letzten abgeschlossenen Jobs angezeigt. Nach einer erneuten Verbindung wird die Jobliste neu geladen.

Unter **Voreinstellungen** kannst du je Art einen Standard-Adapter wählen. Diese Auswahl bleibt nur in diesem Browser. Den globalen Schalter **Prompt in erzeugte Dateien einbetten** dürfen nur Owner und Admin ändern. Er steuert das Einbetten in Dateien; das Manifest behält den Prompt unabhängig davon.
