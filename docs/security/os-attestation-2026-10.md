# OS-backed attestation: design notes and threat model (#192, option C)

Status: implemented in `packages/core/src/attestation/` and `crates/plur1bus-attest`; user-facing description in
`docs/approvals.md` 3.2.1 and `docs/rbac.md`. This note records what the mechanism protects, what it does not, and what was
verified how.

## The problem it solves

Option A (#292) made a person on an unattested local connection T1, because an agent that can read `run/core.token` could
otherwise approve `shell.exec`, `fs.delete`, `pkg.change` ... for itself and mint a 90-day grant. The owner kept the promise that
a person can approve anything for up to 90 days: with ONE confirmation by the operating system, an approval is raised to T2 for
that one decision.

## What the confirmation proves

An OS dialog (Touch ID, the account password, Windows Hello, the UAC secure desktop, a polkit agent) can be answered by the
person at the machine, not by a process that merely holds the token. The core starts the helper itself and reads its answer
itself; nothing a client sends can reach or substitute for it. The answer counts for exactly one approval: it is bound to a
hash of the request id, action hash, capability, scope, delegable flag, agent and person, to a fresh single-use nonce and to a
60 s window, and the helper echoes both so the core can refuse a replay or a reply for something else.

## What it does not protect

| Risk | Status |
|---|---|
| The person confirms without reading | Text shows agent, capability and scope, never model-written text. Approval fatigue limits (`approvals.md` 3.4) apply. |
| **A replaced helper binary** | Pinned by file system (absolute path, regular file, not group/world-writable, root- or own-user-owned, in a directory with the same properties) **and by content**. A release build bakes the helper's SHA-256 (`PLUR1BUS_ATTEST_SHA256` at build time, passed to the core as an environment variable of the same name), on macOS the Apple team id its code signature must carry (`PLUR1BUS_ATTEST_TEAM_ID`, checked with `codesign --verify --strict --test-requirement`, no shell) and on Windows the Authenticode signer thumbprint (`PLUR1BUS_ATTEST_WIN_THUMBPRINT`, `Get-AuthenticodeSignature`, the path passed in the environment). The core checks before every start and once more after the reply: a changed file discards the answer. Any deviation, a malformed pin or a signature tool that cannot run is `unavailable`, with `reason` (`helper-hash-mismatch`, `helper-signature-invalid`, `helper-signature-unchecked`, `helper-unreadable`, `helper-pin-malformed`, `helper-changed-during-run`) in `attestation.result`; no dialog is shown. **Residual:** a dev build bakes no hash and is pinned by owner and mode only; the instant between the check and the `exec` of the path cannot be closed from Node, so an owner-level attacker who swaps the file and puts it back in time is not stopped. **Open:** the release workflow must set the three build variables and ship the helper in the signed release feed (the workflow is outside this change). |
| An agent driving the person's logged-in desktop (UI automation) clicking the dialog | Out of scope for this layer; `ui.control` is T2 and `os.privilege`, `remote.control` are T3. Touch ID cannot be clicked, a password prompt can only be typed by someone who knows it. |
| Headless, SSH, container | No helper or no agent: `attestation-unavailable`, the T1 limits stand. Not downgraded, not skipped. |
| Anything that needs T3 | Not liftable. Only an embedder attestation (`CoreOptions.rbac.attest`) reaches T3. |
| `grant.create` (a standing grant without an approval request) | Not covered; it stays `surface-untrusted` from T1. |

## Platform notes

- **macOS:** `LAContext.evaluatePolicy(.deviceOwnerAuthentication)` through `objc2-local-authentication`; a fresh context per
  request. Method `touch-id` when the Mac can evaluate the biometric-only policy, otherwise `macos-password`.
- **Windows:** `UserConsentVerifier.RequestVerificationAsync` (Hello). If Hello is not set up or not available, the helper starts
  itself elevated (`ShellExecuteExW` verb `runas`, argument `--consent-noop`) and treats a completed elevated start as the answer
  to the UAC consent prompt (method `uac`); a declined prompt is `cancelled`. Not exercised in CI.
- **Linux:** `pkcheck --action-id org.plur1bus.approve --process <pid> --allow-user-interaction --detail text <text>`, policy
  `auth_self`, no `_keep`. Exit 0 confirmed, 2 dismissed, 3 no agent. The helper looks for `pkcheck` only in fixed system
  directories (not on `$PATH`) and needs `WAYLAND_DISPLAY` or `DISPLAY`.

## How it is tested

CI runs no real dialogs. The core is tested against a Node script that speaks the helper protocol (success, cancel, timeout,
nonce replay, wrong action hash, stale time, crash, garbage, unavailable); the Rust crate tests the protocol, the per-OS code
mapping (`LAError`, Hello results, Win32 errors, `pkcheck` statuses) on every platform and the Linux flow against stand-in
`pkcheck` scripts. The Windows and Linux code is compiled (`cargo check`/`clippy`) for `x86_64-pc-windows-msvc` and
`x86_64-unknown-linux-gnu`. Interactive macOS and Windows checks are manual (see the pull request).
