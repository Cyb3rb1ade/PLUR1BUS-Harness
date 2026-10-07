# C3 — Local models: Ollama / LM Studio discovery and adapter wiring

Scope: `packages/providers/src/local/**` only. No RPC, no config keys, no CLI (a later task wires discovery into `model scan`).

## Design
- `loopback.ts` — `isLoopbackUrl`: only `localhost`, `127.0.0.0/8`, `[::1]`. Fail closed on anything else.
- `probe.ts` — `probeEndpoint`: keyless GET of the model list. Dialect `ollama` = `/api/tags` (`models[].name`), `openai` = `/v1/models` (`data[].id`). Never throws; returns a `state`: `ok | empty | unreachable | timeout | refused | protocol`. Redirects are not followed, bodies are size-capped, no credentials are ever sent.
- `discover.ts` — `discoverLocalEndpoints`: default candidates `127.0.0.1:11434` (Ollama: tags first, then `/v1/models`) and `127.0.0.1:1234` (LM Studio: `/v1/models`). Extra candidates must be loopback or opt in explicitly (`allowNonLoopback`) *and* pass an injected `EgressPolicy`; without a policy a non-loopback candidate is refused.
- `adapter.ts` — `createLocalChatAdapter`: builds the chat_completions adapter through an injected factory (`ChatAdapterFactory`) with a no-auth `ProviderCredentials` (`authorization()` → `undefined`, so no `Authorization` header).

## Dependencies on work not on main
- The chat_completions adapter (`feat/m2-providers-chat-completions`): consumed through the generic `ChatAdapterFactory` port, a fake in the tests. `package.json` is byte-identical to that branch; `src/index.ts` will conflict trivially (add/add) and the union of both export lists is the resolution.
- Egress policy (B4): `EgressPolicy` port, fake in the tests.

## Tests (`test/local/`)
Fake servers for both dialects, timeout on a hanging service, unreachable port, empty list, error classes, loopback guard, egress gate, no-auth header.
