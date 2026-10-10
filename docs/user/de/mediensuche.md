# Mediensuche

Mit der Mediensuche findest du Bilder, Videos und Audio in deinem Gedächtnis bei Plur1bus. Du suchst mit Text („eine rote
Brücke bei Nacht“) oder mit „Ähnliches finden“, das von einem Medium ausgeht, das du schon hast, und andere ähnliche
sucht. Jedes Ergebnis zeigt einen Wert für die Übereinstimmung und eine Bildunterschrift. Bei Video und Audio zeigt es
außerdem den Zeitabschnitt, und du kannst im Player direkt dorthin springen.

Die englische Fassung dieser Seite ist [../en/media-search.md](../en/media-search.md). Die Seite zum Erzeugen von Bildern
ist [../de/media.md](../de/media.md).

## Zwei Indexe

Plur1bus führt zwei getrennte Indexe:

- **Der Text-Index** ist der Hauptindex. Er enthält deine Gedächtniseinträge. Medien ändern ihn nicht: Anbieter,
  Dimension und Fingerabdruck bleiben, wie sie sind.
- **Der Medien-Index** enthält Bilder, Videos und Audio.

Vektoren werden nie über Räume hinweg verglichen. Eine Suche von Text nach Medien kodiert deinen Text mit dem
Text-Encoder des Medienmodells und vergleicht ihn danach nur mit dem Medien-Index. Dasselbe Modell kann beide Indexe
bedienen. Es wird nur einmal geladen, die Indexe bleiben aber getrennt.

## Bildunterschriften

Jedes Medium bekommt eine Bildunterschrift. Sie ist ein normaler Gedächtniseintrag im Text-Index und als
Medienbeschriftung markiert. Weil sie im Text-Index liegt, findet die normale Gedächtnissuche sie ebenfalls. Bildunterschriften
werden nie mit Bild- oder Audio-Vektoren verglichen.

Du legst fest, woher eine Bildunterschrift stammt:

- **Prompt, dann Nutzer, dann automatisch** (Standard): zuerst die Unterschrift aus dem Prompt, sofern es einen gibt, dann
  eine Unterschrift, die ein Nutzer geschrieben hat, und nur wenn beides fehlt, eine automatische.
- **Nur Nutzer**: Verwendet werden nur Unterschriften, die eine Person geschrieben oder bearbeitet hat.
- **Aus**: Es entstehen keine Unterschriften.

Der Anbieter für die Unterschriften ist lokal, wenn deine Einbettung lokal läuft. Läuft die Einbettung in der Cloud, fragt
die Einrichtung nach dem Anbieter für die Unterschriften, und es ist nichts vorausgewählt. Standardmäßig sind
Unterschriften auf 280 Zeichen begrenzt. Du kannst außerdem Unterschriften pro Abschnitt einschalten, dann bekommt jeder
Teil eines Videos oder einer Audiodatei eine eigene.

Wer ein Medium bearbeiten darf, darf auch seine Unterschrift ändern. Agenten können Unterschriften nicht ändern.

Die Suche kann Treffer aus Unterschriften mit Treffern aus den Medien zusammenführen. Das ist eine Option der Suche und
standardmäßig ausgeschaltet. Sie arbeitet mit den Rangplätzen beider Ergebnislisten, nie mit den Vektoren.

## Anbieter wählen

Text- und Medienanbieter wählst du unabhängig voneinander. Es gibt keine feste Liste erlaubter Kombinationen. Beim
Speichern der Einrichtung prüft Plur1bus nur vier Dinge: ob der Anbieter die Medienart verarbeiten kann, ob die Lizenz
des Modells bestätigt ist, ob der Datenschutz-Schutz den Anbieter zulässt und ob der Anbieter verfügbar ist. Hier sind
drei Beispiele.

**Nur EmbeddingGemma 2 lokal für Text und Medien.** Das ist die einfachste Einrichtung. Dasselbe lokale Modell bedient den
Text-Index und den Medien-Index und wird nur einmal geladen. Alles läuft auf deinem Mac, auch die Unterschriften.

**OpenAI für Text, EmbeddingGemma 2 lokal für Medien.** OpenAI bedient den Text-Index, deine Gedächtniseinträge und
Unterschriften werden also von OpenAI eingebettet. OpenAI kann den Medien-Index nicht bedienen. Die Indexierung der Medien
übernimmt deshalb immer ein Anbieter, der die Medienart unterstützt, hier also das lokale Modell. Auch Textanfragen für die
Mediensuche kodiert das lokale Medienmodell, sie bleiben also auf deinem Mac.

**Jina-Textmodell, EmbeddingGemma 2 lokal für Medien.** Das Jina-Modell bedient den Text-Index. Jina-Modelle stehen unter
CC BY-NC-4.0, das nur nicht-kommerzielle Nutzung erlaubt. Deshalb musst du bei der Einrichtung die Lizenz des
Jina-Modells bestätigen. Der Medien-Index nutzt weiter das lokale EmbeddingGemma-2-Modell.

## Standardeinstellungen bei neuen Installationen

Eine neue Installation startet mit diesen Einstellungen, die du in der Einrichtung alle ändern kannst:

- EmbeddingGemma 2 lokal für den Text-Index und den Medien-Index.
- Alle drei Medienarten aktiv: Bild, Video und Audio.
- Nachindexierung automatisch. Nachindexieren heißt, Medien zu indexieren, die noch nicht indexiert sind. Sie läuft im
  Hintergrund, lässt sich anhalten, wird nach einem Neustart fortgesetzt und hält dein Budget ein.

## Medienarten und Modellvariante

Jede Medienart (Bild, Video, Audio) kannst du einzeln ausschalten. Die Modellvariante richtet sich nach den Arten, die du
behältst. Die Größe des Modells, das geladen wird, kann sich deshalb ändern, wenn du eine Art ein- oder ausschaltest.

## Lizenzen

Jina-Modelle stehen unter CC BY-NC-4.0. Diese Lizenz erlaubt nur nicht-kommerzielle Nutzung, und die Lizenzklasse für
kommerzielle Nutzung lässt Jina-Modelle nicht zu. Die Einrichtung fragt dich vor jedem Schritt nach der Bestätigung der
Lizenz für jedes Modell. Ohne diese Bestätigung kommt sie nicht weiter. Der Schritt „Memory & Mediensuche“ lässt sich
insgesamt überspringen; du kannst ihn später unter Einstellungen → Memory einrichten.

## Datenschutz-Schutz

Ist der Datenschutz-Schutz eingeschaltet, werden Cloud-Anbieter weder für die Einbettung noch für die Unterschriften
verwendet. Plur1bus sendet dann gar keine Anfrage an sie. Lokale Anbieter arbeiten weiter. Ist ein Cloud-Anbieter trotz
eingeschaltetem Schutz konfiguriert, bricht die betroffene Indexierung mit einer Fehlermeldung ab (siehe unten).

## Nachindexieren und Neuindexieren

Die Nachindexierung startet, nachdem du die Mediensuche eingeschaltet hast, und nach jedem Wechsel des Medienmodells. Während
sie läuft, siehst du den Fortschritt. Du kannst sie anhalten und wieder fortsetzen. Solange die Nachindexierung nicht
fertig ist, lässt sich noch nicht alles finden.

Ist dein Budget aufgebraucht, hält die Nachindexierung von selbst an und zeigt den Grund „Budget“. Sie läuft weiter, sobald
das Budget es wieder erlaubt.

Der Medien-Index zeigt vier Zähler:

- **indexiert**: Medien, die gefunden werden können.
- **ausstehend**: Medien, die noch auf die Indexierung warten.
- **fehlgeschlagen**: Medien, die nicht indexiert werden konnten.
- **nicht unterstützt**: Medien, die Plur1bus nicht verarbeiten kann, etwa weil ein Dateiformat oder eine nötige
  Komponente unbekannt ist.

Mit „Reindex“ werden alle Medien mit den aktuellen Einstellungen neu indiziert. Vorher fragt die Anwendung nach einer
Bestätigung. Bis der Vorgang fertig ist, findet die Suche nur einen Teil deiner Medien.

## Wo du es findest

- **Einrichtung**: Der Schritt „Memory & Mediensuche“ wählt die Anbieter, die Medienarten, die Lizenzbestätigungen und den
  Anbieter für die Unterschriften.
- **Einstellungen, Memory**: Der Text-Index und der Medien-Index stehen nebeneinander. Eine Karte zum Indexstatus zeigt die
  Zähler, den Stand der Nachindexierung und die Schaltflächen zum Anhalten und Fortsetzen. Jeder Agent kann die
  Medieneinstellungen im Agentenmenü überschreiben.
- **Ansicht Medien**: Hier suchst du Medien, mit Text oder ausgehend von einem Medium.

## Wenn etwas nicht klappt

| Meldung | Bedeutung | Was tun |
|---|---|---|
| Der Anbieter kann diese Medienart nicht verarbeiten (E_MEDIA_CAPABILITY) | Der gewählte Anbieter unterstützt Bilder, Videos oder Audio nicht. OpenAI etwa kann den Medien-Index nicht bedienen. | Für den Medien-Index einen Anbieter wählen, der diese Medienart unterstützt. |
| Die Lizenz ist nicht bestätigt (E_MEDIA_LICENSE) | Das Modell, etwa ein Jina-Modell, braucht eine Lizenzbestätigung, die fehlt. | Die Einrichtung öffnen und die Lizenz bestätigen. |
| Der Datenschutz-Schutz blockiert einen Cloud-Anbieter (E_MEDIA_PRIVACY) | Der Schutz ist eingeschaltet, und für Einbettung oder Unterschriften ist ein Cloud-Anbieter konfiguriert. Es wurde keine Anfrage gesendet. | Einen lokalen Anbieter nutzen oder den Schutz ausschalten, wenn du Cloud-Anbieter willst. |
| Das Modell ist nicht verfügbar (E_MEDIA_UNAVAILABLE) | Das Modell ist nicht installiert, ein Schlüssel fehlt, oder diese Engine hat keinen Medien-Index. | Das Modell installieren, den Schlüssel eintragen oder die Engine prüfen. |
| Die Dimension passt nicht (E_MEDIA_DIMENSION) | Anfrage und gespeicherte Medien verwenden unterschiedliche Dimensionen, oder das Modell unterstützt die gewählte Dimension nicht. | Nach einem Modellwechsel den Medien-Index neu aufbauen oder eine unterstützte Dimension wählen. |
| Format oder Komponente unbekannt (E_MEDIA_UNSUPPORTED_KIND) | Plur1bus kann dieses Dateiformat nicht verarbeiten, oder eine dafür nötige Komponente fehlt. Das Medium zählt als nicht unterstützt. | Die Datei in ein gängiges Format umwandeln, oder das Medium als nicht unterstützt hinnehmen. |
