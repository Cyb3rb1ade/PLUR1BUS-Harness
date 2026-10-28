# N-E7 cache evidence and limits

The deterministic turn eval measures tool-zone prefix changes, not vendor cache hits.
Its unchanged baseline has 3 changes in 24 turns (0.125/turn); the final comparison belongs in the PR.
`provider.cache_usage` continues to record real cache-read/write/input token buckets from provider usage.
The tool-choice switch is applied outside the four rendered prompt zones; tool schemas stay fixed within a turn.

On 2026-10-28, fresh reads of the official OpenAI prompt-caching guide, Anthropic prompt-caching and tool-use guides,
and Gemini caching guide were refused by this environment's network proxy (`CONNECT 403`).
The source URLs and provider-specific limits are recorded in [tool reliability](../tool-reliability.md).
No alternate route was used. This run has no configured live-model credentials, so it cannot measure cache-hit
shares or establish a current vendor cache contract experimentally. Fixture prefix stability is not a substitute.

Optional OpenAI allowed-tools and Anthropic tool-search APIs are omitted: the stable core and ordinary schema tools
provide a portable baseline, and current vendor documentation could not be verified here.
