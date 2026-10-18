# Cloud-Embeddings und Cloud-Reranker

Plur1bus unterstützt Cloud-basierte Embedding- und Reranker-Modelle vollwertig neben lokalen Modellen. Kein Anbieter wird bevorzugt. Die englische Version dieser Seite ist [../en/cloud-embeddings.md](../en/cloud-embeddings.md).

## So geht's

### Unterstützte Anbieter

- **OpenAI:** `openai` (`text-embedding-3-small`, `text-embedding-3-large`).
- **OpenRouter:** `openrouter` (z. B. Qwen-Embeddings `qwen/qwen-2.5-coder`).
- **Cohere:** `cohere` (`embed-multilingual-v3.0`, `rerank-v3.5`).
- **Jina:** `jina` (`jina-embeddings-v3`, `jina-reranker-v2-base-multilingual`).
- **Voyage:** `voyage` (`voyage-3`, `voyage-multilingual-2`, `rerank-2`).
- **Selbst gehostet:** Jeder OpenAI-kompatible Server (vLLM, Ollama, Text Embeddings Inference) auf einem Remote-Rechner.

### Web-UI

1. Öffne die **Einstellungen → Memory** (`#/settings/memory`).
2. Wähle unter **Embedding-Modell** den gewünschten Anbieter und Modellnamen.
3. Wähle die Secret-Referenz deines Schlüssels unter **API-Key-Secret** (`apiKeyRef`).
4. Bei externen Anbietern erscheint ein Bestätigungshinweis. Setze das Häkchen bei **Ich bestätige, dass Embedding-Anfragen localhost verlassen** (`privacyAck`).
5. Klicke auf **Änderungen speichern**.

### CLI

1. Speichere den API-Schlüssel sicher im Secret Store:

```sh
printf %s "$OPENAI_API_KEY" | plur1bus secret set openai/api-key
```

2. Konfiguriere den Embedding-Provider:

```sh
plur1bus config set memory.embedding.provider openai
```

3. Bestätige die Datenschutzbestätigung für Endpunkte außerhalb von localhost:

```sh
plur1bus config set memory.embedding.privacyAck true
plur1bus config set memory.reranker.privacyAck true
```

4. Prüfe die aktuelle Konfiguration:

```sh
plur1bus config get memory.embedding
```

## Gut zu wissen

- **Datenschutzbestätigung ist Pflicht:** Jeder Endpunkt außerhalb von `localhost` oder `127.0.0.1` verlangt eine ausdrückliche Bestätigung (`privacyAck: true`). Fehlt dieser Eintrag, werden alle Anfragen abgewiesen.
- **Secrets statt Config:** Schreibe niemals Klartext-Schlüssel in die `config.json`. Verwende immer `apiKeyRef` (Verweis auf einen Secret-Namen) oder `apiKeyEnv` (Verweis auf eine Umgebungsvariable). Dateien mit Klartext-Schlüsseln scheitern bei der Validierung.
- **Kein stiller Fallback:** Fällt der konfigurierte Cloud-Dienst aus oder ist das Guthaben aufgebraucht, bricht Plur1bus mit einem klaren Fehler ab. Es gibt keinen stillen Wechsel auf ein lokales Modell oder einen anderen Vektorraum, da dies die Suchergebnisse verfälschen würde.

## Fehlermeldungen

- `E_PRIVACY_ACK_REQUIRED`: Der konfigurierte Embedding- oder Reranker-Endpunkt liegt außerhalb von localhost, aber die Datenschutzbestätigung (`memory.embedding.privacyAck` bzw. `memory.reranker.privacyAck`) fehlt oder steht auf false.
- `E_SECRET_NOT_FOUND`: Das in `apiKeyRef` angegebene Secret existiert nicht im Secret Store. Lege es mit `plur1bus secret set <NAME>` an.
- `E_KEY_IN_CONFIG`: Ein Klartext-Schlüssel wurde direkt in der Konfiguration gefunden. Entferne ihn und referenziere ihn über `apiKeyRef`.

## Weiter

- Bestehenden Store migrieren: [reembed.md](reembed.md)
- Secrets sicher verwalten: [secrets.md](secrets.md)
- Modell-Anbieter konfigurieren: [providers.md](providers.md)
