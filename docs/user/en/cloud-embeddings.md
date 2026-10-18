# Cloud embeddings and rerankers

Plur1bus can use a hosted embedding model, and the Cohere reranker, instead of the local models. No provider is preferred, and a failing service is never silently replaced by a local model. The German version of this page is [../de/cloud-embeddings.md](../de/cloud-embeddings.md).

There is no web UI for this yet. You set it in the configuration, under the keys `engine.embedding` and `engine.reranker`, with the CLI or in `config.json`.

## How to

### What is supported

- **Embeddings:** any provider with an OpenAI-compatible embeddings endpoint: OpenAI (`openai`), OpenRouter (`openrouter`), Cohere's compatibility API (`cohere`), Jina (`jina`), Gemini's OpenAI endpoint, and your own server (vLLM, Ollama, Text Embeddings Inference). The provider id is a label you choose; the endpoint and model decide.
- **Reranker:** only Cohere (`cohere`). Other providers are refused, not replaced by another model.

### CLI

1. Put the API key in an environment variable of the core process, for example `OPENAI_API_KEY`. The configuration only ever holds the variable's **name** (`apiKeyEnv`). The secret store is not connected to the memory engine yet, so a key stored with `plur1bus secret set` does not reach it.

2. Record the privacy confirmation for the provider, for example for OpenAI. It is an object with the provider, a time stamp and the person who confirmed; the signed-in person is entered as `by` when you save. For a provider with its own `baseUrl`, add `"endpoint"` with exactly that address.

```sh
plur1bus config set memory.embedding.privacyAck '{"provider":"openai","acknowledgedAt":"<ISO-8601 date-time>","by":"<your person id>"}'
```

3. Configure the embedding model. `provider`, `model`, `dimensions` (the vector size of that model) and `apiKeyEnv` are required; `baseUrl` is required for every provider except `openai`.

```sh
plur1bus config set engine.embedding '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"apiKeyEnv":"OPENAI_API_KEY"}'
```

4. Optional, the Cohere reranker. It receives the recalled memory texts.

```sh
plur1bus config set engine.reranker '{"provider":"cohere","apiKeyEnv":"COHERE_API_KEY"}'
```

5. Check the result:

```sh
plur1bus config get engine.embedding
```

An existing memory store is tied to the model that built it. Do not change `engine.embedding` by hand for it; move it with [reembed.md](reembed.md).

## Good to know

- **Privacy confirmation is required:** every embedding endpoint outside loopback (`localhost`, `127.0.0.0/8`, `::1`) needs `memory.embedding.privacyAck` for exactly that provider and endpoint. Changing the provider or address makes an old confirmation invalid. From the next release the reranker needs its own `memory.reranker.privacyAck`, bound to the provider.
- **Keys never go into the configuration:** a plaintext `apiKey` or a `baseUrl` with a user name or password is refused. Use `apiKeyEnv`. The spelling `baseURL` is refused as well, because the engine would ignore it and call its default endpoint.
- **No silent fallback:** a `fallback` model is refused. If the hosted service is unreachable, indexing and recall report the error; they never switch to another model or vector space, which would corrupt search results.
- **Local only:** from the next release, `privacy.localOnly` refuses a cloud embedding or reranker endpoint ([privacy.md](privacy.md)).

## Error messages

- `E_DENIED` with reason `privacy-acknowledgment-required`: the endpoint is outside loopback and `memory.embedding.privacyAck` is missing. The reasons `privacy-acknowledgment-invalid` (incomplete record) and `privacy-acknowledgment-mismatch` (it names another provider or endpoint) mean the same: record the confirmation again for the provider in use.
- `E_INVALID_PARAMS` with reason `engine-provider-config-incomplete`: `model`, `dimensions`, `apiKeyEnv` or, except for `openai`, `baseUrl` is missing. The reason `engine-provider-invalid` means the provider id is malformed.
- `E_INVALID_PARAMS` with reason `secret-in-config`: a plaintext key, or credentials inside `baseUrl`. Remove them and name an environment variable in `apiKeyEnv`.
- `E_INVALID_PARAMS` with reason `embedding-fallback-refused`: remove `fallback`; change models with `memory reembed`.
- `E_NOT_AVAILABLE` with reason `engine-adapter-factory-unavailable`: the reranker provider has no adapter yet; only `cohere` works.
- `E_DENIED` with reason `local-only` or `egress-denied`: see [privacy.md](privacy.md) (from the next release).

## Next

- Migrate an existing store to a new embedding model: [reembed.md](reembed.md)
- Privacy and Local only: [privacy.md](privacy.md)
- Configure model providers and profiles: [providers.md](providers.md)
