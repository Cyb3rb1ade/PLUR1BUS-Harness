# AF0 — completed local protocol measurements

Measured on macOS 27.2 (26B123), Apple Silicon, Node v24.21.0. Collector source: `0dd63d4516d628a9936597f02062872ef0e514e8`.

The [final native JSON](./2026-11-01-probe-final.json) is the measured wire evidence. The [original stopped receipt](./2026-11-01-probe.md) and [original JSON](./2026-11-01-probe.json) remain byte-identical. Their exit-code interpretation is superseded by the controller clarification of 2026-11-01.

The [intermediate timeout receipt](./2026-11-01-probe-continued.json) exposed a collector readiness defect: its fs.watch barrier missed socket creation, also reproduced with a real Node fixture. The superseded first full run was removed during review. This full final run remains authoritative for protocol, latency, RSS and socket edges; the [review follow-up](./2026-11-01-probe-review.md) adds streaming-overflow and timed lifecycle measurements. The [evidence index](./README.md) identifies each receipt's scope.

The collector at the reviewed head `7e2d0f8640981f8cfadf59134d14d86fb7ef2c28` differs from this run's `0dd63d45` by AbortSignal forwarding on two `once()` waits (stale-socket and parent startup), with no wire-payload changes. This original receipt did not record whether its source tree was dirty. Review corrections change derived conclusions only; original wire events, CLI output, server logs, timing values and observation ids remain unchanged. The additional run records its clean source state and source-file SHA-256 values.

## Findings for AF1 and AF3

| Probe | Observation |
| --- | --- |
| Model availability | system available while fm models exits 1; only the system row decides |
| Revision evidence | AFM 3 Core Advanced; macOS build 26B123; raw model table in JSON |
| Socket and directory | 755 socket in 700 directory; exact /usr/bin/fm serve --socket argv; only HOME, LANG and PATH=/usr/bin:/bin |
| TCP listeners | none reported for the owned fm pid; lsof exit 1, empty stdout and stderr |
| stream omitted | SSE with [DONE] |
| stream false | application/json, with usage; JSON has no SSE terminator |
| Usage | include_usage=true adds the usage chunk; false omits it; observed SSE streams end with [DONE] |
| json_schema | valid classification output: {"category": "reminder"} |
| Tools | normal and forced af0_weather calls; parallel_tool_calls returns Berlin and Warsaw in one tool_calls delta |
| Log probabilities | request accepted; no probabilities returned in the observed response |
| max_tokens=1 | 351 reported completion tokens; not an effective cap in this probe |
| max_completion_tokens=1 | output "one"; 2 reported completion tokens; accounting does not establish an exact one-token bound |
| Unknown model | HTTP 400, invalid_request_error, code "400"; full object retained |
| Non-streaming overflow (`window-8192`) | HTTP 500 JSON, server_error, code "500"; message "The session's transcript exceeded the model's context size." |
| Streaming overflow (additional run) | HTTP 200 SSE: assistant-role chunk, then the same error object, no [DONE]; see the review follow-up |
| Unavailable transport | after teardown, connecting to the removed owned socket returned ENOENT; this is not an unavailable-system-model HTTP response |
| Parent death | this run measured one immediate health answer after killing/reaping the direct parent; the follow-up measured three successful health/PID samples over 10.00 s |
| stdin EOF | this run used /dev/null from startup; the follow-up kept a pipe open through readiness, closed it, then measured three successful health/PID samples over 10.00 s |
| Server logs | endpoints, status, model, token counts and durations observed; no synthetic prompt marker in the complete captured log |

For adapter defaults use max_completion_tokens and include_usage. Retain content-type based JSON/SSE handling. Two concurrent requests succeeded, but these observations do not prove parallel model execution; keep the conservative concurrency cap of one.

## Context and token counting

The tokenizer reported German 20 tokens for 77 UTF-16 units, English 15 for 75, and 5001 for the 50,000-unit repeated input. Its heuristic /3 bounds were 26, 25 and 16667. These samples do not prove a universal ratio.

The repeated 5,000-word request (legacy id `overflow`) was accepted with HTTP 200: CLI count 5001, server log `5056→11 tokens`. It is an accepted input, not an overflow. The sweep accepted the 4,096-word request (4097 CLI tokens, 4152 server prompt tokens), then returned the explicit context-size error on 8,192 words (8193 CLI tokens). The accepted server-prompt lower bound is therefore **5056**, independently corroborated by `usage.prompt_tokens` in the additional run. These fixtures add about 55 framing tokens; the failing input corresponds to about 8250 with that observed framing, not a measured server count at failure. The original argv-based tokenizer probe and the final stdin-based count differ by one token for these whitespace-terminated fixtures; exact framing/whitespace semantics are not inferred.

**U5's proposed 4,096-token shared hardware window is refuted.** The exact window remains unknown: at least 5056 server prompt tokens were accepted, and an input of 8193 CLI tokens failed. The 4096 catalog/guard value remains the Controller's conservative policy; this does not authorize a larger value.

The original full run measured the error only with `stream:false`. The [additional native JSON](./2026-11-01-probe-review.json) now records `stream:true` at the same failing input: HTTP 200 `text/event-stream`, an assistant-role chunk followed by the transcript-size `server_error` (`code:"500"`), and no `[DONE]`. Detect that error by its message inside SSE as well as in the non-streaming HTTP 500 JSON response; map it to non-retryable `context_overflow`.

## Latency, concurrency and RSS

Process start to healthy socket: 34.1 ms. First inference in this new server process: 279.7 ms. Twelve warm short requests with a requested three-token completion: p50 226.5 ms, nearest-rank p95 240.3 ms. With n=12 that p95 is the sample maximum, not a workload-tail estimate. The single schema classification took 364.8 ms.

Two overlapping requests both returned 200 in 362.8 ms total (362.2 / 283.4 ms individually). No scheduling or parallelism guarantee follows from those two samples.

CLI RSS before inference: 7536 KiB. Immediately after inference: 19792 KiB; after 30.0 seconds idle: 19408 KiB. These are fm-process readings, not the separate system model-service footprint or a proof of idle unloading.

The first inference is a process-cold observation, not a forced cold model or OS cache. The 1,000 ms decision deadline placeholder remains conservative for these short observations; AF5 still needs its own de/en classification workload and the owner gate for confidence without probabilities.

## Socket edge cases

| Case | Absolute path bytes | Health |
| --- | --- | --- |
| relative | 40 | 200 |
| stale | 37 | 200 |
| path-103 | 103 | 200 |
| path-104 | 104 | 200 |

The relative-path case is an isolated AF0 edge experiment; production remains absolute-path only. The stale socket fixture was created by an owned Node child, which exited before fm was launched. fm replaced that stale socket successfully and served health with HTTP 200. HTTP readiness prevents the old socket inode from satisfying the barrier. Both 103- and 104-byte paths happened to work here; the managed-transport policy remains capped at 103 bytes.

## Limits and cleanup

Only system and the invented unknown-model identifier were sent to the completion endpoint. PCC was never invoked. Its unavailable reason was observed in /health only. No licence command, sudo, global Apple Intelligence change or personal Harness instance was used.

A system-unavailable HTTP error and downloading/region/disabled reason texts were not induced on this healthy Mac. The future fake server covers those cases; their native shapes remain open. Long idle unloading and an actually unloaded model cold start were not forced.

Cleanup recorded: {"directServerReaped":true,"temporaryDirectoryRemoved":true}. All direct server children were reaped; the parent-death probe's remaining owned group was signalled. The temporary tree was removed. The later manual PID visibility check was not recorded in this original JSON, so it is not automatic receipt evidence. The additional run records ESRCH for all three owned process groups and all four recorded PIDs (three fm processes and the direct Node parent), with the temporary tree removed. Its stdin-EOF and parent-death conclusions are limited to the measured ten-second intervals.

The current collector intercepts repeated HUP/INT/TERM through teardown and receipt writes, and reserves both JSON and Markdown with `wx`. SIGKILL (`kill -9`) of the collector cannot be intercepted and can leave its detached groups and temporary directory.

## Raw observation table

| Observation | HTTP | Format | DONE | Usage | Log probabilities | ms |
| --- | --- | --- | --- | --- | --- | --- |
| health | 200 | json | false | false | false | 2.1 |
| models | 200 | json | false | false | false | 0.5 |
| stream-omitted | 200 | sse | true | false | false | 279.7 |
| stream-false | 200 | json | false | true | false | 208.4 |
| usage | 200 | sse | true | true | false | 218.1 |
| usage-disabled | 200 | sse | true | false | false | 205.9 |
| completion-token-field | 200 | sse | true | false | false | 209.9 |
| max-tokens-one | 200 | json | false | true | false | 5927.9 |
| max-completion-tokens-one | 200 | json | false | true | false | 208.2 |
| latency-1 | 200 | json | false | true | false | 240.3 |
| latency-2 | 200 | json | false | true | false | 231.3 |
| latency-3 | 200 | json | false | true | false | 234.9 |
| latency-4 | 200 | json | false | true | false | 226.3 |
| latency-5 | 200 | json | false | true | false | 228.5 |
| latency-6 | 200 | json | false | true | false | 226.5 |
| latency-7 | 200 | json | false | true | false | 227.8 |
| latency-8 | 200 | json | false | true | false | 223.3 |
| latency-9 | 200 | json | false | true | false | 224.3 |
| latency-10 | 200 | json | false | true | false | 226.5 |
| latency-11 | 200 | json | false | true | false | 226.1 |
| latency-12 | 200 | json | false | true | false | 227.1 |
| concurrency-2 | 200 | sse | true | false | false | 283.4 |
| concurrency-1 | 200 | sse | true | false | false | 362.2 |
| json-schema | 200 | sse | true | false | false | 364.8 |
| tools | 200 | sse | true | false | false | 519.9 |
| forced-tool | 200 | sse | true | false | false | 480.8 |
| parallel-tools | 200 | sse | true | false | false | 817.4 |
| logprobs | 200 | sse | true | false | false | 224.7 |
| unknown-model | 400 | json | false | false | false | 0.7 |
| overflow (legacy id: accepted 5k) | 200 | sse | true | false | false | 4799.6 |
| window-4096 | 200 | json | false | true | false | 3337.7 |
| window-8192 | 500 | json | false | false | false | 928.7 |

Exact response events, error objects, CLI output and measurement limits are in the adjacent JSON.

First inference: 279.7 ms; warm nearest-rank p95/sample maximum: 240.3 ms (n=12).
This first request is not evidence of a cold OS cache or an unloaded system model.
