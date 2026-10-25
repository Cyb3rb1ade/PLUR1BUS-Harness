# Embedding-Modell wechseln (memory reembed)

Wenn du das Embedding-Modell wechselst, muss der Gedächtnis-Store in den neuen Vektorraum überführt werden. `plur1bus memory reembed` tut das ohne gemischten Vektorraum: Es baut neben der alten eine neue Generation von Vektoren auf und schaltet erst nach einer Prüfung um. Die englische Version dieser Seite ist [../en/reembed.md](../en/reembed.md).

> **Verfügbarkeit:** Die Migration ist experimentell. Der Wechsel auf ein **lokales** Modell funktioniert wie unten beschrieben. Der Wechsel zu oder zwischen **Cloud**-Modellen (`--provider`, `--base-url`, `--api-key-env`, `--acknowledge-privacy`) ist ab der nächsten Version verfügbar.
>
> Vor der Umschaltung prüft die Memory-Engine die neue Generation: Sie ruft eine deiner Erinnerungen mit dem neuen Modell aus der Kopie ab. Schlägt die Prüfung fehl, hält der Lauf mit dem Grund der Engine an und schaltet nie um; der alte Store bleibt aktiv.

## So geht's

Dafür gibt es keine Web-UI. Nutze die CLI.

1. Migration planen. Das kopiert nichts und zeigt ein Urteil, die Zahl der Zeilen und Stapel, den nötigen Speicherplatz und die Mindestdauer. Das Urteil `incompatible` endet mit Exit-Code 1 und nennt die Gründe.

```sh
plur1bus memory reembed --plan --model <MODEL> --dimensions <N>
```

`--model` ist ein festgelegtes lokales Embedding-Modell, unter der eigenen Id der Gedächtnis-Engine: `google/embeddinggemma-2` (EmbeddingGemma 2), `intfloat/multilingual-e5-small`, `jinaai/jina-embeddings-v5-text-nano-retrieval` oder `jinaai/jina-embeddings-v3`. `--dimensions` brauchst du nur, wenn das Modell mehr als eine Größe unterstützt.

Planst du dasselbe Modell noch einmal (zum Beispiel nach einem Probelauf), zeigt der Befehl denselben Plan; nichts wird doppelt geplant. Ein Plan für ein anderes Modell wird abgelehnt, solange der erste nicht ausgeführt wurde, eine Stunde lang nach dem Planen: Die Meldung nennt die Uhrzeit. `--abort` gibt ihn nicht früher frei; danach ersetzt ihn der neue Plan.

Ein Gedächtnis ohne Daten braucht keine Migration: Wähle das Modell stattdessen im Einrichtungsassistenten ([erinnerungen.md](erinnerungen.md#embedding-modell-und-reranker)).

2. Ausführen. Der Befehl fragt nach Bestätigung (`--yes` außerhalb eines Terminals), startet die Migration im Core und verfolgt den Fortschritt. `--no-wait` kehrt nach dem Start zurück, `--no-switch` kopiert und prüft, schaltet aber nicht um, `--throttle-ms` legt die Pause zwischen den Stapeln fest (Standard 250).

```sh
plur1bus memory reembed --run
```

3. Phase und Fortschritt abfragen:

```sh
plur1bus memory reembed --status
```

4. An der nächsten Stapelgrenze anhalten:

```sh
plur1bus memory reembed --abort
```

Ein erneuter Aufruf von `plur1bus memory reembed --run` setzt dieselbe Migration fort; ein angehaltener Lauf (Engine-Fehler, Core-Stopp) wird genauso fortgesetzt.

## Mit config set

Setzt du bei einem Gedächtnis mit Daten mit `plur1bus config set` ein anderes Embedding-Modell, startet dieselbe Migration, ohne dass du sie selbst planen musst:

```sh
plur1bus config set engine.embedding.local.model google/embeddinggemma-2
```

Der Befehl schreibt den Wert nicht. Er zeigt den Umzug und den Plan, fragt nach einer Bestätigung (`--yes` außerhalb eines Terminals) und lässt das Re-Embedding im Vordergrund mit Fortschritt laufen; die Umschaltung am Ende schreibt das neue Embedding. Strg-C lässt die Migration im Core weiterlaufen. Mit `--background` kehrt der Befehl direkt nach dem Start zurück, damit du mit weiteren Schritten weitermachen kannst; die Migration schaltet von selbst um, sobald die Kopie fertig ist, und `plur1bus memory reembed --status` verfolgt sie. `--dry-run` plant nur. Ändere das Embedding allein: Ein `config set`, das daneben weitere Engine-Schlüssel setzt, wird abgelehnt, bevor etwas geplant wird. Kehrt der Befehl im Vordergrund zurück, nutzt das Gedächtnis das neue Modell: Der Core startet auf der neuen Generation neu und der Abruf antwortet aus ihr.

Eine Änderung, die den Vektorraum behält, oder eine bei einem Gedächtnis ohne Daten wird wie gewohnt geschrieben. Ein Modell, das die Gedächtnis-Engine nicht laden kann, wird abgelehnt, bevor etwas geschrieben wird. Ohne laufenden Core wird die Änderung mit einer Warnung geschrieben, dass sie nicht geprüft werden konnte.

## Gut zu wissen

- **Pro Installation:** Die Migration kopiert das Gedächtnis aller Agenten in eine neue Generation. Eine Option pro Agent gibt es nicht.
- **Die alte Generation bleibt aktiv:** Der Abruf wird von der alten Generation beantwortet, bis die Konfiguration nach der Prüfung in einem Schritt ersetzt wird. Die alte Generation bleibt auf der Platte.
- **Phasen:** `planned`, `running`, `validating`, `ready-to-switch`, `switched`; dazu `aborted` (angehalten, fortsetzbar) und `failed` (endgültig, neu planen).
- **Immer nur ein Vorgang:** Solange ein Plan, Lauf oder eine Umschaltung läuft, wird ein weiterer abgelehnt.
- **Cloud-Ziele (ab der nächsten Version):** Alle Richtungen funktionieren: lokal zu Cloud, Cloud zu lokal, Cloud zu Cloud. Der Plan zeigt, dass alle Kartentexte an den Anbieter gehen, und nennt die geschätzten Tokens (keine Kosten). Das Ziel braucht die Datenschutzbestätigung (`memory.embedding.privacyAck` oder `--acknowledge-privacy` beim Planen); „Nur lokale Modelle“ lehnt ein Cloud-Ziel ab; der Endpunkt muss die Egress-Regeln bestehen ([datenschutz.md](datenschutz.md)). Schlüssel gibst du als Name einer Umgebungsvariable an, nie als Wert ([cloud-embeddings.md](cloud-embeddings.md)).
- **Budget-Stopp (Cloud-Ziele):** Vor jedem Stapel werden die geschätzten Tokens im Aufrufbudget `memory-reembed` reserviert. Ein hartes Limit hält den Lauf in der Phase `aborted` mit dem Fehler `budget-exceeded` an; `--run` macht weiter, sobald das Budget es erlaubt ([budgets.md](budgets.md)). Ein Ratenlimit oder ein vorübergehender Anbieterfehler wird mit wachsenden Pausen wiederholt, bevor der Lauf anhält.
- **Kein stiller Fallback:** Vektoren verschiedener Modelle werden nie gemischt. Der Abruf nutzt nur die aktive, geprüfte Generation.

## Fehlermeldungen

Die Migration meldet die geschlossenen Fehlercodes; der `reason` sagt, was zutraf.

- `E_CONFLICT` mit reason `migration-active` oder `migration-running`: Ein anderer Plan, Lauf oder eine Umschaltung läuft. Sieh mit `--status` nach oder stoppe sie mit `--abort`. Nennt die Meldung eine Uhrzeit, hält ein Plan für ein anderes Modell (oder ein Lauf, der anhielt, weil sich das Gedächtnis währenddessen geändert hat) die Engine bis dahin: Führe den geplanten mit `--run` aus oder plane nach dieser Zeit neu.
- `E_CONFLICT` mit reason `not-runnable`, `not-abortable` oder `not-ready-to-switch`: Der Aufruf passt nicht zur aktuellen Phase.
- `E_NOT_FOUND` mit reason `no-migration`: `--run` oder `--abort` ohne Plan. Plane zuerst.
- `E_INVALID_PARAMS` mit reason `plan-refused`: Die Engine hat den Plan abgelehnt, zum Beispiel wegen zu wenig freiem Speicherplatz.
- `E_NOT_AVAILABLE` mit reason `switch-unavailable`: Es wurde nichts geschrieben, die alte Konfiguration bleibt aktiv (kein Supervisor oder ein Ziel, mit dem die Engine nicht starten würde).
- `E_STORAGE` mit reason `switch-failed`, `state-corrupt` oder `state-unreadable`: Die Konfiguration konnte nicht geschrieben werden oder die Checkpoint-Datei ist unbrauchbar.
- Ab der nächsten Version bei Cloud-Zielen: `E_DENIED` mit reason `privacy-acknowledgment-required`, `local-only` oder `egress-denied` sowie `E_INVALID_PARAMS` mit reason `engine-provider-config-incomplete`.

## Weiter

- Cloud-Embeddings und Reranker: [cloud-embeddings.md](cloud-embeddings.md)
- Budgets einrichten: [budgets.md](budgets.md)
- Wartung und Betrieb: [Betriebshandbuch](operations.md)
