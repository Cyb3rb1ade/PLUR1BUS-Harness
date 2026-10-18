# Datenschutz und Modus „Nur lokal“

Mit dem Schalter „Nur lokal“ (`privacy.localOnly`) verlässt keine Modellanfrage, kein Embedding und kein Reranker-Aufruf deinen Rechner, solange der Endpunkt nicht lokal ist. Die englische Version dieser Seite ist [../en/privacy.md](../en/privacy.md).

> **Verfügbarkeit:** „Nur lokal“ ist ab der nächsten Version verfügbar. Frühere Versionen kennen `privacy.localOnly`, `privacy.localEndpoints` und `agents.<id>.privacy.localOnly` nicht.

## So geht's

### Web-UI

1. Öffne **Einstellungen → Datenschutz** (`#/settings/privacy`).
2. Schalte **privacy.localOnly** („Nur lokal“) ein.
3. Um einen eigenen Modellserver außerhalb dieses Rechners freizugeben, trage seinen Origin unter **privacy.localEndpoints** ein (zum Beispiel `http://100.64.0.10:8080`): Schema, Host und optional Port, ohne Pfad.
4. Wähle **Änderungen prüfen**, kontrolliere die Differenz und speichere. Beide Schlüssel starten den Core neu. Nur Owner und Admins dürfen sie ändern.

### CLI

Aktuelle Einstellung abfragen:

```sh
plur1bus config get privacy.localOnly
```

Modus „Nur lokal“ aktivieren:

```sh
plur1bus config set privacy.localOnly true
```

Eigenen Modellserver im Heimnetz freigeben:

```sh
plur1bus config set privacy.localEndpoints '["http://100.64.0.10:8080"]'
plur1bus config get privacy.localEndpoints
```

### Pro Agent

Ein Agent kann den Wert der Installation in beide Richtungen überschreiben. Setze ihn für einen einzelnen Agenten (in der Web-UI gibt es dafür keinen Schalter):

```sh
plur1bus config set agents.<id>.privacy.localOnly true
```

Ein nicht gesetzter Wert erbt `privacy.localOnly`; `false` hebt die Einschränkung nur für diesen Agenten auf.

## Gut zu wissen

- **Was als lokal gilt:** ein Endpunkt auf Loopback (`localhost`, `127.0.0.0/8`, `::1`) oder genau einer der Origins in `privacy.localEndpoints`. Eine LAN-Adresse ist nie von sich aus lokal, und ein Name wird für die Entscheidung nicht aufgelöst.
- **Was erfasst wird:** Chat- und Rollenmodelle (auch die Zusammenfassungen, die lange Gespräche verdichten), Embeddings, der Reranker, die Modellfunktionen der Memory-Engine, Sprache (nur lokale Modelle), Bildbeschreibungen, der Medienindex und die Mediengenerierung. Die Modellsuche listet Cloud-Modelle weiterhin, markiert als „nur lokal: gesperrt“.
- **Kein stiller Fallback:** Ein abgelehntes Modell wird nie durch ein anderes ersetzt. Die Anfrage schlägt fehl und nennt den Grund.
- **Web-Tools sind nicht betroffen:** `web.fetch` und `web.search` sind keine Modellaufrufe. Werkzeug-Berechtigungen, Freigaben ([freigaben.md](freigaben.md)) und die Egress-Regeln steuern sie, nicht `privacy.localOnly`.
- **Gemeinsame Memory-Engine und Medienindex:** Alle Agenten schreiben hinein, deshalb bleiben beide lokal, solange die Installation oder irgendein Agent „Nur lokal“ hat. Ein Agent, der den Schalter für sich aufhebt, öffnet sie nie für ein Cloud-Modell.
- **Egress gilt zusätzlich:** Ein lokaler Endpunkt muss auch die Regeln unter `egress.*` bestehen; Loopback braucht `egress.allowLoopback`.
- **Doctor:** Die Prüfung `privacy.local-only` schlägt fehl, solange der Schalter an ist und noch ein Cloud-Modell konfiguriert ist, und listet auf, was abgelehnt wird.

## Fehlermeldungen

Ablehnungen nutzen die geschlossenen Fehlercodes; der `reason` nennt die angewandte Regel.

- `E_DENIED` mit reason `local-only`: Der Modell-, Embedding- oder Reranker-Endpunkt ist nicht lokal, während „Nur lokal“ gilt. Wähle ein lokales Modell, trage deinen eigenen Server in `privacy.localEndpoints` ein oder schalte den Schalter aus.
- `E_DENIED` mit reason `egress-denied`: Die Egress-Regeln haben beim Start einen Endpunkt der Memory-Engine abgelehnt (zum Beispiel einen entfernten Embedding-Host). Trage den Host in `egress.allowHosts` ein; Loopback braucht zusätzlich `egress.allowLoopback`.

## Weiter

- Modell-Anbieter konfigurieren: [providers.md](providers.md)
- Cloud-Embeddings einrichten: [cloud-embeddings.md](cloud-embeddings.md)
- Secrets und Schlüssel verwalten: [secrets.md](secrets.md)
