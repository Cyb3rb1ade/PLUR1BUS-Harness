# AF0 Apple Foundation Models live probe

Status: **observed**.

Input policy: synthetic inputs and model `system`; any unknown-model request uses an invented identifier.
The server was invoked with `serve --socket` in an owned 0700 temporary directory.
The probe never runs licence commands or changes Apple Intelligence settings.

Platform: macOS 27.2, build 26B123; arm64.
Node: v24.21.0. Collector commit: 6572e0da2e3b4977897126355a8401833895c019; source tree dirty before receipt creation: false.
Source-file SHA-256 values and measured cwd/TTY facts are in the JSON; TTY facts alone do not identify an executor.

Prior evidence: [2026-11-01-probe-final.json](./2026-11-01-probe-final.json) ([report](./2026-11-01-probe-final.md)).
Prior evidence: [2026-11-01-probe.json](./2026-11-01-probe.json) ([report](./2026-11-01-probe.md)).

| Observation | HTTP | Format | DONE | Usage | Log probabilities | ms |
| --- | --- | --- | --- | --- | --- | --- |
| window-5000 | 200 | json | false | true | false | 5050.2 |
| window-8192 | 500 | json | false | false | false | 1018.9 |
| window-8192-stream | 200 | sse | false | false | false | 1010.8 |

## Context measurements

Accepted server prompt tokens: at least 5056. Accepted standalone CLI tokens: 5001.
The 4,096-token shared-window proposal is **refuted**. The 4096 catalog/guard policy remains conservative; the exact window is not inferred.
Streaming attempt at 8193 CLI tokens: HTTP 200, sse, error {"type":"server_error","message":"The session's transcript exceeded the model's context size.","code":"500"}, transport failure null.

## Parent death

3 health/PID samples over 10.00 seconds; continuedServing=true; observationComplete=true.
Only this finite observation interval is established. Per-sample responses and PID visibility are in the JSON.

## Post-start stdin EOF

3 health/PID samples over 10.00 seconds; continuedServing=true; observationComplete=true.
Only this finite observation interval is established. Per-sample responses and PID visibility are in the JSON.

After teardown the transport returned ENOENT; this is not a native unavailable-system-model HTTP error.

Remaining measurements:

- Unavailable-system HTTP error and downloading/region/disabled variants were not induced by changing settings.
- Licence-unagreed state was not induced; no licence command runs in this collector.
- Exact shared context window remains unmeasured; accepted server prompt counts can refute 4096 without fixing its size.
- Long idle unloading, a forced unloaded-model cold start and system model-service RSS remain unmeasured.
- Full protocol, warm latency, CLI RSS and socket-edge probes were not repeated in this focused run.
- Parent death: behavior beyond the observed 10.00-second interval is unmeasured.
- Post-start stdin-pipe EOF: behavior beyond the observed 10.00-second interval is unmeasured.

## Cleanup

Recorded automatic cleanup evidence: {"servers":[{"name":"main","pid":37138,"directChildReaped":true,"signals":[{"signal":"SIGTERM","code":"sent"}],"pids":[{"pid":37138,"exists":false,"code":"ESRCH"}],"group":{"groupId":37138,"exists":false,"code":"ESRCH","waitedMs":0.006790999999793712},"exit":{"code":0,"signal":null},"directServerReaped":true},{"name":"stdin-eof","pid":37404,"directChildReaped":true,"signals":[{"signal":"SIGTERM","code":"sent"}],"pids":[{"pid":37404,"exists":false,"code":"ESRCH"}],"group":{"groupId":37404,"exists":false,"code":"ESRCH","waitedMs":0.004415999999764608},"exit":{"code":0,"signal":null},"directServerReaped":true},{"name":"parent-death","pid":37815,"directChildReaped":true,"signals":[{"signal":"SIGTERM","code":"sent"}],"pids":[{"pid":37812,"exists":false,"code":"ESRCH"},{"pid":37815,"exists":false,"code":"ESRCH"}],"group":{"groupId":37812,"exists":false,"code":"ESRCH","waitedMs":0.004333000000769971},"exit":{"code":null,"signal":"SIGKILL"}}],"allGroupsGone":true,"allPidsGone":true,"temporaryDirectoryRemoved":true}.

SIGKILL (`kill -9`) of the collector cannot be intercepted and can leave its detached server groups and temporary tree. HUP/INT/TERM remain intercepted through group teardown and receipt writes.
