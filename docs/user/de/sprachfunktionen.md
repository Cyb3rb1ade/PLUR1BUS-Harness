# Sprachfunktionen

Sprachfunktionen ermöglichen es dir, per Sprache in Echtzeit mit deinen Agenten zu sprechen. Plur1bus unterstützt automatische Spracherkennung (ASR), Sprachsynthese (TTS) und Sprechaktivitätserkennung (VAD). Du kannst Sprachen wählen, zwischen schnellen Profilen und Qualitätsprofilen wechseln, Modell-Downloads verwalten sowie das Echtzeitverhalten und Zeitbudgets anpassen.

Die englische Version dieser Seite ist [../en/voice.md](../en/voice.md). Technische Details zur Web-Oberfläche findest du in [../../web-ui.md](../../web-ui.md).

## Sprachen und Modellprofile

In den **Einstellungen > Sprache** (`/settings/voice`) sowie im ersten Einrichtungsschritt konfigurierst du die Sprachfunktionen:

- **Sprachauswahl:** Wähle die gewünschte Sprache für deine Agenten. Bei der ersten Einrichtung wird deine Systemsprache automatisch vorausgewählt.
- **Profile Schnell (Fast) und Qualität (Quality):**
  - **Schnell:** Optimiert auf niedrige Latenz und kleinere Download-Größen. Ideal für schnelle Antworten auf Geräten mit begrenzten Ressourcen.
  - **Qualität:** Verwendet größere Modelle für präzisere Erkennung und natürlichere Stimmen. Für Englisch schlägt Plur1bus das Qualitätsprofil (Kokoro-Stimme) vor, um Stimmen mit Nur-Forschung-Einschränkungen zu vermeiden.
- **Modelldetails und Downloadgrößen:** Die Modellübersicht zeigt jedes benötigte Modell für Spracherkennung (`asr`), Sprachausgabe (`tts`) und Sprecherkennung (`vad`) samt Dateigröße und Installationsstatus.
- **Lizenzbestätigung:** Modelle mit besonderen Lizenzbedingungen (z. B. CC-BY-SA oder Forschungslizenzen) erfordern vor dem Download eine Bestätigung. Lizenznamen werden als reiner Text dargestellt.
- **Nur-Forschung-Lizenzen:** Stimmen und Modelle, die auf nicht-kommerzielle Forschung beschränkt sind (z. B. Blizzard Challenge), sind deutlich mit einem Hinweis („Nur Forschung, keine kommerzielle Nutzung") gekennzeichnet. Die Ersteinrichtung wählt solche Stimmen niemals automatisch voraus.

## Echtzeit-Modus

Wenn der Echtzeit-Modus aktiviert ist, verarbeitet Plur1bus Spracheingaben kontinuierlich:

- **Endpointing-Verzögerung:** Legt fest, wie lange nach dem letzten gesprochenen Wort gewartet wird (200 ms bis 2000 ms; Standard 700 ms), bevor der Sprechbeitrag abgeschlossen wird.
- **Spekulativer Turn-Start:** Beginnt bereits mit der Vorbereitung der Antwort, während das Satzende erkannt wird, um Antwortzeiten zu minimieren.
- **Bestätigungston:** Spielt ein kurzes akustisches Signal ab, sobald das Ende eines Beitrags erkannt wurde.

## Feature-Schalter und Zeitbudgets

Echtzeit-Sprachinteraktionen laufen in engen Zeitfenstern ab. Du kannst Teilsysteme auf `on` (an), `deferred` (nachgelagert) oder `off` (aus) setzen (`toolSchemas` bietet zusätzlich `reduced` für verkleinerte Schemata):

- **autoRecall:** Automatischer Gedächtnisabruf beim Sprechen.
- **promptEnrichment:** Kontextanreicherung vor der Modellanfrage.
- **reranker:** Relevanzbewertung gefundener Gedächtniskarten.
- **decisionService:** Routing und Sicherheitsprüfungen in Echtzeit.
- **postTurnRefine:** Nachbereitung des Dialogbeitrags im Hintergrund.
- **memoryWrite:** Speichern neuer Notizen im Gedächtnis.
- **compaction:** Zusammenfassung und Kürzung des Kontexts.
- **toolSchemas:** Bereitstellung von Werkzeugdefinitionen für das Modell.

Jedem Feature kann ein individuelles Zeitbudget in Millisekunden (10 ms bis 5000 ms) zugewiesen werden. Neben jedem Schalter zeigt Plur1bus die gemessenen Latenzkosten (Median und p95) an. Features mit dem Hinweis „Vom System vorgegeben" wirken erst, sobald die Engine sie unterstützt.

## Agenten-spezifische Anpassungen

Standardmäßig übernehmen Agenten die globalen Echtzeit-Einstellungen. Auf der Detailseite eines Agenten (**Agenten > [Agent]**) kannst du die Werte für diesen Agenten überschreiben. Überschriebene Felder werden optisch hervorgehoben und können jederzeit auf die geerbten globalen Werte zurückgesetzt werden.
