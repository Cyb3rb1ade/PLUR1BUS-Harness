# Owner decision (Claude on behalf of the owner): WP5 Windows cookie-database check — 2026-10-04

**Decision: option 1, with the conditions below.** The read-only zero-row check of the WebView2 cookie database may run
**after the browser process has really exited and before the shell deletes its own user-data folder (UDF)**.
The live checks stay mandatory.

Why: while it runs, WebView2 holds the `Cookies` SQLite file with an exclusive share mode. A read-only open from
another process then fails with a sharing violation by OS design, so a live row count is impossible on Windows. That
is not a weakness of the shell. Reading the file after the process has exited is at least as strong as a live read:
SQLite only releases the file once everything is flushed. The conditions below make sure nothing written during the
session is missed.

## Conditions (all required on Windows x64 and Windows ARM)
1. **Live, while the SPA webview runs:**
   - `CoreWebView2CookieManager.GetCookiesAsync("")` (all origins) returns zero cookies.
   - The secret scan over every readable file in the SPA's UDF finds no test marker. Locked files are listed by name
     in the test output, not silently skipped.
   - The native cookie query is the primary live check, and it must be zero.
2. **A canary is planted.** The test uses a mock harness that sets a cookie with a unique synthetic value
   (`CANARY-<random>`) through the proxy, so the cookie lands in the Rust jar. The page also tries
   `document.cookie = "CANARY-…"`. Without a canary, a zero-row result proves nothing.
3. **"Really exited" is checked, not assumed.** After closing the window, wait until every WebView2 browser process
   bound to that UDF has exited:
   - poll the process list for `msedgewebview2.exe` with that `--user-data-dir`, or wait on the environment's
     browser-process-exited event;
   - use a bounded wait (≤ 10 s) and fail with a clear error on timeout. Never fall back to reading anyway.
4. **The post-exit read covers SQLite side files:**
   - Open `Cookies` read-only with SQLite, which also applies an existing `-wal`, and assert zero rows in the
     `cookies` table.
   - Byte-scan `Cookies`, `Cookies-journal` and `Cookies-wal` (if present) for the canary value. Zero hits.
5. **Then cleanup:** delete the UDF and assert it is gone. Crash-leftover sweep at next start stays as decided before.
6. **macOS and Linux are unchanged:** zero files and live checks only.

## Reporting
- Keep the Accept name `no_cookie_database_in_app_dirs`.
- In the Accept table, mark the Windows rows "post-exit read (owner decision 2026-10-04)", and list this as a
  deviation in the status file with the reason above.

## Root CI
Your branch is behind `main`. `main` now contains #71, which fixes the macOS `python-host` budget failure in
`hosts/hermes`.
- Merge `main` into your branch with a normal merge commit, no rebase, then re-run.
- If root CI is still red, list each failing job with its first error line in the status file and the PR body. Do not
  touch core or Hermes; I will take those.

When all five targets are green under this decision, mark #65 ready, then start WP6 as already instructed.
