# Erinnerungen

Die Seite Erinnerungen (`#/memories`) zeigt, was ein Agent gespeichert hat, durchsucht es und sagt dir, ob das Gedächtnis gesund ist. Dieselbe Seite hat auch die Tabs Träume ([traeume.md](traeume.md)) und Medien ([mediensuche.md](mediensuche.md)). Die englische Version dieser Seite ist [../en/memories.md](../en/memories.md).

Die Seite zeigt immer das Gedächtnis eines Agenten. Gibt es mehr als einen Agenten, wählst du oben im Feld **Agent**, wessen Gedächtnis du siehst; die Wahl bleibt erhalten, solange du auf der Seite bleibst. Ohne Agenten gibt es kein Gedächtnis zu zeigen, siehe [agenten.md](agenten.md). Eine kleine Zeile unter dem Titel sagt, ob die Live-Aktualisierung an ist. Ist der Live-Kanal nicht verfügbar, nutze **Aktualisieren**.

## Bereiche

Jede Erinnerungskarte gehört zu einem von drei Bereichen, die als Abzeichen erscheinen:

- **Agent-privat**: Karten gehören diesem Agenten.
- **Arbeitsbereich** und **Nutzer**: Karten liegen in gemeinsamen Pools. Wenn du eine Karte mit `memory share` teilst (siehe unten), entsteht in einem davon eine geteilte Karte.

Eine geteilte Karte zeigt, wer sie geteilt hat und aus welcher Ursprungskarte sie stammt.

## Zustand

Das Feld **Zustand** zeigt, wie bereit die Gedächtnis-Engine ist: **Bereit**, **Nicht bereit** oder **Eingeschränkt** mit dem Grund, den Prozess und seine Laufzeit, den Zustand von Embedder und Reranker (bereit, lädt, wärmt auf, fehlgeschlagen, deaktiviert), das Schema des Speichers und ob eine Migration nötig ist, ob geteiltes Gedächtnis unterstützt wird und die Kartenzahlen pro Bereich. **Archiviert (vergessen)** zählt die Karten, die vergessen wurden. Darf deine Rolle einen Teil nicht lesen, sagt das Feld es und zeigt den Rest.

## Suche

**Erinnerungen durchsuchen** fragt das Gedächtnis so, wie es ein Agent tut. Die Suche ist semantisch, oft hilft eine kurze Formulierung mehr als eine lange. Unter den Ergebnissen zeigt **Warum diese Ergebnisse**, wie die Antwort entstanden ist: die Gesamtzeit, die Phasen, das Größenlimit, gekürzte oder verworfene Blöcke und die Engine-Spur. Welche Karte welche Zeile geliefert hat, steht nicht darin.

## Karten

Die Liste zeigt die Karten des gewählten Agenten mit Zusammenfassung, Bereichs-Abzeichen und Datum. **Nach Thema filtern** grenzt sie ein. Die Liste lädt 20 Karten auf einmal und hört bei 100 auf; ältere erreichst du mit dem Themenfilter. Eine Karte öffnet sich in einer Detailansicht mit dem vollen Text, **Kennung**, **Erstellt**, **Herkunft**, **Epistemischer Status** und bei geteilten Karten **Geteilt von** und **Ursprungskarte**. Eine Karte, die vergessen wurde oder nie existierte, zeigt **Erinnerung nicht gefunden**.

Die Seite liest nur. Um das Gedächtnis zu ändern, nutzt du die Kommandozeile, siehe unten.

## Prüfungen

Schlägt jemand eine Korrektur zu einer geteilten Erinnerung vor, wartet sie unter **Prüfungen** als **Offen**, mit dem Text vorher und nachher und dem Namen des Vorschlagenden. Die Seite listet Vorschläge, kann sie aber weder annehmen noch ablehnen; das geht auf der Kommandozeile.

## Medien

Der Tab **Medien** zeigt den Index für Bilder, Videos und Audio neben dem Textindex: an oder aus, Anbieter, Modell, die Zahlen für indizierte, ausstehende, fehlgeschlagene und nicht unterstützte Elemente und den Fortschritt der Nachindizierung. Owner und Admins können sie pausieren, fortsetzen und eine Neuindizierung starten, wobei du zuerst ein Bestätigungswort tippst. Alle anderen sehen nur den Zustand. Die Einstellungen stehen in [mediensuche.md](mediensuche.md).

## Embedding-Modell und Reranker

Die Gedächtnis-Engine macht aus jeder Erinnerung mit einem **Embedding-Modell** einen Vektor und ordnet mit einem **Reranker**, was eine Suche findet. Welche laufen, steht in `engine.embedding` und `engine.reranker`; ohne Einstellung sind es multilingual-e5-small (MIT, 384 Dimensionen) und BGE-reranker-v2-m3.

Der Einrichtungsassistent (`#/setup`) fragt beides im Schritt **Gedächtnis** ab, direkt nach der Anmeldung und bevor der erste Agent angelegt wird. Er bietet die lokalen Modelle an, die die Gedächtnis-Engine laden kann:

- Embedding: EmbeddingGemma 2 (Apache-2.0, 768 Dimensionen, vorausgewählt), multilingual-e5-small (MIT, 384), Jina v5 Text Nano (768) und Jina embeddings v3 (1024). Beide Jina-Modelle stehen unter CC BY-NC-4.0.
- Reranker: BGE-reranker-v2-m3 (Apache-2.0) und Jina reranker v2 base multilingual (CC BY-NC-4.0).

Ein nicht-kommerzielles Modell braucht die Bestätigung des Owners in einem Dialog und steht für kommerzielle Nutzung nicht zur Wahl. Beim Weitergehen schreibt der Assistent deine Wahl nach `engine.embedding` und `engine.reranker` (nur, was vom laufenden Modell abweicht); die Gedächtnis-Engine startet neu und nutzt sie ab dann. Ein Modell, das läuft, aber nicht in der Liste steht, etwa ein Cloud-Embedding, erscheint als **In Verwendung** und bleibt, solange du kein anderes wählst. `plur1bus 1staid check` meldet unter `models.cache`, ob die gewählten lokalen Modelle schon heruntergeladen sind; sie laden beim ersten Start, der sie braucht.

Das Embedding-Modell lässt sich nur ändern, solange das Gedächtnis keine Daten enthält. Jede Gedächtnistabelle gehört zu dem Vektorraum, in dem sie angelegt wurde, und schon das Anlegen eines Agenten legt seine Tabelle an. Sobald Daten da sind, zeigt der Assistent das Modell in Verwendung und bietet nur noch den Reranker an, und eine Änderung von `engine.embedding` aus der Weboberfläche wird mit `E_CONFLICT`, Grund `embedding-migration-required`, abgelehnt. Bestehende Erinnerungen in ein anderes Embedding-Modell umzuziehen ist eine Re-Embedding-Migration, siehe [reembed.md](reembed.md). Der Reranker hält keine Daten und lässt sich jederzeit ändern.

## Auf der Kommandozeile

```sh
plur1bus memory add --agent main "Staging runs on the small database"
plur1bus memory recall --agent main --joined "which database is staging"
plur1bus memory list --agent main --since 7d
plur1bus memory list --agent main --topic staging --limit 10
plur1bus memory show --agent main <id>
plur1bus memory correct --agent main <id> "Staging runs on the large database"
plur1bus memory forget --agent main <id> --yes
plur1bus memory share --agent main <id> --to workspace
plur1bus memory state --agent main
plur1bus memory propose --agent main <shared-id> "Corrected text" --note "Out of date"
plur1bus memory proposals list --agent main --status pending
plur1bus memory proposals accept --agent main <proposal-id>
plur1bus memory proposals reject --agent main <proposal-id> --note "Not correct"
```

- `memory add` speichert eine Erinnerung für einen Agenten, `memory recall` liefert, was zu einer Anfrage passt. `--joined` gibt die Blöcke als einen Text aus.
- `memory list` zeigt die Karten eines Agenten: Kennung, Bereich, wer geteilt hat und die Zusammenfassung. `--topic` lässt sich nicht mit `--since` und `--until` kombinieren. Beide nehmen Epochen-Millisekunden oder einen relativen Wert wie `30m`, `12h` oder `7d`. Ohne Zeit-Option umfasst die Liste die gesamte Historie.
- `memory correct` schreibt eine korrigierte Fassung einer Karte. `memory forget` vergisst eine Karte und gibt den Grabstein (Tombstone) aus, den es geschrieben hat; im Terminal fragt es vorher, in einem Skript übergibst du `--yes`.
- `memory share --to` nimmt `workspace` oder `user`. Eine als sensibel markierte Karte wird erst geteilt, wenn eine Person bestätigt: Ein Terminal fragt, ein Skript übergibt `--allow-sensitive`, nachdem die Person zugestimmt hat.
- `memory state` gibt die Kartenzahlen pro Bereich und die Tombstones aus.
- `memory propose` schlägt eine Korrektur einer geteilten Karte vor, statt sie zu ändern. `memory proposals list` filtert mit `--status` (`pending`, `accepted`, `rejected` oder `stale`); `accept` und `reject` erledigen einen Vorschlag, `reject` nimmt optional `--note`.
- Der Wechsel auf ein anderes Embedding-Modell hat eine eigene Seite, [reembed.md](reembed.md).

Die Gedächtnis-Befehle außer `add` und `recall` sind in der Befehlsreferenz als experimentell markiert. Deine Rolle und deine Rechte am Agenten entscheiden, was du darfst; den Rest lehnt der Server ab.

## Weiter

- Träume, das Aufräumen des Gedächtnisses im Hintergrund: [traeume.md](traeume.md)
- Gedächtnis in Bildern, Video und Audio: [mediensuche.md](mediensuche.md)
- Embedding-Modell wechseln: [reembed.md](reembed.md)
- Was auf diesem Rechner bleibt: [datenschutz.md](datenschutz.md)
