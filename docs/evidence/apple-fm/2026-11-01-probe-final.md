# AF0 — completed local protocol measurements

Measured on macOS 27.2 (26B123), Apple Silicon, Node v24.21.0. Collector source: `0dd63d4516d628a9936597f02062872ef0e514e8`.

The [final native JSON](./2026-11-01-probe-final.json) is the measured wire evidence. The [original stopped receipt](./2026-11-01-probe.md) and [original JSON](./2026-11-01-probe.json) remain byte-identical. Their exit-code interpretation is superseded by the controller clarification of 2026-11-01.

The [intermediate timeout receipt](./2026-11-01-probe-continued.json) exposed a collector readiness defect: its fs.watch barrier missed socket creation, also reproduced with a real Node fixture. [The first protocol run](./2026-11-01-probe-full.json) established the wire features; the final run additionally corrected stale-socket readiness and measured context/error boundaries. These earlier files are retained without rewriting their observations.

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
| Overflow | HTTP 500, server_error, code "500"; message "The session's transcript exceeded the model's context size." |
| Unavailable transport | after teardown, the owned socket refuses connections; this is not an unavailable-system-model HTTP response |
| Parent death | fm answered health after its direct parent was killed and reaped; the owned group then received teardown signals |
| stdin EOF | the main server continued serving with stdin closed from startup |
| Server logs | endpoints, status, model, token counts and durations observed; no synthetic prompt marker in the complete captured log |

For adapter defaults use max_completion_tokens and include_usage. Retain content-type based JSON/SSE handling. Two concurrent requests succeeded, but these observations do not prove parallel model execution; keep the conservative concurrency cap of one.

## Context and token counting

The tokenizer reported German 20 tokens for 77 UTF-16 units, English 15 for 75, and 5001 for the 50,000-unit repeated input. Its heuristic /3 bounds were 26, 25 and 16667. These samples do not prove a universal ratio.

The repeated 5,000-word request was accepted. The sweep accepted the 4,096-word request (4097 CLI-reported tokens), then returned the explicit context-size error on 8,192 words (8193 CLI-reported tokens). The original argv-based tokenizer probe and the final stdin-based count differ by one token for these whitespace-terminated fixtures; exact framing/whitespace semantics are not inferred.

The exact shared context window remains unproven. The evidence does not establish a 4,096-token hardware limit. Keep the decided 4,096 catalog/guard value conservative; expanding it needs a separately justified change. Detect the observed overflow by its message as well as the coarse HTTP 500/server_error shape, so it becomes context_overflow rather than a generic retryable error.

## Latency, concurrency and RSS

Process start to healthy socket: 34.1 ms. First inference in this new server process: 279.7 ms. Twelve warm short requests: p50 226.5 ms, p95 240.3 ms. The single schema classification took 364.8 ms.

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

The relative-path case is an isolated AF0 edge experiment; production remains absolute-path only. The stale socket fixture was created by an owned Node child, which exited before fm was launched. HTTP readiness prevents the old socket inode from satisfying the barrier. Both 103- and 104-byte paths happened to work here; the managed-transport policy remains capped at 103 bytes.

## Limits and cleanup

Only system and the invented unknown-model identifier were sent to the completion endpoint. PCC was never invoked. Its unavailable reason was observed in /health only. No licence command, sudo, global Apple Intelligence change or personal Harness instance was used.

A system-unavailable HTTP error and downloading/region/disabled reason texts were not induced on this healthy Mac. The future fake server covers those cases; their native shapes remain open. Long idle unloading and an actually unloaded model cold start were not forced.

Cleanup recorded: {"directServerReaped":true,"temporaryDirectoryRemoved":true}. All direct server children were reaped; the parent-death probe's remaining owned group was signalled. The temporary tree was removed. A later read-only visibility check of all six recorded fm pids returned ESRCH for each.

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
| overflow | 200 | sse | true | false | false | 4799.6 |
| window-4096 | 200 | json | false | true | false | 3337.7 |
| window-8192 | 500 | json | false | false | false | 928.7 |

Exact response events, error objects, CLI output and measurement limits are in the adjacent JSON.

First inference: 279.7 ms; warm p95: 240.3 ms (12 observations).
This first request is not evidence of a cold OS cache or an unloaded system model.
