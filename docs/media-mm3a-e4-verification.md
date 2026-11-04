# MM-3a: E4 verification for PR #866

Recorded on 2026-11-01 against the re-review of `fc47ccd1`. This historical evidence covers
the three E4 fixes. It does not establish later Engine integration, media inference or the E5 changes.

## Store and integration checks

- Prune/recovery do not read or hash payload bytes under the store lock. The deterministic read spy stays
  at zero; same-size bit corruption remains stored, and `getUploaded` still refuses the incorrect hash.
- The concurrent test fills a configured quota above 99% with four 4 MiB uploads. A second store publishes
  an image during prune with a 200 ms lock deadline. A test-only seam delays payload reads by 300 ms:
  the old scan fails and the metadata path passes. This is a deterministic regression test, not a
  1 GiB throughput benchmark.
- Injected EIO/EACCES/EMFILE preserve bytes and owner bindings; warnings contain only `storage-unavailable`.
  Later sweeps can still remove proven corruption or expired uploads. The nine new store regressions
  failed before the fix and passed afterwards.
- Author-reported results: store focus 33/33; full Media 465 passed, 0 failed, 2 existing CoreML platform skips;
  production factory 3/3; Core media integration 101/101, without failures or skips. The later independent
  re-review ran 97 Core cases across its selected files; it did not independently establish the 101-case count.
- Global TypeScript checking, `pnpm lint` (163 passed, 0 failed, 3 existing TODOs) and `pnpm docs:check`
  passed in the author's run. No new RPC/schema/contract version.

## 20 consecutive complete browser-file runs

The product fix keeps Save disabled after a successful `config.set` until the reload is accepted.
The regression deliberately holds `config.get` and checks another click without a second write,
error handling and a refresh with the same revision.

Node 24.21.0; actual browser Chromium 154.0.8037.57 on Linux. Each run starts a new Node process
for the complete `media-capabilities.test.ts`, serially, stopping at the first failure, without
test or process retries. Source hashes were checked before each run. The existing local system-browser
override was active; this is not a passing run with the pinned CI browser. Its preceding download
returned HTTP 403. The required-browser guard and CI pin remain in place.

```bash
for mm_run in {01..20}; do
  PLUR1BUS_WEB_BROWSER= PLUR1BUS_WEB_E2E_REQUIRED= PLUR1BUS_CHROMIUM=/usr/bin/chromium \
    node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning \
    --test --test-reporter=tap --test-concurrency=1 --test-timeout=120000 \
    packages/web/test/media-capabilities.test.ts > "run-$mm_run.log" 2>&1 || exit 1
done
```

Interval (UTC): `2026-11-01T19:20:01.674Z` to `2026-11-01T19:23:46.212Z`.

| Run | Passed | Failed / skipped / TODO / cancelled | Exit |
|---:|---:|---:|---:|
| 01 | 16 | 0 / 0 / 0 / 0 | 0 |
| 02 | 16 | 0 / 0 / 0 / 0 | 0 |
| 03 | 16 | 0 / 0 / 0 / 0 | 0 |
| 04 | 16 | 0 / 0 / 0 / 0 | 0 |
| 05 | 16 | 0 / 0 / 0 / 0 | 0 |
| 06 | 16 | 0 / 0 / 0 / 0 | 0 |
| 07 | 16 | 0 / 0 / 0 / 0 | 0 |
| 08 | 16 | 0 / 0 / 0 / 0 | 0 |
| 09 | 16 | 0 / 0 / 0 / 0 | 0 |
| 10 | 16 | 0 / 0 / 0 / 0 | 0 |
| 11 | 16 | 0 / 0 / 0 / 0 | 0 |
| 12 | 16 | 0 / 0 / 0 / 0 | 0 |
| 13 | 16 | 0 / 0 / 0 / 0 | 0 |
| 14 | 16 | 0 / 0 / 0 / 0 | 0 |
| 15 | 16 | 0 / 0 / 0 / 0 | 0 |
| 16 | 16 | 0 / 0 / 0 / 0 | 0 |
| 17 | 16 | 0 / 0 / 0 / 0 | 0 |
| 18 | 16 | 0 / 0 / 0 / 0 | 0 |
| 19 | 16 | 0 / 0 / 0 / 0 | 0 |
| 20 | 16 | 0 / 0 / 0 / 0 | 0 |

**Total: 320 passed; no failures, skips, TODOs, cancellations or retries.**

Source SHA-256 throughout the series:

| File | SHA-256 |
|---|---|
| `packages/web/src/pages/media-search/override.ts` | `05f11303d5fd04a3fbfb90c7e35714670594b1eafb7031d3534c85344221df6e` |
| `packages/web/test/media-capabilities.test.ts` | `09e2c5d9b8badc0139406a8458fab1d8e98f4893271394bb893150ded6c6c378` |
| `packages/web/src/pages/common/load.ts` | `d7d77876679284d979db6eace4f3f95a4220e33e7c980f66a972786e2038dfc8` |

The command, counters and source hashes above are the committed aggregate evidence for the author's
20-run series in [PR #866](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/866). Raw TAP logs were
held in the author's workspace and are not included in this repository; this document does not supply
those raw logs. Before the recorded series, an expanded error-path test failed on an ambiguous Retry
button selector, which was narrowed to the affected error region. No failure occurred within the
recorded 20-run series. Acceptance with the pinned required CI browser remains separate.
