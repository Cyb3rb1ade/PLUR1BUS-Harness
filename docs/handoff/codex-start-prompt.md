# Codex start prompt: PLUR1BUS desktop app shell

Paste this as the first message of a Codex session in a checkout of `Cyb3rb1ade/PLUR1BUS-Harness`.

---

You are building the **PLUR1BUS desktop app shell** (Tauri 2.12, `apps/desktop/`): the app frame and its own
functions, not the harness features that are wired into it later. Your full brief is
`docs/handoff/2026-09-30-desktop-shell-codex.md`. Read it first, end to end. It points to the specs that are
binding.

Rules:

1. **Order.** Work through the work packages in §5 in that order. WP1–WP6 are the priority subset. Every WP
   ends in its own draft PR that is useful even if nothing after it lands. Do not start a WP until the one
   before it has a green draft PR.
2. **Git.** Use one branch per WP, named `feat/desktop-shell-wpNN-<slug>`. Cut it from `origin/main` when
   the previous WP has merged. Otherwise stack it on the previous WP's branch and name that base in the PR.
   Commit only with
   `git -c user.name=Cyb3rb1ade -c user.email=84099452+Cyb3rb1ade@users.noreply.github.com commit`.
   - Never amend, never force-push, never merge, and never change git config. The owner merges.
   - Open every PR as a **draft**.
3. **Green before every push.** Both of these must pass:
   - the root Green: `pnpm lint` and the rest of §2.4;
   - the desktop Green in §2.4.
   If something cannot run in your environment, say so in the PR and in the status file. Never claim a pass
   you did not see.
4. **Hard rules (§3). You may not break these:**
   - no secrets or real user data anywhere;
   - no telemetry, no remote hosting, no vendor relay;
   - tests use seams, never a real home directory, the real keychain or a real service manager;
   - the device token lives only in the OS keychain and Rust memory;
   - pinned dependencies;
   - no `tauri-plugin-shell`, `-fs`, `-http`, `-dialog` or `-opener`;
   - no Input Monitoring;
   - never type passwords;
   - OS permissions are asked just in time.
5. **Scope.** The harness API does not exist yet (M3 is not built). Build against the provisional contract in
   §6 and the mock harness from WP2.
   - Do not implement harness features: no API server in `packages/`, no `plur1bus init`, no container image
     for the real harness.
   - Do not implement host tools (D106), computer use, the CEF or WebView2 browser panel, or WebMCP.
   - Where the spec and the design boards disagree (C13–C18, §7.4), implement the default written there.
6. **Report.** After each WP, update `docs/handoff/status/desktop-shell.md` (format in §10) and write the PR
   description from the template in §10. Record every deviation, skipped test and open question there, so
   Claude can review and continue.
7. If a rule here conflicts with the brief, the brief wins. If the brief conflicts with a spec, the spec wins,
   except where the brief names a default for an open conflict. List every such case in the status file.
