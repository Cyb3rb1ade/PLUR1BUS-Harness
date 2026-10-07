# Contract fixtures: SYNTHETIC reconstructions, not live captures

Every file in this folder was **written by hand** from the public documentation of the wire formats it imitates.
**None of them is a recording of a real provider or a real local server.** They exist so that the shared streaming
contract (`../streaming.contract.test.ts`, `../harness.ts`) can replay byte-exact server output through a loopback
stub (127.0.0.1 only) and run the same scenarios against every adapter. Where a quirk is attributed to a server
(Ollama, LM Studio) it is a plausible reconstruction, not a verified observation of that server.

Naming: `<wire>.<scenario>.sse` (an SSE body, replayed in odd-sized byte pieces) and `<wire>.http-<status>.json`
(the body of a non-2xx response; status and headers are set by the harness).

| wire       | used by                                              | format                                             |
|------------|------------------------------------------------------|----------------------------------------------------|
| `openai`   | `createChatCompletionsAdapter`                       | OpenAI `/v1/chat/completions` SSE, `[DONE]` ends   |
| `ollama`   | `createLocalChatAdapter` + chat_completions adapter  | OpenAI `/v1` SSE; usage as native eval counts (`prompt_eval_count` / `eval_count`) on the finish chunk; reasoning under `reasoning` |
| `lmstudio` | `createLocalChatAdapter` + chat_completions adapter  | OpenAI `/v1` SSE; partial usage (`prompt_tokens` only) on the finish chunk |
| `gemini`   | `createGeminiAdapter`                                | `streamGenerateContent?alt=sse`, CRLF, no `[DONE]`, cumulative `usageMetadata` in every chunk |
| `anthropic` | `createAnthropicAdapter`                            | Messages API SSE (`message_start` … `message_stop`), tool input in `input_json_delta` fragments, thinking blocks, errors as `error` events |
| `responses` | `createResponsesAdapter`                            | OpenAI Responses API SSE (`response.created` … `response.completed`), `function_call_arguments.delta` fragments, reasoning summaries, `response.failed` (overloaded) and `error` events (rate limit, auth) |

Scenarios (one file per wire each): `text`, `tools` (two parallel tool calls, arguments split over several deltas on
the OpenAI-style, Anthropic and Responses wires, whole `functionCall` parts on Gemini), `empty`, `no-usage`, `reasoning-usage`, `stall`
(two deltas, then the server goes silent: the abort scenario), `cut` (two deltas, then the server destroys the
socket), `truncated` (two deltas, then a clean close without a finish), `error-overloaded`, `error-rate-limit`,
`error-auth` (two deltas, then an error object in the stream).

Each `.sse` file starts with an SSE comment line (`: SYNTHETIC reconstruction ...`) saying the same; SSE parsers
ignore comment lines, so the marker travels with the bytes. JSON has no comments, hence this README for the `.json` files.
