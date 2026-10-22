# Cloud-Embeddings und Cloud-Reranker

Plur1bus kann statt der lokalen Modelle ein gehostetes Embedding-Modell und den Cohere-Reranker nutzen. Kein Anbieter wird bevorzugt, und ein ausfallender Dienst wird nie stillschweigend durch ein lokales Modell ersetzt. Die englische Version dieser Seite ist [../en/cloud-embeddings.md](../en/cloud-embeddings.md).

Dafür gibt es noch keine Web-UI. Du stellst es in der Konfiguration ein, unter den Schlüsseln `engine.embedding` und `engine.reranker`, per CLI oder in der `config.json`.

## So geht's

### Was unterstützt wird

- **Embeddings:** jeder Anbieter mit OpenAI-kompatiblem Embedding-Endpunkt: OpenAI (`openai`), OpenRouter (`openrouter`), die Kompatibilitäts-API von Cohere (`cohere`), Jina (`jina`), der OpenAI-Endpunkt von Gemini und dein eigener Server (vLLM, Ollama, Text Embeddings Inference). Die Anbieter-ID ist eine frei gewählte Bezeichnung; Endpunkt und Modell entscheiden.
- **Reranker:** nur Cohere (`cohere`). Andere Anbieter werden abgelehnt und nicht durch ein anderes Modell ersetzt.

### CLI

1. Lege den API-Schlüssel in einer Umgebungsvariable des Core-Prozesses ab, zum Beispiel `OPENAI_API_KEY`. In der Konfiguration steht immer nur der **Name** der Variable (`apiKeyEnv`). Der Secret Store ist noch nicht mit der Memory-Engine verbunden; ein mit `plur1bus secret set` gespeicherter Schlüssel erreicht sie daher nicht.

2. Trage die Datenschutzbestätigung für den Anbieter ein, hier für OpenAI. Sie ist ein Objekt mit Anbieter, Zeitstempel und der bestätigenden Person; beim Speichern wird die angemeldete Person als `by` eingetragen. Bei einem Anbieter mit eigener `baseUrl` ergänze `"endpoint"` mit genau dieser Adresse.

```sh
plur1bus config set memory.embedding.privacyAck '{"provider":"openai","acknowledgedAt":"<ISO-8601 date-time>","by":"<your person id>"}'
```

3. Konfiguriere das Embedding-Modell. `provider`, `model`, `dimensions` (die Vektorgröße dieses Modells) und `apiKeyEnv` sind Pflicht; `baseUrl` ist für jeden Anbieter außer `openai` Pflicht.

```sh
plur1bus config set engine.embedding '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"apiKeyEnv":"OPENAI_API_KEY"}'
```

4. Optional der Cohere-Reranker. Er erhält die abgerufenen Erinnerungstexte.

```sh
plur1bus config set engine.reranker '{"provider":"cohere","apiKeyEnv":"COHERE_API_KEY"}'
```

5. Prüfe das Ergebnis:

```sh
plur1bus config get engine.embedding
```

Ein bestehender Gedächtnis-Store ist an das Modell gebunden, das ihn aufgebaut hat. Ändere `engine.embedding` dafür nicht von Hand; überführe ihn mit [reembed.md](reembed.md).

## Gut zu wissen

- **Datenschutzbestätigung ist Pflicht:** Jeder Embedding-Endpunkt außerhalb von Loopback (`localhost`, `127.0.0.0/8`, `::1`) braucht `memory.embedding.privacyAck` für genau diesen Anbieter und Endpunkt. Ein Wechsel von Anbieter oder Adresse macht eine alte Bestätigung ungültig. Ab der nächsten Version braucht der Reranker eine eigene `memory.reranker.privacyAck`, gebunden an den Anbieter.
- **Schlüssel gehören nie in die Konfiguration:** Ein Klartext-`apiKey` oder eine `baseUrl` mit Benutzername oder Passwort wird abgelehnt. Nutze `apiKeyEnv`. Auch die Schreibweise `baseURL` wird abgelehnt, weil die Engine sie ignorieren und ihren Standard-Endpunkt aufrufen würde.
- **Kein stiller Fallback:** Ein `fallback`-Modell wird abgelehnt. Ist der gehostete Dienst nicht erreichbar, melden Indexierung und Abruf den Fehler; sie wechseln nie auf ein anderes Modell oder einen anderen Vektorraum, was die Suchergebnisse verfälschen würde.
- **Nur lokale Modelle:** Ab der nächsten Version lehnt `privacy.localOnly` einen Cloud-Embedding- oder Reranker-Endpunkt ab ([datenschutz.md](datenschutz.md)).

## Fehlermeldungen

- `E_DENIED` mit reason `privacy-acknowledgment-required`: Der Endpunkt liegt außerhalb von Loopback, und `memory.embedding.privacyAck` fehlt. Die reasons `privacy-acknowledgment-invalid` (unvollständiger Eintrag) und `privacy-acknowledgment-mismatch` (nennt einen anderen Anbieter oder Endpunkt) bedeuten dasselbe: Trage die Bestätigung für den verwendeten Anbieter neu ein.
- `E_INVALID_PARAMS` mit reason `engine-provider-config-incomplete`: `model`, `dimensions`, `apiKeyEnv` oder, außer bei `openai`, `baseUrl` fehlt. Der reason `engine-provider-invalid` heißt, dass die Anbieter-ID fehlerhaft ist.
- `E_INVALID_PARAMS` mit reason `secret-in-config`: ein Klartext-Schlüssel oder Zugangsdaten in `baseUrl`. Entferne sie und nenne in `apiKeyEnv` eine Umgebungsvariable.
- `E_INVALID_PARAMS` mit reason `embedding-fallback-refused`: Entferne `fallback`; Modelle wechselst du mit `memory reembed`.
- `E_NOT_AVAILABLE` mit reason `engine-adapter-factory-unavailable`: Für den Reranker-Anbieter gibt es noch keinen Adapter; nur `cohere` funktioniert.
- `E_DENIED` mit reason `local-only` oder `egress-denied`: siehe [datenschutz.md](datenschutz.md) (ab der nächsten Version).

## Weiter

- Bestehenden Store auf ein neues Embedding-Modell überführen: [reembed.md](reembed.md)
- Datenschutz und „Nur lokale Modelle“: [datenschutz.md](datenschutz.md)
- Modell-Anbieter und Profile konfigurieren: [providers.md](providers.md)
