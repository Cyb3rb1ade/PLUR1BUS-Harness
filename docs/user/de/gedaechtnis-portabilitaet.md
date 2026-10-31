# Gedächtnis-Portabilität: Prompt-Import und Export

Du kannst Erinnerungen aus anderen KI-Assistenten (ChatGPT, Claude, Gemini, Grok, Copilot, Le Chat) über einen Prompt importieren und dein PLUR1BUS-Gedächtnis im selben Format exportieren. Die englische Version dieser Seite ist [../en/memory-portability.md](../en/memory-portability.md).

## Funktionsweise des Prompt-Imports

Viele Chat-Assistenten speichern Kontext und Fakten über dich, bieten aber keinen maschinenlesbaren Datenexport an. PLUR1BUS löst das über einen einheitlichen Prompt:

1. Öffne in der Oberfläche **Import** (`#/import`) und wähle die Kachel **Aus einem anderen KI-Assistenten**.
2. Wähle deinen bisherigen Assistenten aus.
3. Kopiere den angezeigten Prompt und füge ihn in einen neuen Chat bei diesem Assistenten ein.
4. Kopiere die Antwort des Assistenten und füge sie in das Textfeld bei PLUR1BUS ein.
5. Hat der Assistent die Ausgabe mit `STATUS: MORE` unterbrochen, klicke auf **Weiteren Teil einfügen**, um Folgeteile anzuhängen.
6. Klicke auf **Vorschau**, um die Einträge zu prüfen und ihre Ziele zuzuordnen.

## Prüfung und Zielwahl

Jeder gefundene Eintrag gehört zu einer von sechs Kategorien:

* **Regeln (Instructions)**: Verhaltensregeln und Stilwünsche („antworte kurz“, „nie X“). Zum Schutz vor Prompt-Injections werden Einträge der Kategorie Regeln nicht direkt importiert und standardmäßig übersprungen. Einträge mit anweisungsähnlichen Formulierungen werden als Verdachtsfall markiert und standardmäßig auf Überspringen gesetzt; diese Empfehlung kannst du in der Vorschau prüfen und anpassen.
* **Identität (Identity)**: Name, Wohnort, Sprachen, persönliche Interessen.
* **Beruf (Career)**: Rollen, Unternehmen, Fachkenntnisse.
* **Vorlieben (Preferences)**: Persönlicher Geschmack und Arbeitsstile.
* **Projekte (Projects)**: Eigene Projekte und Vorhaben.
* **Sonstiges (Other)**: Weitere gespeicherte Fakten.

Für jeden Eintrag wählst du ein Ziel:
* **Nicht importieren**: Der Eintrag wird übersprungen.
* **Mein Gedächtnis**: Gespeichert im persönlichen Nutzerbereich (`scope: user`). Die Engine legt diese Einträge im Speicher des Agenten ab, über den sie geschrieben werden; diesen Agenten wählst du im Assistenten (Standard: dein erster Agent). Der Export liest deine Einträge in „Mein Gedächtnis“ über alle Agenten.
* **Ausgewählte Agenten**: Wird als agent-private Erinnerung hinterlegt. Ein Agent greift in allen Unterhaltungen auf diesen Speicher zu, auch mit anderen Personen und in Gruppen.

Der Knopf **Empfehlung übernehmen** setzt empfohlene Standardziele für alle Einträge.

## Erkennung von Geheimnissen

Der Parser prüft alle Texte auf Passwörter, API-Schlüssel und Tokens. Gefundene Geheimnisse werden durch `[REDACTED:<Muster>]` ersetzt und mit dem Hinweis **Mögliches Geheimnis** markiert. Ein solcher Eintrag bleibt auf **Nicht importieren**, bis du die redigierte Fassung ausdrücklich bestätigst.

## Import rückgängig machen (Rollback)

Jeder Importlauf erhält eine eigene Kennung (`runId`) und ein Protokoll. Um einen Lauf zurückzunehmen, klicke in der Zusammenfassung auf **Import rückgängig machen**.

Der Rollback entfernt unveränderte, während des Laufs erstellte Karten und löst importierte Verknüpfungen. Nach dem Import bearbeitete Karten bleiben erhalten, um Datenverlust zu vermeiden. Nimmt ein Owner einen Lauf zurück, den eine andere Person importiert hat, bleiben deren Einträge in „Mein Gedächtnis“ bestehen und werden getrennt gemeldet; der Lauf bleibt offen, und die importierende Person kann ihn selbst zurücknehmen.

## Gedächtnis exportieren

Auf der Seite **Erinnerungen** (`#/memories`) kannst du über **Gedächtnis exportieren** einen Textblock im selben Format (`PLUR1BUS-MEMORY-EXPORT v1`) erzeugen. Der Text lässt sich kopieren oder als `.md`-Datei herunterladen, um ihn in andere Assistenten mitzunehmen.
