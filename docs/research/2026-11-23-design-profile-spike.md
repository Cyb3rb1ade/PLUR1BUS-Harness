# DP0 design-profile spike

Choose **Path B, a PLUR1BUS-owned extractor**. Reconsider Path A when a release old enough to pin clears the production dependency gate and can return isolated theme and viewport profiles with reliable semantic roles, bounded egress and cancellation.

This spike covers the D132 Part 1 handoff on 2026-11-23 at Harness baseline `bd7cabfba1`. The machine was an Apple M5 Pro with 48 GiB RAM and macOS 27.3 (arm64), using Node 24.21.0 and npm 11.19.0. The concurrent local workload was left running. All runtime changes, dependencies, browsers and snapshots were confined to a disposable workspace. The retained repository artifacts are this report and the scoring script.

## Release and supply chain

The [npm registry timeline](https://registry.npmjs.org/dembrandt) listed 81 published versions. The newest eligible release at the 14-day cutoff on 2026-11-09 was **`dembrandt@0.39.2`**, published 2026-10-11 at 14:07:40 UTC under MIT. The [GitHub tag `v0.39.2`](https://github.com/dembrandt/dembrandt/releases/tag/v0.39.2) was published earlier that day at 14:05:02 UTC. The [Action at that tag](https://github.com/dembrandt/dembrandt/blob/v0.39.2/action.yml) defaults its separate `cli-version` input to the same npm version. `0.11.0` was an older npm release from 2026-04-11. npm `0.40.0` and `0.40.1` shipped on November 18, and `0.40.2` and latest `0.41.0` on November 19. All four were six days old or younger at the time of selection.

The downloaded tarball and npm lock both matched the registry's SHA-512 integrity value.

```text
sha512-p/YDQMIApb3rj7zBH0maabVxiBl+Pn4UyPK6qNqEUXbFYlNu8LGD3cbMMhpffkElJLvOYwUU1NLxu/voEhi4EA==
```

- The first install was `npm install --ignore-scripts --no-audit --no-fund --save-exact dembrandt@0.39.2`. It resolved 130 installed packages. The only consumer lifecycle hook marked in the lock was optional `onnxruntime-node@1.29.0` postinstall, `node ./script/install`. Its platform table requests no additional files on Darwin arm64. The Linux GPU manifest can download from NuGet feeds. The hook was left disabled. Dembrandt's own registry manifest lists maintainer-side `prepare` and `prepublishOnly` build scripts, and npm installed the packed `dist/` files.
- The only install-stage program run from the package was its explicit `install-browser` command. It invoked the bundled Playwright Core 1.63.0 installer, which downloaded Chrome for Testing and Headless Shell 153.0.8010.12 (revision 1243) and FFmpeg (revision 1011) from the Playwright CDN into a private `PLAYWRIGHT_BROWSERS_PATH`. The Chromium profile, temp files, caches and npm configuration were also redirected into the workspace. No ONNX inference ran. The browser artifact licence notices and other target platforms were outside the npm licence inventory.
- Lockfile licence inventory by installation path was 115 MIT (including Dembrandt), 9 ISC, 3 BSD-3-Clause, 1 BSD-2-Clause, 1 Apache-2.0 (Playwright Core), and 1 MIT OR CC0-1.0 (`type-fest@0.20.2`). Every resolved package supplied a licence in the lock. There were no copyleft declarations in that inventory.
- `npm audit --json` returned three High **package findings**, with zero Critical, Moderate or Low. It named `@modelcontextprotocol/sdk@1.30.0`, `zod@4.5.4` and the direct `dembrandt` entry that aggregates those dependency findings. npm proposed `dembrandt@0.41.0`, which was still inside the release-age window and was not run. The observed tree fails the [Harness production High/Critical gate](../dependency-policy.md) if adopted. The audit is a dependency result. Reachability of individual advisories through this CLI/MCP configuration was not assessed. [SDK advisory 1](https://github.com/advisories/GHSA-6qxp-vccf-f47h), [SDK advisory 2](https://github.com/advisories/GHSA-22jm-h49p-29qw), [SDK advisory 3](https://github.com/advisories/GHSA-46jr-4wx8-v453), [SDK advisory 4](https://github.com/advisories/GHSA-rvq5-wwqv-78pq), [SDK advisory 5](https://github.com/advisories/GHSA-f897-62hf-6gxq), [SDK advisory 6](https://github.com/advisories/GHSA-6prh-2h8m-c8cw), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

## (a) Loopback benchmark against Glow

The benchmark rendered the actual Web UI build on loopback. It used [`packages/web/build.ts`](../../packages/web/build.ts) in the disposable source copy and the [mock HTTP server](../../packages/web/test/mock-server.ts) used by [`test/shots.ts`](../../packages/web/test/shots.ts). The web build used a local build of the config-schema policy and source-only shared helpers. The anonymous Sign in and First-run setup routes provided two live component trees with lazy bundles and real CSS. The DOM references waited for the route's input to appear. No sign-in or account creation ran. Authenticated pages were outside coverage.

The published package defaults override Chromium's automation signal, identity and locale. All browser launches in this spike used a disposable edit that removed the `AutomationControlled` override, synthetic Windows user agent, screen, locale, time zone and Accept-Language overrides. The main-pass adjustment set the requested color scheme and viewport only. Another temporary edit supplied the recording proxy on Chromium launch. The extraction algorithms and release dependencies stayed as published. These results describe that scoped runtime and do not validate the unmodified executable. [CLI launch](https://github.com/dembrandt/dembrandt/blob/v0.39.2/index.ts), [browser context defaults](https://github.com/dembrandt/dembrandt/blob/v0.39.2/lib/extractors/context-config.ts), [MCP launch](https://github.com/dembrandt/dembrandt/blob/v0.39.2/lib/mcp/options.ts).

The [scoring script](../../scripts/research/design-profile/score.mjs) compares sets from [Glow `tokens.css`](../../packages/web/src/styles/tokens.css) against a raw extraction. Named colors require the same custom property and canonical RGBA value, including alpha to three decimal places. The four predeclared inferred-role mappings are background to `--bg`, text to `--ink`, primary to `--primary-bg`, and accent to `--accent`. The font check compares first family names and excludes fallback stacks. Glow declares three font families and a 12 px `--gap`. Control heights and layout widths were outside spacing. Glow defines no font-size, font-weight or radius tokens, so those three categories have no Glow denominator.

The table reports recall / precision. Each **light and dark** extraction used 1920 × 1080 (desktop) or 390 × 844 (mobile-width), with one independent CLI run per cell. The theme was active from initial navigation. There was no mobile device identity emulation.

| Route | Theme | Viewport | Named colors | Inferred color roles | Font families | Font sizes | Weights | Radii | Spacing |
|---|---|---|---|---|---|---|---|---|---|
| Sign in | Light | Desktop | 88.5% / 100% | 50% / 66.7% | 33.3% / 100% | — | — | — | 0% / 0% |
| Sign in | Dark | Desktop | 88.5% / 100% | 50% / 66.7% | 33.3% / 100% | — | — | — | 0% / 0% |
| Sign in | Light | Mobile | 88.5% / 100% | 50% / 66.7% | 33.3% / 100% | — | — | — | 0% / 0% |
| Sign in | Dark | Mobile | 88.5% / 100% | 50% / 66.7% | 33.3% / 100% | — | — | — | 0% / 0% |
| Setup | Light | Desktop | 88.5% / 100% | 75% / 100% | 33.3% / 100% | — | — | — | 100% / 14.3% |
| Setup | Dark | Desktop | 88.5% / 100% | 75% / 100% | 33.3% / 100% | — | — | — | 100% / 14.3% |
| Setup | Light | Mobile | 88.5% / 100% | 75% / 100% | 33.3% / 100% | — | — | — | 100% / 20% |
| Setup | Dark | Mobile | 88.5% / 100% | 75% / 100% | 33.3% / 100% | — | — | — | 100% / 20% |

All eight runs returned 23/26 named colors. The three missing names were `--scrim`, `--info-bg` and `--info-ink`. On Sign in, the semantic primary algorithm chose the red accent over the neutral primary action. Neither route emitted `accent` in the semantic map. The render used system fallback fonts because the Glow font binaries are absent from the repo. No font binaries were fetched.

For categories without an authored denominator, a separate Playwright pass inventoried the visible DOM in the same theme and viewport. Families, sizes and weights came from rendered text and controls. Radii came from all four corners and spacing from nonzero computed margins, padding and row/column gaps. This pass is a route-level reference and includes computed layout lengths. Dembrandt samples a different element set, includes other findings such as borders in its spacing output, and groups sizes and weights. The script uses exact distinct-value matches. Counts and precision/recall in this comparison measure agreement with that inventory.

The result below groups light and dark only where they produced identical counts. Each cell is recall / precision with the same viewport and route on both sides.

| Route | Viewport | Font families | Font sizes | Weights | Radii | Spacing |
|---|---|---|---|---|---|---|
| Sign in | Desktop and mobile | 50% / 100% | 50% / 100% | 100% / 100% | 100% / 100% | 50% / 60% |
| Setup | Desktop | 100% / 100% | 100% / 100% | 100% / 100% | 100% / 100% | 63.6% / 100% |
| Setup | Mobile | 100% / 100% | 100% / 100% | 100% / 100% | 100% / 100% | 62.5% / 100% |

For example, Sign in contained two visible first-family declarations. Dembrandt emitted Atkinson Hyperlegible Next and listed the wordmark family Lilita One as filtered. Setup spacing matched 7/11 distinct DOM values at desktop and 5/8 at mobile width.

The built-in `--dark-mode --mobile` smoke produced 11 palette entries, including five tagged `dark-mode`, and reported 1920 × 1080/light as the initial context. It did not add a mobile-only color in this route. The named background stayed light while the inferred background became dark. The late dark pass merges colors, buttons and links and updates semantic colors. The mobile pass merges palette values and restores the wide viewport. Typography, radii and spacing had already been extracted at desktop/light. Separate initial contexts were necessary for a complete profile per cell. [Upstream extraction passes](https://github.com/dembrandt/dembrandt/blob/v0.39.2/lib/extractors/index.ts).

To reproduce a score from the retained raw data, run the following at the repository root.

```sh
node scripts/research/design-profile/score.mjs packages/web/src/styles/tokens.css \
  ~/worktrees/reviews/dp0/roh/logs/login-light-desktop.json light \
  ~/worktrees/reviews/dp0/roh/logs/dom-login-light-desktop.json
```

## (b) Owner pages

The local allowlist contained **0 URLs**. There were no Owner-page requests, screenshots or extractions. Three-run stability, confidence distributions, external dark-mode behavior and externally lazy-loaded content were not measured. The two anonymous Web UI routes in (a) loaded their own chunks over loopback.

## (c) Drift

The fixture served the same built Sign in page with one temporary CSS override at a time and with all four overrides. An independent computed-style read verified each edit. The reference was a fresh light/desktop render. The DTCG file contained 26 light Glow colors, three independently observed baseline radii, four observed baseline font sizes and the 12 px Glow gap. `--compare` used the unmodified extraction. `--tokens` used the DTCG file with `--max-off-token 0`. Both ran in each invocation, and the JSON exposes their outcomes individually. `--wcag` produced an additional diagnostic.

| Variant | Independently verified change | Compare score / gate | Off-token values / gate | Process exit |
|---|---|---|---|---|
| Unchanged repeat | Same CSS | 0 / pass | 0 / pass | 0 |
| Hardcoded color | Card background `#ffffff` → `#22a468` | 0 / pass | 1 color / fail | 1 |
| Wrong radius | Card corner 14 px → 47 px | 0 / pass | 1 radius / fail | 1 |
| Contrast fault | Lead text `#4a4a54` → `#f8f8f8` on white | 0 / pass | 0 / pass | 0 |
| Displaced spacing | Card padding 28 px → 57 px | 7 / pass | 0 / pass | 0 |
| All four | All edits applied | 7 / pass | 1 color and 1 radius / fail | 1 |

The combined gate caught **2/4** individual mutations with **0** false positives in the one unchanged repeat. The spacing change was visible in the compare diff as removal of 28 px and addition of 57 px, below the gate's threshold of 10. Token conformance covers colors, corner radii and font sizes. Its color match allows ΔE2000 up to 2.3 and does not evaluate the text/background relationship. The standalone contrast edit changed the WCAG ratio from 8.75:1 to **1.06:1** and still exited 0. The color edit also created an incidental 2.74:1 lead-text pair. A product contrast gate needs to act on the WCAG pairs separately. [Conformance implementation](https://github.com/dembrandt/dembrandt/blob/v0.39.2/lib/token-conformance.ts), [drift implementation](https://github.com/dembrandt/dembrandt/blob/v0.39.2/lib/drift.ts).

## (d) Seatbelt

`/usr/bin/sandbox-exec` ran the patched CLI under a profile that denied file writes outside the disposable directory, denied network operations by default and permitted outbound sockets only when the remote matched `localhost:*`. A Node control got HTTP 200 from the loopback fixture and wrote inside the directory. Writes outside it, an outbound socket to a numeric TEST-NET address and binding a wildcard TCP listener each failed with `EPERM`. An early profile with an explicit loopback bind rule allowed the wildcard bind; the final profile omitted inbound and bind exceptions.

The final profile extracted the Sign in route both directly and through the loopback proxy, exit **0** in 16.62 s and 16.60 s respectively. The direct run also wrote a screenshot inside the workspace. The enforced `robots.txt` disallow probe exited **4** before requesting the disallowed document. The probe kept Playwright's shipped launch default and did not pass `--no-sandbox`. Playwright Core 1.63.0 itself adds that Chromium argument unless the caller explicitly enables `chromiumSandbox`, so this result establishes the outer Seatbelt profile only. The prototype profile permits normal reads and process execution. It does not establish an isolation policy for arbitrary external pages. Linux bubblewrap, Windows and renderer sandbox nesting were not tested.

## (e) Network, telemetry and cost

A local HTTP/CONNECT proxy logged destinations separately from the target server's request log. Chromium received the proxy through its launch configuration and Node fetch used the same proxy through `NODE_USE_ENV_PROXY=1`. The proxy forwarded only to the single loopback fixture. A separate control request produced a denied CONNECT entry for a reserved .invalid hostname, with no forwarding. In the eight main extraction runs it logged **216** requests/tunnels (20 per Sign in run and 34 per Setup run), all to that fixture, with **0** other destinations. The strict Seatbelt+proxy repeat logged another **20**, all to the fixture. The direct Seatbelt repeat reached the same fixture with the non-loopback socket denied by the control. Browsing other sites, bypass paths such as OS-brokered traffic, DNS observation and packet capture were outside this measurement.

The no-key CLI runs showed no Dembrandt telemetry connection through the proxy. In the audited source the upload path posts the full snapshot to `/api/extractions` when `--key` or `DEMBRANDT_KEY` is present. Omit both at the launch boundary. `DEMBRANDT_NO_HINTS=1` or `CI` suppresses a separate local hint counter. The counter is not a network opt-out, and the explicit upload was not exercised. Browser bootstrap contacted the Playwright CDN during installation as recorded above. Node also fetches robots rules and can fetch target branding assets directly, so controlling the browser alone is insufficient. [Cloud upload](https://github.com/dembrandt/dembrandt/blob/v0.39.2/index.ts), [local hint state](https://github.com/dembrandt/dembrandt/blob/v0.39.2/lib/cli-state.ts), [asset fetches](https://github.com/dembrandt/dembrandt/blob/v0.39.2/lib/extractors/logo.ts).

| Route | Fresh CLI processes | Wall time | Peak RSS reported by `/usr/bin/time -l` |
|---|---:|---:|---:|
| Sign in | 4 | 16.48–16.68 s | 195.2–196.6 MiB |
| First-run setup | 4 | 15.91–15.96 s | 194.7–196.9 MiB |

These are elapsed times from fresh launches on a shared machine, excluding the two-second interval between invocations. The macOS `maximum resident set size` field is quoted as reported and is not a simultaneously sampled process-tree total. `du -sk` before the browser install showed **328.0 MiB** of npm modules, including 283.4 MiB for optional ONNX Runtime. Adding the **557.0 MiB** browser directory gave **885.1 MiB**, excluding npm caches, the Web UI and raw artifacts. The browser alone uses more disk than the resolved Node tree.

## (f) MCP over stdio

A disposable NDJSON client started `dembrandt mcp` under the final Seatbelt profile. It sent raw JSON-RPC requests and saved every input and output line. The Harness client and Core never ran.

| Probe | Observed |
|---|---|
| Discovery and legacy handshake | `server/discover` returned `-32601` in 138 ms. `initialize` negotiated `2025-11-25` in 2 ms on that process, and `tools/list` returned in 3 ms. |
| Tool list and schemas | **21** tools, each with an input schema and **0** output schemas. Eight extraction tools exposed URL, sync/slow, viewport/theme, authentication overrides, user agent, sandbox override and discovery options. Full schemas are in the local raw data. The largest stdout frame was the tool list at **34,447 bytes**. All stdout lines parsed, with zero stderr bytes on this run. |
| Complete extraction | `get_design_tokens` returned a job ID in **10 ms**. Polling `get_job_status` produced `completed` after **17.15 s**. The compact profile was **12,761 bytes**, carried as JSON inside a text content block. Its wire frame was **25,706 bytes**. |
| Request cancellation | A synchronous delayed extraction received `notifications/cancelled` 1.2 s after the call. Subsequent `ping` answered in 1 ms. There was no response to the cancelled request within the probe's 20 s window. The fixture still finished sending the delayed document over its open socket. |
| Running-job cancellation | `cancel_job` returned `cancelled: false` for a job confirmed running. It still reported running throughout the 30 s probe and stdin EOF did not shut down the busy server within 3 s. The probe terminated its own process. The upstream queue can cancel only while queued, and the extraction handler does not pass the request signal into browser work. Queued-job cancellation and eventual completion of the slow fixture were not measured. |
| Unreachable site | A separate request targeted a closed loopback port. The server returned an MCP tool error in **36 ms**, with `isError: true` and `robots.txt could not be read`. Under enforcement it stopped before launching a browser for that request. |

The legacy wire format and measured frames fit the [Harness stdio transport](../../packages/core/src/mcp/stdio.ts). The source tries modern discovery first and falls back on method-not-found, which was the observed response. The [connection defaults](../../packages/core/src/mcp/types.ts) are 30 s connect, 15 s list, 60 s per call, 2 s close grace and 1 MiB of result content. The transport separately limits a frame to 1 MiB. The measured fixture fits those limits. Async acknowledgement and polling are separate calls, `slow` can outlast a synchronous call, and a complex page could exceed the frame cap before the result budget can trim it. Those larger pages were outside the spike. [Connection and fallback](../../packages/core/src/mcp/connection.ts), [provenance and result shaping](../../packages/core/src/mcp/provenance.ts).

`providers.mcp.servers` supplies the legacy manual server definitions, and `providers.mcp.allowedCommands` feeds the direct, no-shell spawn policy. An explicit allowlisted executable and fixed arguments can start a replacement worker. The current Harness can abandon an RPC call through its signal/deadline and can terminate the process group when it closes the transport. Dembrandt's running jobs require closing a dedicated worker to stop them promptly. A typed adapter would also need to parse and validate the text payload, own polling and isolate each job so a forced shutdown cannot discard another job. [Registration](../../packages/core/src/mcp/extensions.ts), [command policy wiring](../../packages/core/src/composition/extensions.ts), [definition validator](../../packages/core/src/mcp/config.ts), [upstream handler and schemas](https://github.com/dembrandt/dembrandt/blob/v0.39.2/mcp-server.ts), [upstream queue](https://github.com/dembrandt/dembrandt/blob/v0.39.2/lib/mcp/jobs.ts).

## Product argument and environment policy

Keep a dedicated executable and argv constructor at the sidecar launch boundary. Use a fixed absolute executable and an end-of-options separator before a validated HTTP(S) URL. The job can supply a URL and a typed theme or viewport choice. The dispatcher owns output format, timeouts and a job directory. Do not expose a general extra-args field or pass a shell string. Apply the same policy before any MCP tool is exposed, since `mcp` alone leaves the extraction fields in the tool schemas.

| Block at construction | Inputs |
|---|---|
| Anti-detection and spoofing | `--stealth`, `--user-agent`, `--locale`, `--timezone`, `--accept-language`, `--screen-size`, and the implicit launch/context defaults described in (a). Keep viewport and theme as controlled render settings. |
| Credentials and interaction | `--login`, `--cookie`, `--cookie-file`, `--basic-auth`, `--header`, `--save-storage-state`, headed fallback and any login/CAPTCHA workaround. |
| Cloud or experimental features | `--key`, `--ai`, remote App baselines and any unknown option. Omit `DEMBRANDT_KEY` and `DEMBRANDT_API_URL` from the child environment. |
| Discovery and untrusted paths | `--crawl`, `--sitemap`, positional extra URLs, user-selected output/baseline/report files and `--approve`. A separately authorized multi-page job would need per-origin and per-redirect checks, a cap of five subpages and a minimum two seconds between navigations. |
| Runtime overrides | `--no-sandbox`, `DEMBRANDT_NO_SANDBOX`, caller-controlled CDP or browser paths and runtime install commands. Enforce robots and unattended/headless execution. Allow only the required environment variables and control DNS, redirects, font requests and all egress outside the argv layer. |

The command allowlist in [Core MCP config](../../packages/core/src/mcp/config.ts) governs which executable starts. A design-profile action would also need to constrain tool inputs, result shape and lifecycle. The wrapper policy has a cost even if a future pin meets the supply-chain gate.

## Owner questions

1. Should the first product profile expose owner-authored token names and inferred semantic roles as separate fields, with provenance and confidence for each?
2. Which routes, minimum recall/precision and acceptable drift miss rates should gate product acceptance, especially for contrast and for authenticated UI states?
3. What is the intended network policy for approved sites and their asset origins, and can the next spike use an allowlist with CMS, static and shop examples?
4. Should a future clean sidecar release be reconsidered after the 14-day window, and is hard cancellation of a running browser required on every supported OS?

Raw versions, lockfile, audit, measurements, screenshots and disposable probe code are retained locally under `~/worktrees/reviews/dp0/roh/`.
