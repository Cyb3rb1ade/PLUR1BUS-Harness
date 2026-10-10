# Bilder erzeugen

Mit `plur1bus media` erzeugst und bearbeitest du Bilder. Jeder Auftrag läuft als Job: Du startest ihn, Plur1bus holt das
Ergebnis beim Anbieter ab und legt das Bild privat im eigenen Speicher ab. Dort bleibt es, bis du es löschst. Bilder
kannst du mit Cloud-Anbietern oder lokal auf deinem Mac erzeugen.

Videos sind in Arbeit und noch nicht verfügbar. Die technischen Details stehen in [../../media.md](../../media.md) und
[../../media-adapters.md](../../media-adapters.md). Die englische Fassung dieser Seite ist [../en/media.md](../en/media.md).

Siehe auch: [Mediensuche](../de/mediensuche.md), zum Suchen von Bildern, Videos und Audio in deinem Gedächtnis.

## Anbieter einrichten

Ein Anbieter ist ein **Adapter**. Cloud-Adapter (OpenAI, Google, OpenRouter, fal, Replicate, Together, xAI) brauchen einen
Schlüssel. Lokale Adapter (Draw Things, Core ML) brauchen keinen.

Den Überblick über die Adapter bekommst du so:

```sh
plur1bus media adapters
```

### Cloud: OpenAI als Beispiel

1. Speichere den Schlüssel als Geheimnis. Der Wert kommt von der Standardeingabe:

   ```sh
   printf %s "$OPENAI_API_KEY" | plur1bus secret set media/openai
   ```

2. Verweise in der Konfiguration auf den Namen, nicht auf den Schlüssel:

   ```sh
   plur1bus config set media.adapters.openai.apiKeyRef media/openai
   ```

Der Adapter ist eingeschaltet, sobald der Name auf ein gespeichertes Geheimnis zeigt. Mit
`plur1bus config set media.adapters.openai.enabled false` schaltest du ihn aus, auch wenn ein Schlüssel vorhanden ist.
Die übrigen Einstellungen (Modell, Zeitlimit, gleichzeitige Aufträge) stehen in [../../config.md](../../config.md).

### Lokal: Draw Things

Draw Things stellt auf deinem Mac eine Schnittstelle unter `127.0.0.1:7860` bereit. Schalte den Adapter ein und nenne das
Modell so, wie Draw Things es anzeigt:

```sh
plur1bus config set media.adapters.drawthings.enabled true
plur1bus config set media.adapters.drawthings.model <modelldatei>
```

### Lokal: Core ML

Der Core-ML-Adapter funktioniert nur auf macOS mit Apple-Silicon-Chip. Der Helfer wird aus dem Quellcode gebaut:

```sh
swift build -c release --package-path tools/coreml-sd-helper
```

Dann trägst du den absoluten Pfad des fertigen Programms und den Namen eines kompatiblen Modellordners ein. Modelle lädt
Plur1bus nicht selbst herunter.

```sh
plur1bus config set media.adapters.coreml.binary /absoluter/pfad/tools/coreml-sd-helper/.build/release/media-coreml
plur1bus config set media.adapters.coreml.model <modellordner>
plur1bus config set media.adapters.coreml.enabled true
```

## Bild erzeugen

```sh
plur1bus media generate "Ein Wald im Nebel, Fotografie" --adapter openai --wait --out wald.png
```

- `--adapter` bestimmt, welcher Anbieter das Bild macht.
- `--count 2` erzeugt mehrere Bilder in einem Auftrag. `--width` und `--height` setzen die Größe, sofern der Anbieter das
  zulässt.
- `--wait` wartet bis zu zehn Minuten und zeigt den Fortschritt auf der Fehlerausgabe. Danach ist der Auftrag fertig.
  Läuft er länger, bleibt er abfragbar.
- `--out wald.png` schreibt die Datei. Eine bestehende Datei bleibt unverändert, der Befehl legt eine neue an.

Ohne `--wait` gibt der Befehl nur die Kennung des Auftrags zurück. Den Stand fragst du so ab:

```sh
plur1bus media job <auftrags-id>
```

### Metadaten ins Bild schreiben

Prompt, Parameter und Modell lassen sich ins Bild selbst einbetten. Das ist standardmäßig **aus**. Für einen Auftrag
schaltest du es mit `--embed-metadata true` ein:

```sh
plur1bus media generate "Ein Wald im Nebel" --adapter openai --embed-metadata true --wait --out wald.png
```

Unabhängig davon speichert Plur1bus immer ein Manifest mit allen Angaben zum Auftrag.

## Bild bearbeiten

Ein gespeichertes Bild änderst du mit `media edit`. Als Referenz nennst du die Kennung einer Ausgabe aus deinem Speicher,
nicht einen Dateipfad:

```sh
plur1bus media edit "Füge Schnee hinzu" --reference <ausgabe-id> --wait --out schnee.png
```

Mit `--mask <ausgabe-id>` markierst du den Bereich, der verändert werden soll. Masken kennen nur einige Adapter, etwa
OpenAI, fal und Replicate (je nach Modell). Ein Adapter, der das nicht kann, lehnt den Auftrag ab, bevor er ihn
abschickt.

## Aufträge und Ausgaben

| Befehl | Was er tut |
|---|---|
| `plur1bus media jobs` | Zeigt deine Aufträge. Mit `--agent main` nur die eines Agenten. |
| `plur1bus media job <auftrags-id>` | Zeigt Stand, Fehler und Ergebnis eines Auftrags. |
| `plur1bus media cancel <auftrags-id>` | Bricht einen Auftrag ab. Der Anbieter wird nach Möglichkeit ebenfalls gestoppt; ein schon begonnener Auftrag kann beim Anbieter trotzdem abgerechnet werden. |
| `plur1bus media outputs` | Zeigt deine gespeicherten Bilder. Mit `--adapter` filterst du nach Anbieter. |
| `plur1bus media output <ausgabe-id> --out bild.png` | Lädt ein gespeichertes Bild in eine Datei. |
| `plur1bus media rm <ausgabe-id>` | Löscht ein gespeichertes Bild. Der Auftrag bleibt in der Historie erhalten. |

Ein Auftrag durchläuft die Zustände `queued`, `running` und endet in `succeeded`, `failed` oder `cancelled`.

## Kosten und Grenzen

- Cloud-Anbieter berechnen ihre Bilder selbst. Plur1bus schätzt die Kosten nur; nur OpenRouter meldet tatsächliche Kosten.
- Ist das Budget erschöpft, schickt Plur1bus den Auftrag gar nicht erst an den Anbieter.
- Referenz- und Maskenbilder werden vor dem Versand von Metadaten befreit, etwa Standort aus EXIF.
- Lehnt ein Anbieter einen Auftrag inhaltlich ab, wird er nicht über einen anderen Anbieter umgangen und nicht automatisch
  wiederholt.

## Wenn etwas nicht klappt

Fehler eines Auftrags stehen in `plur1bus media job <auftrags-id>` als Fehlercode. Die häufigsten:

| Fehlercode | Bedeutung | Was tun |
|---|---|---|
| `backend_unavailable`, Grund `auth_invalid` oder `auth_forbidden` | Der Anbieter hat den Schlüssel abgelehnt. | Den Geheimnis-Namen des Adapters prüfen und den Schlüssel erneuern. |
| `backend_unavailable` (ohne Grund) | Der Anbieter ist gerade nicht erreichbar. | Später erneut versuchen. |
| `content_policy` | Der Anbieter hat den Inhalt abgelehnt. | Prompt ändern; es gibt keine automatische Wiederholung. |
| `quota` | Kontingent oder Budget ist erschöpft. | Kontingent des Anbieters oder das Budget prüfen. |
| `too_large` | Eine Referenz ist zu groß. Die Übertragung ist auf 16 MiB begrenzt. | Kleinere Datei verwenden. |
| `unsupported_parameter` | Der Adapter kann Größe oder Parameter nicht. | Andere Größe oder anderen Adapter wählen. |
| `timeout` | Der Anbieter hat nicht rechtzeitig geantwortet. | Den Auftrag abfragen; er bleibt abrufbar. |
| `interrupted` | Der Auftrag wurde unterbrochen, bevor das Ergebnis gespeichert war. | Plur1bus schickt den Auftrag nicht erneut ab. Starte einen neuen. |

Läuft der Core nicht, meldet jeder Befehl `E_CORE_UNAVAILABLE`. Starte ihn dann mit `plur1bus daemon start`.
