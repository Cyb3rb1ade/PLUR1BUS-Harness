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

* **Regeln (Instructions)**: Verhaltensregeln und Stilwünsche („antworte kurz“, „nie X“). Zum Schutz vor Prompt-Injections wirken fremde Regeln nie sofort; sie landen als Vorschläge in der Prüfwarteschlange und werden einzeln bestätigt.
* **Identität (Identity)**: Name, Wohnort, Sprachen, persönliche Interessen.
* **Beruf (Career)**: Rollen, Unternehmen, Fachkenntnisse.
* **Vorlieben (Preferences)**: Persönlicher Geschmack und Arbeitsstile.
* **Projekte (Projects)**: Eigene Projekte und Vorhaben.
* **Sonstiges (Other)**: Weitere gespeicherte Fakten.

Für jeden Eintrag wählst du ein Ziel:
* **Nicht importieren**: Der Eintrag wird übersprungen.
* **Mein Gedächtnis**: Gespeichert im persönlichen Nutzerbereich (`scope: user`). Steht deinen Agenten im Gespräch mit dir zur Verfügung.
* **Ausgewählte Agenten**: Wird als agent-private Erinnerung hinterlegt. Ein Agent greift in allen Unterhaltungen auf diesen Speicher zu, auch mit anderen Personen und in Gruppen.
* **Workspace**: Nur bei Projekten wählbar. Macht den Eintrag für alle Mitglieder des Workspaces sichtbar.

Der Knopf **Empfehlung übernehmen** setzt empfohlene Standardziele für alle Einträge.

## Erkennung von Geheimnissen

Der Parser prüft alle Texte auf Passwörter, API-Schlüssel und Tokens. Gefundene Geheimnisse werden durch `[omitted]` ersetzt und mit dem Hinweis **Mögliches Geheimnis** markiert. Ein solcher Eintrag bleibt auf **Nicht importieren**, bis du die redigierte Fassung ausdrücklich bestätigst.

## Import rückgängig machen (Rollback)

Jeder Importlauf erhält eine eigene Kennung (`runId`) und ein Protokoll. Um einen Lauf zurückzunehmen, klicke in der Zusammenfassung auf **Import rückgängig machen** oder nutze auf der Konsole:

```sh
plur1bus memory import-text --rollback <runId>
```

Der Rollback entfernt alle importierten Karten und verwirft noch offene Vorschläge.

## Gedächtnis exportieren

Auf der Seite **Erinnerungen** (`#/memories`) kannst du über **Gedächtnis exportieren** einen Textblock im selben Format (`PLUR1BUS-MEMORY-EXPORT v1`) erzeugen. Der Text lässt sich kopieren oder als `.md`-Datei herunterladen, um ihn in andere Assistenten mitzunehmen.
