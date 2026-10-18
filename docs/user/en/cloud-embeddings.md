# Cloud embeddings and rerankers

Plur1bus provides full support for cloud-hosted embedding and reranker models alongside local models, without favoring any specific provider. The German version of this page is [../de/cloud-embeddings.md](../de/cloud-embeddings.md).

## How to ("So geht's")

### Supported providers

- **OpenAI:** `openai` (`text-embedding-3-small`, `text-embedding-3-large`).
- **OpenRouter:** `openrouter` (e.g. Qwen embeddings `qwen/qwen-2.5-coder`).
- **Cohere:** `cohere` (`embed-multilingual-v3.0`, `rerank-v3.5`).
- **Jina:** `jina` (`jina-embeddings-v3`, `jina-reranker-v2-base-multilingual`).
- **Voyage:** `voyage` (`voyage-3`, `voyage-multilingual-2`, `rerank-2`).
- **Self-hosted / Custom:** Any OpenAI-compatible server (vLLM, Ollama, Text Embeddings Inference) hosted on a remote server.

### Web UI

1. Open **Settings → Memory** (`#/settings/memory`).
2. Under **Embedding Model**, choose your provider and model name.
3. Select your API key reference under **API Key Secret** (`apiKeyRef`).
4. When selecting an external provider, a confirmation box appears. Check **I acknowledge that embedding requests leave localhost** (`privacyAck`).
5. Choose **Save changes**.

### CLI

1. Store the provider API key in the secret store:

```sh
printf %s "$OPENAI_API_KEY" | plur1bus secret set openai/api-key
```

2. Configure the embedding provider and model:

```sh
plur1bus config set memory.embedding.provider openai
```

3. Confirm privacy acknowledgement for cloud endpoints:

```sh
plur1bus config set memory.embedding.privacyAck true
plur1bus config set memory.reranker.privacyAck true
```

4. Verify your memory configuration:

```sh
plur1bus config get memory.embedding
```

## Good to know ("Gut zu wissen")

- **Privacy confirmation is required:** Any embedding or reranker endpoint outside `localhost` or `127.0.0.1` requires explicit confirmation (`privacyAck: true`). If this confirmation is missing, requests are rejected.
- **Secrets vs Config:** Never put plaintext API keys into `config.json`. Use `apiKeyRef` to reference a secret in the secret store, or `apiKeyEnv` to reference an environment variable. Configuration files containing plaintext keys fail schema validation.
- **No silent fallback:** If your cloud embedding or reranker service is unavailable, Plur1bus reports the error and halts memory indexing. It never silently falls back to a different model or vector space, which would corrupt semantic search results.

## Error messages ("Fehlermeldungen")

- `E_PRIVACY_ACK_REQUIRED`: The configured embedding or reranker endpoint is located outside localhost, but privacy acknowledgement (`memory.embedding.privacyAck` or `memory.reranker.privacyAck`) is missing or false.
- `E_SECRET_NOT_FOUND`: The secret name specified in `apiKeyRef` does not exist in the secret store. Add it with `plur1bus secret set <NAME>`.
- `E_KEY_IN_CONFIG`: A plaintext API key was found directly in the configuration. Remove the key and reference it via `apiKeyRef` instead.

## Next

- Migrate an existing store to a new embedding model: [reembed.md](reembed.md)
- Manage secret keys securely: [secrets.md](secrets.md)
- Configure model providers and profiles: [providers.md](providers.md)
