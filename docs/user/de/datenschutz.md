# Datenschutz und Modus „Nur lokal“

Plur1bus bietet mit dem Schalter „Nur lokal“ (`privacy.localOnly`) eine strikte Datenschutz-Einstellung, die garantiert, dass keine Modellanfragen, Embeddings oder Denkdaten ohne ausdrückliche Freigabe den eigenen Rechner verlassen. Die englische Version dieser Seite ist [../en/privacy.md](../en/privacy.md).

## So geht's

### Web-UI

1. Öffne die **Einstellungen** (`#/settings/security` oder `#/settings/general`).
2. Scrolle zur Karte **Datenschutz & Netzwerk**.
3. Schalte den Regler **Nur lokal** auf **Aktiviert**.
4. Um einen selbst gehosteten Server im Heimnetz freizugeben, trage dessen Adresse unter **Lokale Endpunkte** ein (zum Beispiel `http://100.64.0.10:8080`).
5. Klicke auf **Änderungen speichern**.

### CLI

Aktuelle Einstellung abfragen:

```sh
plur1bus config get privacy.localOnly
```

Modus „Nur lokal“ aktivieren:

```sh
plur1bus config set privacy.localOnly true
```

Eigene Heimserver und LAN-Endpunkte freigeben:

```sh
plur1bus config set privacy.localEndpoints '["http://100.64.0.10:8080"]'
plur1bus config get privacy.localEndpoints
```

### Einstellung pro Agent

Du kannst „Nur lokal“ auch gezielt für einzelne Agenten erzwingen, selbst wenn der globale Schalter deaktiviert ist:

- In der `config.json` unter `agents.<id>` den Wert `"privacy": { "localOnly": true }` eintragen.
- In der Web-UI: Gehe zu **Agenten** (`#/agents/<id>`), wähle **Bearbeiten** und aktiviere die Option **Nur lokale Modelle erlauben**.

## Gut zu wissen

- **Was gesperrt wird:** Jeder Modellaufruf, der den Rechner verlässt, wird blockiert. Das betrifft Chat-Modelle, Cloud-Embeddings, Cloud-Reranker, Textkompaktierung, Sprachausgabe/-transkription und automatische Reasoning-Aufrufe.
- **Was nicht gesperrt wird (Web-Tools):** Web-Tools wie Browser-Steuerung, Web-Recherche oder HTTP-Abfragen sind operative Werkzeuge, keine Modellaufrufe. Sie unterliegen den Werkzeug-Berechtigungen und Freigaben ([freigaben.md](freigaben.md)), nicht dem Modell-Egress-Filter.
- **Auswirkung auf die gemeinsame Engine:** Hat ein Agent „Nur lokal“ aktiv, verweigert die gemeinsame Memory-Engine für diesen Agenten jegliche Nutzung von Cloud-Embeddings oder Cloud-Rerankern.
- **Heimserver und Rebinding-Schutz:** `privacy.localEndpoints` erlaubt Adressen im lokalen Netzwerk (wie Ollama oder LocalAI im LAN). Die Egress-Prüfung verhindert DNS-Rebinding und Umgehungsversuche über Loopback-Aliase; nur explizit gelistete Adressen sind zugelassen.

## Fehlermeldungen

- `E_MODEL_FORBIDDEN_LOCAL_ONLY` (oder `E_LOCAL_ONLY`): Der Modell- oder Embedding-Aufruf wurde blockiert, weil „Nur lokal“ aktiv ist und das Ziel ein externer Cloud-Anbieter ist. Wähle ein lokales Modell oder deaktiviere den Modus.
- `E_EGRESS_BLOCKED`: Die ausgehende Netzwerkverbindung wurde blockiert, da die Zieladresse nicht in `privacy.localEndpoints` aufgeführt ist.

## Weiter

- Modell-Anbieter konfigurieren: [providers.md](providers.md)
- Cloud-Embeddings einrichten: [cloud-embeddings.md](cloud-embeddings.md)
- Secrets und Schlüssel verwalten: [secrets.md](secrets.md)
