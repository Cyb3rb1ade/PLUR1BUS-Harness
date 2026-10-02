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
retained the default WK user-agent. This historical local run establishes WK
behavior; the later CI table below adds GTK measurements. Windows observations
and the production launch-secret design remain pending.

The observed custom SSE buffering and missing WebSocket routing select the owner's
**loopback fallback for this observed WKWebView target**. The production fallback
still needs ephemeral `127.0.0.1`, a per-launch secret on every request, strict
Host/Origin enforcement, the existing rustls trust policy, an in-memory cookie jar,
and all remaining Task 13 acceptance tests. No IPC HTTP/SSE/WebSocket replacement
is introduced or proposed.

## Five-target observations at exact 182cbc8

Primary PR run [37021651202](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37021651202),
head `182cbc8d5994b5753eb5442e28d04eb9652b1f07`, produced actual native results on
three targets and completed startup failures on two. Each artifact's API metadata
independently identifies that exact run/head. The local JSON above remains a
historical observation and is not substituted for CI evidence.

| Target / engine | Custom SSE first/second; WS routing | Loopback SSE first/second; WS echo; paired p95 | Native artifact |
|---|---|---|---|
| macos-15 arm64 / WKWebView | 1510/1510 ms; literal constructor rejected, mapped WS error, zero handler `/ws` hits | 4/1505 ms; echo 37 ms; p95 2 ms | [11232948229](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37021651202/artifacts/11232948229) |
| ubuntu-24.04 x64 / WebKitGTK | 1504/1504 ms; literal constructor rejected, mapped WS error, zero handler `/ws` hits | 2/1504 ms; echo 3 ms; p95 3 ms | [11233098514](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37021651202/artifacts/11233098514) |
| ubuntu-24.04-arm / WebKitGTK | 1504/1504 ms; literal constructor rejected, mapped WS error, zero handler `/ws` hits | 2/1503 ms; echo 3 ms; p95 2 ms | [11233888630](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37021651202/artifacts/11233888630) |
| windows-2025 x64 / intended WebView2 | **No engine observation:** process immediately exited 3221225785 / `0xC0000139`; no JSON | Unknown; native prerequisite failed before results | [11233563460](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37021651202/artifacts/11233563460) |
| windows-11-arm / intended WebView2 | **No engine observation:** same immediate process status; no JSON | Unknown; native prerequisite failed before results | [11233004315](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/actions/runs/37021651202/artifacts/11233004315) |

Each successful native run downloaded 10 MiB with every byte correct. All three
observed custom pages report `plur1bus-harness://localhost`, no GET/POST Origin
header, and **local** Tauri capability classification. Loopback is **remote** for
capabilities; navigation/fetch/EventSource GET has no Origin header, while POST
and WebSocket have that run's exact loopback Origin. CSP self script loads and the
foreign script is blocked on both pages. Each observed loopback server receives
`PLUR1BUS-Native-Spike/1` on navigation GET, fetch GET, POST, EventSource and the
WebSocket upgrade. Windows behavior remains unknown.

The owner-selected loopback fallback applies to the three observed WK/GTK targets.
Windows startup failures are not transport failures and do not select its fallback.
Both Windows fixture tests and example builds passed before the native process
failed; their uploaded `native-process.log` is only the runner's one-byte newline.
The missing DLL/procedure is still unidentified. Production Task 13 stays stopped
until the controller has actual Windows diagnostics, a reviewed correction if
needed, and genuine native observations.

Raw collection/index and complete per-target Origin/UA/capability findings are
recorded in the ignored recovery report `wp05-spike-report.md`; downloaded raw
files/index are under `/tmp/wp05-native-ci-37021651202-aWGqrQ/`. Collection/upload
success is distinct from transport or performance success. GTK Xvfb DRI3 warnings
were retained; neither target's successful native collection was replaced with
Chromium simulation.

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

The exact-182cbc8 native CI observations and Windows execution failures are now
recorded above. Subsequent diagnostics/packaging gates remain controller-owned. Production source was unchanged; the subsequent public UA diagnostic
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


## Windows startup diagnostic checkpoint

The original Windows process status alone identifies neither a particular DLL nor
a procedure. The following **test-only** extension gathers that evidence on a
subsequent Windows CI run; it changes no CRT policy, dependency, production command
or transport implementation.

`transport_spike` emits the fixed public stderr marker
`PLUR1BUS_NATIVE_SPIKE_MAIN_ENTERED` as the first statement of Rust main. The runner
writes `native-startup.json` with the actual executable SHA-256, PE architecture,
original decimal/unsigned/hex process status, signal/error code, isolated cwd and
whether that marker appeared. A missing marker distinguishes failure before that
statement; it does not name a failing import. The native process still has its
75-second timeout and an unsuccessful child still fails collection. The build has
a 15-minute bound. Diagnostics can never turn that failed launch into a pass.

On Windows failure, the runner's Node PE reader handles PE32/PE32+, normal and
delay imports, names and ordinals, export tables and forwarded exports. A bounded
PowerShell/C# helper calls public Windows `LoadLibraryExW`, `GetProcAddress`,
`GetModuleFileNameW` and `IsWow64Process2`. It uses the Windows resolver for virtual
API-set names; absence of a physical `api-ms-*.dll` is never treated as proof of
failure. API-set contracts are traversed through their Windows-resolved host DLL.

If a DLL cannot load normally, `LOAD_LIBRARY_AS_IMAGE_RESOURCE` maps its metadata
without initializing it. `GetMappedFileNameW`/`QueryDosDeviceW` record the actual
mapped file so the Node reader can inspect its transitive imports and export
forwarders. A failed normal load remains recorded; static export inspection is
not called a successful GetProcAddress lookup. A non-null ordinal result is also
checked against the PE export table, because ordinal holes can give a misleading
non-null result. See Microsoft's [LoadLibraryExW](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw)
and [GetProcAddress](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-getprocaddress)
contracts. The discouraged `DONT_RESOLVE_DLL_REFERENCES` flag is not used.

The helper's process architecture is compared with the actual executable; a
mismatch is explicitly limited/unavailable evidence. Each invocation is bounded
to at most 12 seconds, within a 45-second helper scheduling budget. Recursion is
bounded to 12 rounds/192 parsed modules, and file/table/string limits bound parsing.
The helper inherits the same isolated HOME/USERPROFILE/TEMP/XDG/CFFIXED environment
as the fixture, plus temporary APPDATA/LOCALAPPDATA and PowerShell module-cache
paths. `-NoProfile -NonInteractive` avoids user profiles; no environment dump,
Event Viewer, debugger, registry/IFEO/gflags changes, installs, DLL copying or
machine-wide PATH change is used. The helper's SetDllDirectory/SetErrorMode affect
only that disposable process.

The helper is a **separate process**. Its preloaded modules and DLL search context
can differ from the failed executable's loader. The diagnostic records previously
loaded module paths, exact lookup/resolved paths, version, PE architecture/hash,
missing name or ordinal, public Win32 errors and import/forwarder provenance.
These are helper observations and static PE facts, not proof of the failed child's
exact loaded-module state. Normal library loading can initialize runtime DLLs in
the helper; no resolved export is invoked. Unsupported metadata paths, parse
failures, mapping failures, mismatched architecture and exhausted budgets remain
explicit limitations, never guessed missing DLLs or procedures.

The existing `native-*` artifact glob also captures:

- `native-startup.json`: original child outcome and diagnostic status/limitations.
- `native-pe-imports.json`: actual executable and recursively resolved PE metadata,
  hashes, architecture and normal/delay import lists.
- `native-loader-exports.json`: Windows helper resolution batches and named findings
  with selected static export/forwarder facts.
- `native-loader-progress-*.jsonl`: flushed public phase checkpoints and completed
  module/name/ordinal observations, retained after a helper timeout.
- `native-loader-query-*.json`: the public module/symbol requests for each bounded
  helper invocation; no per-launch key, token or full environment is serialized.

Focused tests run with:

```sh
node --test apps/desktop/scripts/windows-startup.test.mjs
```

Fourteen tests cover PE32/PE32+, ARM64, malformed/truncated data, normal/delay/name/ordinal
imports, API-set-host traversal, transitive missing names/ordinals, forwarded
exports, ordinal holes, architecture mismatch, timeout/redaction/budget handling,
main-marker detection and preservation of the original failure. Additional cases
preserve name/ordinal observations when metadata is unreadable, outside scope or
over budget, and exercise authorized version-query scheduling and optional failure
retention. Loader symbol facts are saved before optional static enrichment;
unavailable static exports/architecture are omitted, not guessed. File-version
reads run in a separate bounded batch containing only paths already authorized by
the Node permitted-root policy. A per-file version failure stays local, and a
failed version subprocess cannot discard loader evidence. Partial metadata is
reported explicitly. PE parsing is
executed locally against handcrafted fixtures; Win32 helper answers are injected
in these tests. **No actual Windows helper execution or newly identified DLL/symbol
is claimed at this checkpoint.** CI must supply that evidence before a fix is
selected. Existing 47 UI tests and full root suites are reused from unchanged
source; the new saved desktop/Node/native-WK gate records are listed in the ignored
`wp05-windows-diagnostics-report.md`.

The phase-retention extension checkpoints helper script entry before input parsing,
input parsing, Add-Type compilation, architecture/search setup, DLL load/resource
mapping/path lookup, each name/ordinal lookup, and module cleanup. Each complete
JSONL record is flushed through the writer and file stream before the next boundary.
Module load/mapping results and individual symbol answers are persisted immediately;
a stalled later operation preserves their validated completed prefix. A last phase
only identifies the helper boundary reached, never the original child's cause.
A successful load awaiting its path creates no missing-module finding.

The Node reader caps progress at 4 MiB, 64 KiB per line and 32,768 records. It checks
closed record fields, machine agreement, requested modules/symbols, Win32 value
types and observation ordering. Truncated/invalid tails are removed from uploaded
JSONL, oversized files are rejected, and paths outside permitted metadata roots
are redacted. Saved batch fields `helperPhase`, `lastPublicModule`, `progressStatus`
and per-module `observationComplete` distinguish partial answers from complete
module observations. Original child status and the 12-second helper/45-second
scheduling bounds are preserved. Authorized optional static/version reads remain
separate and cannot erase loader answers.

The focused suite now contains 26 cases: the preceding 14, 11 additional behavior
cases for phase retention, partial/zero/completed observations, bounded malformed
progress, ordering and authorization, and one genuine helper test conditional on
Windows. A failure of that runtime test retains `native-*` evidence under
`RUNNER_TEMP/plur1bus-native-spike-run-helper-*` for the existing artifact upload.
Local macOS verification passes 25 cases and skips only that unavailable Windows
runtime test; PowerShell execution, hosted phase timings and native Windows
transport behavior require actual Windows evidence. Current commands and raw
logs are recorded in the ignored `wp05-windows-phases-report.md`.
