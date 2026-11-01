# MM-3a Harness media implementation plan

**Goal:** Deliver bounded, authenticated channel uploads to the background media hook, expose selected-model capabilities and encoder readiness, and offer explicit ffmpeg setup without requiring the Rust media server.

**Base:** main `df525459`, independent of MM-1 and #820. Controller reserved RPC **1.20.0** on 2026-11-01. Only additive optional `capabilities` and `encoders` status fields are authorized. Update version references and generated artifacts together; keep the Node-derived engine contract 1.17.0 unchanged.

**Authority:** Owner work package R/MM-3a, E1/E2/E7/E8/E12 and continuation of 2026-11-01. Source audit: `/workspace/reports/mm3a-contract-audit-20261101.txt` (external working evidence, not a runtime dependency).

## Constraints

- Preserve all existing ChannelHost methods, required inbound fields, adapter rich payloads, transport size/count bounds and authorization semantics.
- Upload paths, owner, scope and provenance come from trusted host context. No caller-controlled filesystem paths or authority. Hook after private bytes and owner publication; never await captioning or embedding in a turn.
- Raw uploads use additive OutputStore APIs and a distinct manifest/namespace. Existing `media.output/1`, generated store APIs, engine contract and `--json` result meanings stay unchanged.
- Q8 on every platform, audio always q8; image budget 140, video frame budget 70; both global and per-agent audio.segmentSec maximum 30 as explicitly requested.
- ffmpeg is neither bundled, linked nor downloaded by this project. Controller ruling E2/M4 supersedes the original installation proposal: availability detection and displayed manual package-manager commands only. The Harness never invokes sudo, a package manager or elevation, even as root; missing ffmpeg leaves photos available.
- Tests use gated fake package managers, generated test files and existing bounded transport fixtures. No real package installation, no skipped or disabled tests, no Jina-derived output.
- No #820 edits or pushes, CI polling, force-push, rebase or amend. One MM-3a PR; controller merges.

## Work and verification

1. **Raw upload storage:** implement `putUploaded`, `getUploaded`, `deleteUploaded` beside unchanged generated APIs. Validate image/audio/video magic and MIME, authoritative byte size, bounded count/total, private modes, atomic staging, hash and quota; runtime tests pin corrupt input, failed staging and no accidental generation/transcode.
2. **Channel ingress:** Telegram first, then the five existing media-aware adapters. Add compatible optional framework attachments; preserve rich consumers. Router authenticates identity and selected agent before saving. Test attachment-only/text+attachment, unlinked/disabled/denied users, duplicate IDs and a blocked background encoder that never blocks acknowledgement.
3. **Composition:** wire the trusted upload callback to the shared store and media hook even when no generation provider is configured. Publish the existing owner record before exactly one `onUploaded`; keep agent-private scope and D19 origin. Test through actual router/composition boundaries.
4. **Catalog/config/status:** add fixed local EG2 capability catalog, awaited production validation for effective global/agent settings and offline static validation. Add optional status fields under RPC 1.20.0; test old responses without them. Preserve method introduction versions, add field x-since, update all current version references and regenerate types/docs/fixtures.
5. **Setup/1staid/UI:** detect ffmpeg, display manual brew/apt/dnf/pacman/zypper/winget guidance without executing a manager or sudo. Add media.ffmpeg read-only check, manual-backfill selection and localized model capabilities. Encoder download bytes and per-photo timing require verified evidence; unavailable measurements must be reported, never invented.
6. **Review/PR:** meaningful red-green tests in each slice, final package tests/typecheck/lint/docs checks and affected Rust tests, independent whole-change review, commit generated outputs and open/attach one PR. Do not present a stubbed index as working Rust media indexing; MM-2b/MM-3b own that binding.
