# Local host tools and sandbox status

Host tools run locally under the harness permission policy. `exec.run` and host subprocesses require an OS sandbox by default. Missing isolation refuses the call; an approval alone cannot substitute for isolation.

Doctor reports the backend and its strength. macOS uses deprecated `sandbox-exec` (Seatbelt); current policy denies forking and uses a sampled memory watchdog. Linux requires bubblewrap; writable policies currently refuse execution pending credential-name enforcement. Windows restricted-token/Job Object support is not implemented, so sandbox-required processes remain unavailable. These are Draft capabilities, not complete cross-platform support.

Only the owner can set `tools.sandbox.required=false`. This explicitly permits unsandboxed execution, is audited before every process launch, and produces a NOT SANDBOXED warning in Doctor. Keep it enabled unless you intend that loss of isolation. Some hostctl, clipboard and OS service routes remain refused with required=true.

Opening/focusing an app needs a one-time `apps.launch` approval. Quitting uses `proc.signal` approval and requests graceful close. Package install/remove/upgrade currently return dry-run plans; they do not change installed packages. Password and elevation wrappers are refused without a supported T3 route.

Untrusted web, foreign MCP/peer tool results and outside-root file results taint the turn. Existing policy then suspends standing grants for external/taint-sensitive actions; a new valid one-time approval is still possible. This state ends with the turn.

Models show “limited tool use” below 95% on the host-eval corpus or on a policy escape. Missing, stale (over seven days), wrong-corpus and synthetic-only evidence is “not evaluated”. Doctor shows default-model coverage separately. A successful Fake Provider regression run does not qualify a real model.

The release default-model inventory is still awaiting owner review; the release gate stays closed until each listed default has matching recorded/live evidence. Nightly live tool choice runs against safe scratch/fake OS ports, never your desktop. It does not replace per-OS sandbox acceptance tests.
