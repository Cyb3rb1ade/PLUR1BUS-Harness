# Embedding-Modell wechseln (memory reembed)

Wenn du das Embedding-Modell wechselst, müssen bestehende Erinnerungskarten in den neuen Vektorraum überführt werden. Plur1bus unterstützt die Migration in alle Richtungen: lokal↔Cloud, Cloud→Cloud und lokal↔lokal. Die englische Version dieser Seite ist [../en/reembed.md](../en/reembed.md).

## So geht's

### Web-UI

1. Öffne **Erinnerungen & Träume** (`#/memories`).
2. Klicke im Bereich **Store & Embeddings** auf **Embedding-Modell wechseln**.
3. Wähle das Zielmodell und die gewünschte Vektordimension.
4. Klicke auf **Migration planen**: Die Vorschau zeigt Kartenzahl, geschätzte Tokens und Dimensionsänderungen, ohne Daten zu ändern.
5. Klicke auf **Migration starten**: Die Übertragung läuft in gedrosselten Stapeln. Ein Fortschrittsbalken zeigt den Status.
6. Du kannst den Lauf jederzeit pausieren; der alte Store bleibt aktiv, bis die Migration vollständig abgeschlossen ist.

### CLI

1. Migration planen (Probelauf):

```sh
plur1bus memory reembed --plan --model <MODEL>
```

2. Migration ausführen:

```sh
plur1bus memory reembed --run
```

3. Status und Fortschritt abfragen:

```sh
plur1bus memory reembed --status
```

4. Laufende Migration sicher anhalten oder abbrechen:

```sh
plur1bus memory reembed --abort
```

Ein erneuter Aufruf von `plur1bus memory reembed --run` setzt die Migration an der letzten Stapelgrenze fort.

## Gut zu wissen

- **Alle Richtungen möglich:** Migrationen funktionieren zwischen lokalen Modellen (z. B. `bge-small-en-v1.5`), zu Cloud-Modellen (`text-embedding-3-small`), zwischen verschiedenen Cloud-Anbietern oder wieder zurück zu lokalen Modellen.
- **Alte Generation bleibt aktiv:** Die Migration erzeugt eine neue Generation im Hintergrund. Während `reembed --run` arbeitet, beantwortet die alte Generation weiterhin Suchanfragen. Die Umschaltung erfolgt erst, wenn alle Karten erfolgreich geprüft wurden.
- **Budget-Stopp:** Erreicht eine Cloud-Migration ein Budget- oder Kontingentlimit, stoppt der Lauf sauber an der nächsten Stapelgrenze, ohne Datenverlust.
- **Kein stiller Fallback:** Plur1bus mischt niemals Vektoren verschiedener Modelle. Suchanfragen greifen immer nur auf eine einheitliche, geprüfte Generation zu.

## Fehlermeldungen

- `E_STORE_INCOMPATIBLE`: Die Vektordimension oder der Modell-Fingerprint des Stores passt nicht zur aktiven Konfiguration. Starte mit `plur1bus memory reembed --plan`.
- `E_BUDGET_EXCEEDED`: Die Migration wurde angehalten, da das gesetzte Token- oder Kostenlimit erreicht wurde.
- `E_MIGRATION_IN_PROGRESS`: Es läuft bereits eine Migration. Prüfe den Status mit `--status` oder brich sie mit `--abort` ab.

## Weiter

- Cloud-Embeddings und Reranker: [cloud-embeddings.md](cloud-embeddings.md)
- Budgets einrichten: [budgets.md](budgets.md)
- Wartung und Betrieb: [Betriebshandbuch](operations.md)
