# WP5 Task 13 Step 0 — native transport spike

This is a **test-only experiment**, before the production SPA proxy. It implements
no ticket login, cookie jar, production navigation policy, `shell_info`, SPA bridge,
or connection switching. The existing nine-command app ACL and Rust callers are
unchanged. The controller owns the workflow, target CI observations, and the
carry-forward decision before production work begins.

## Run the native experiment

From the repository root with Node 24.21.0, pnpm 10.28.0 and Rust 1.95:

```sh
pnpm --filter @plur1bus/desktop-ui build
node apps/desktop/scripts/transport-spike.mjs
# Linux, including both existing Ubuntu CI targets:
xvfb-run -a node apps/desktop/scripts/transport-spike.mjs
```

The runner builds the `transport_spike` Cargo example, launches it deliberately,
and waits at most 75 seconds. It uses the actual Tauri 2.12.0 / wry 0.57.0 native
engine, not Playwright, Chromium emulation, or a Tauri mock runtime. Two diagnostic
windows open: a registered `plur1bus-harness` custom protocol and an ephemeral
IPv4 loopback HTTP proxy. All profiles, application directories, HOME/XDG paths,
and diagnostic artifacts are under temporary directories. The example does not
initialize any production commands, token store, keychain, runtime or service
manager. Nothing listens beyond `127.0.0.1`.

The loopback fixture requires a per-run generated diagnostic key, exact Host and
one of the explicitly listed test Origins; it accepts a missing Origin for
navigation and `null` for observation. It is **not production request-security
policy**. The diagnostic key is never a device token; it exists in memory and
request URLs, is redacted from reported JS errors, and is not copied into results.

Artifacts are `${RUNNER_TEMP:-<OS temporary directory>}/plur1bus-native-spike-run-*/native-transport.json`
and `native-process.log`. The JSON is written after each completed window, so a
partial result survives a second-window timeout. Missing observations/nonzero
process exit fail collection. Unsupported custom transports are measured results,
not failures of collection and certainly not transport passes. The CI uploads
these artifacts from the existing five-target `desktop.yml` matrix.

## What the experiment measures

- A real fixture emits SSE event 0 immediately, event 1 after 1,500 ms, then EOF.
  The custom handler must give Tauri a complete byte body; the loopback path uses
  reqwest's body stream through Axum. Native EventSource records both arrival times.
- A real WebSocket echo traverses Axum -> tokio-tungstenite -> the fixture.
  The literal custom URL and its `ws://plur1bus-harness.localhost` equivalent are
  attempted separately, and the custom handler records every received path.
- 110 alternating direct/proxied pairs warm up for 10 pairs and retain 100 deltas.
  `p95OverheadMs` is the nearest-rank p95 of each paired proxy-minus-direct duration.
  It is an end-to-end native-browser measurement with browser timing granularity,
  scheduling and network-stack differences, **not an isolated Rust CPU overhead**.
  Both diagnostic windows run concurrently. Negative custom deltas mean that the
  native custom path is faster than the HTTP baseline in this experiment, not
  negative processing time. No production performance guarantee follows.
- A 10 MiB (10,485,760 byte) body is downloaded and every byte checked.
- `location.origin`, actual GET/POST Origin headers, script CSP `'self'` success,
  and a deliberately foreign script's CSP rejection are recorded. Diagnostic
  `connect-src` includes the direct fixture, mapped WebSocket address and IPC
  classification path; this is not the production SPA CSP.
- Only in this example, `app_info` returns a fixed local-capability marker and
  `settings_get` a fixed remote-capability marker. The existing generated permission
  identifiers are reused without calling production implementations or extending
  the production command table. Local-only and exact-origin remote-only runtime
  capabilities distinguish the native page's actual Tauri classification.
- The loopback window alone has the public per-window user-agent marker
  `PLUR1BUS-Native-Spike/1`. Server-side observations record it independently for
  GET, POST, EventSource and WebSocket upgrade. This measures possible transport
  for a future launch secret; it does not select or implement that design.
- Empty `document.cookie` is merely an observation in an experiment that never
  sets cookies. SameSite/Secure attributes, HttpOnly cookies, an in-memory Rust
  session jar and absence of cookie databases are **not verified** by this spike.
  Those are production Step 1 acceptance work.

## Observed native results — local macOS arm64

Recorded on 2026-10-02, actual native WKWebView on the local macOS arm64 host
(Darwin 27.2.0; complete kernel and default native UA are in the JSON). This host
is **not the `macos-15` CI image**. The checked-in public observation snapshot is
[`observed-wkwebview-macos-arm64.json`](observed-wkwebview-macos-arm64.json).

Exact command: `node apps/desktop/scripts/transport-spike.mjs` from the root.
Raw result: `/var/folders/gs/kv4mqlgn0y3ftxtypfxm_5xw0000gn/T/plur1bus-native-spike-run-DIueD1/native-transport.json`.
Raw process log: the adjacent `native-process.log` (exit 0, no stderr).
The checked-in JSON is byte-identical, SHA-256
`7e8b8d8edd08f1cf1ca9237ce38df1a5b2fd4188b78483ebc35b01f377b023c5`.

| Step 0 measurement / JSON field | Custom scheme, native WKWebView | Loopback proxy, native WKWebView |
|---|---|---|
| SSE first / second event (`observations.*.sse`) | 1,503 / 1,503 ms: both buffered until EOF | 2 / 1,505 ms: first event delivered before EOF |
| Direct fixture SSE reference (`directSse`) | 9 / 1,510 ms | 2 / 1,504 ms |
| WebSocket (`websocket`, `mappedWebsocket`, `customHandlerRequests`) | Literal constructor rejected; mapped WS error after 54 ms; **zero `/ws` handler invocations** | Real proxied echo in 5 ms |
| 100-pair p95 delta (`latency`) | -1 ms; raw proxy p95 1 ms, HTTP baseline p95 3 ms | **4 ms**, within 5 ms budget in this run; proxy p95 5 ms, baseline p95 3 ms |
| 10 MiB (`download`) | Every byte correct, 8 ms | Every byte correct, 15 ms |
| Page origin (`origin`) | `plur1bus-harness://localhost` | `http://127.0.0.1:53698` |
| Actual request Origin (`requestOrigin`, `postOrigin`, handler/server request records) | Both same-origin GET and POST had **no Origin header** (`null` in JSON), distinct from the literal HTTP value `Origin: null` | GET and EventSource had no Origin header; POST and WebSocket upgrade had exact `http://127.0.0.1:53698` |
| CSP (`cspSelfScript`, `cspForeignScript`, `violations`) | Self script loaded; localhost-name foreign script rejected with `script-src-elem` violation | Same positive/negative controls passed |
| Tauri classification (`localCapability`, `remoteCapability`) | Local-only marker allowed, exact-remote-only marker refused (`URL: local`) | Local-only marker refused, exact-remote-only marker allowed |
| Cookies (`cookieBefore`, `cookieAfter`) | Empty, with no cookies set by fixture | Empty, with no cookies set by fixture |

The public per-window UA marker was observed by the server on all requested
loopback paths: navigation GET `/proxy/` (1), fetch GET `/proxy/ping` (111),
POST `/proxy/ping` (1), EventSource GET `/proxy/events` (1), and WebSocket
GET `/proxy/ws`, `Upgrade: websocket` (1). Every record had
`User-Agent: PLUR1BUS-Native-Spike/1`. These are actual incoming headers in
`loopbackServerRequests`, not merely `navigator.userAgent`. The custom window
retained the default WK user-agent. This only establishes the observed WK behavior;
Windows/GTK and production launch-secret design are still pending.

The observed custom SSE buffering and missing WebSocket routing select the owner's
**loopback fallback for this observed WKWebView target**. The production fallback
still needs ephemeral `127.0.0.1`, a per-launch secret on every request, strict
Host/Origin enforcement, the existing rustls trust policy, an in-memory cookie jar,
and all remaining Task 13 acceptance tests. No IPC HTTP/SSE/WebSocket replacement
is introduced or proposed.

## Five-target observation status at source freeze

| Existing CI target | Actual native engine | Current evidence | Carry-forward |
|---|---|---|---|
| `macos-15` arm64 | WKWebView | CI image skipped locally: host is Darwin 27.2.0, not that image; native CI pending. Separate local WK evidence above. | Local WK result selects loopback; record CI OS-specific observation. |
| `windows-2025` x64 | WebView2 | Environment skip locally: no Windows native process was launched; genuine existing-matrix CI arranged. | Await measured result; if either SSE or WS fails, loopback. |
| `windows-11-arm` arm64 | WebView2 | Environment skip locally: no Windows native process was launched; genuine existing-matrix CI arranged. | Same rule, no x64-to-arm inference. |
| `ubuntu-24.04` x64 | WebKitGTK | Environment skip locally: no GTK engine/display on this macOS host; CI uses `xvfb-run`. | Await measured result; if either SSE or WS fails, loopback. |
| `ubuntu-24.04-arm` arm64 | WebKitGTK | Environment skip locally: no GTK engine/display on this macOS host; CI uses `xvfb-run`. | Same rule, no x64-to-arm inference. |

A skip is neither an engine failure nor a pass. The controller records actual CI
artifact results and any environment failure before declaring Step 0 complete on
all target platforms. A successful workflow collection step alone does not say
that custom transport, streaming or the production proxy passed.

## Native stream API reachability — source analysis, not runtime passes

Inspected the pinned local Cargo registry sources, independently of native results:

| API/source | Observed implementation | Scope of conclusion |
|---|---|---|
| `tauri-2.12.0/src/app.rs:2623-2636` | `UriSchemeResponder` is a `FnOnce(Response<Cow<'static,[u8]>>)` and consumes itself in `respond`. | Public Tauri responder receives one complete body, no stream/chunk interface. |
| `wry-0.57.0/src/lib.rs:440`, `1140` | Its asynchronous custom protocol responder also consumes `Response<Cow<'static,[u8]>>`. | Going directly through the supported wry custom-protocol API does not expose streaming. |
| `wry-0.57.0/src/wkwebview/class/url_scheme_handler.rs:189,268-288` | Copies the finished body into `NSData`, calls `didReceiveData` once, then `didFinish`. | Although native `WKURLSchemeTask` has incremental methods, the supported responder does not expose that task/chunk lifecycle. No raw native delegate replacement was implemented or claimed tested. |
| `wry-0.57.0/src/webview2/mod.rs:1180-1203` | Creates `SHCreateMemStream` from the finished body for `CreateWebResourceResponse`. | This pinned wrapper uses a memory stream. A custom COM streaming response bypass is not exposed by its response type and was not tested here. |
| `wry-0.57.0/src/webkitgtk/web_context.rs:219-241` | Builds `MemoryInputStream` from finished bytes, sets known length and finishes the scheme response. | The native input-stream abstraction is fed a complete memory buffer. A lower-level streaming replacement was not tested here. |

This is evidence about the supported pinned Tauri/wry API. It is not proof that
all native engine APIs are fundamentally incapable of streaming, and it does not
substitute for the Windows/GTK native CI observations.

## Validation and exact dependencies

Local validation (desktop Cargo invocations were serial):

| Command | Result |
|---|---|
| `cargo fmt --all -- --check` in `apps/desktop` | PASS |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` in `apps/desktop` | PASS, including diagnostic example |
| `cargo test --locked --example transport_spike -p plur1bus-desktop` in `apps/desktop` | 2 PASS: fixture guard rejects wrong key/Host/Origin; real HTTP proxy delivers SSE before fixture EOF |
| `cargo test --locked --workspace --no-fail-fast` in `apps/desktop` | PASS; the existing real-keychain opt-in test remains deliberately ignored |
| `pnpm --filter @plur1bus/desktop-ui build` | PASS |
| `pnpm --filter @plur1bus/desktop-ui test` | 47 PASS; these Chromium UI regressions are separate from native transport evidence |
| `pnpm tauri build --debug --no-bundle -- --locked` in `apps/desktop` | PASS |
| `pnpm lint` at root | Typecheck/hygiene PASS, 29 tooling tests PASS |
| `node apps/desktop/scripts/transport-spike.mjs` | Native WK collection PASS; custom SSE and WS measured unsupported for required behavior |

Five-target packaging/native CI remains controller-owned and pending at this source
freeze. Production source was unchanged; the subsequent public UA diagnostic
addition was rechecked with Clippy, focused fixture tests and real WK execution.

All newly added dev-dependency pins reuse existing workspace versions. Live
verification on 2026-10-02 fetched these official crates.io API URLs with Python
`urllib.request`; each returned the exact requested version, `yanked: false`, and
a SHA-256 checksum equal to the matching `apps/desktop/Cargo.lock` entry:

- [axum 0.8.6](https://crates.io/api/v1/crates/axum/0.8.6)
- [futures-util 0.3.31](https://crates.io/api/v1/crates/futures-util/0.3.31)
- [tokio-tungstenite 0.28.0](https://crates.io/api/v1/crates/tokio-tungstenite/0.28.0)
- [reqwest 0.12.24](https://crates.io/api/v1/crates/reqwest/0.12.24), whose dev-only `stream` feature adds locked `wasm-streams 0.4.2` transitively.

The web tool could not open those endpoints; the actual HTTP fetch and checksum
comparison succeeded. Exact pins and `--locked` builds are distinct evidence from
that registry verification. Root `pnpm-lock.yaml`, the engine pin, production
commands, CA/leaf rollover code and Windows private CRT shim were not edited.
