# M2 criterion 17 — Never-list evidence (2026-10-16)

## Inventory and policy ownership

`scripts/foreign-client-fingerprints.mjs` owns the source scan catalogue, with D110 §2.5 and provider-matrix §4 / ADR-005 §6.3 sources. It denies the named public Codex client ID, concrete issued `oaiapp_…` registrations, the login override, request originator/flow fingerprints and official CLI system-prompt introductions. Public protocol identifiers are policy data, never credentials. Product tests use marker registrations; no product source exemption is currently needed. This is evidence for the enumerated signatures, not a semantic proof that arbitrary obfuscation or an unknown future client ID cannot exist.

`lint-hygiene.mjs` runs HYG-014 independently of the importer hygiene exemptions, on staged blobs and working files under packages, crates, desktop and apps/desktop. HYG-015 rejects OpenAI-named secret references and reusable secret inheritance outside `nightly.yml`'s exact `openai-live` job, requiring `environment: provider-live` and the explicit workflow-dispatch + owner-variable gate. No live OpenAI job is added here; no OpenAI credential is used by existing workflows. The scanner intentionally does not infer arbitrary aliases for secrets or analyse scripts for network destinations.

The existing `host-tools/denylist.ts::denyEntriesFor` remains the single D109 path-policy source used by tool composition and host tools; no second deny-list is introduced. Additions cover Claude Code, Gemini and agy/Antigravity roots and overrides, plus the previously missing source-host home/state overrides and Windows app-data paths. Existing roots and matching semantics remain intact. Tests exercise darwin/linux/win32 path spellings, nested records, case folding, environment overrides and near-miss allowed paths on every runner. This does not claim to inspect OS keychain contents.

## Actual import path / handoff to agy

Minimal importer fix, committed separately: `importOpenclaw` recognises the retired route ID and OpenAI OAuth metadata in the normal parsed source config. It delegates to D110's existing `importedProfile` helper and persists `disabledAuthProfiles` in the regular import report. The CLI render shows disabled status, reason, supported Sign in with ChatGPT replacement, API-key and official-client-over-ACP alternatives. No profile is registered as usable; `validateProfile` continues to refuse the old route ID. No foreign credential store is parsed, copied or refreshed. The profile is visible in the import report, not added as an active auth-engine profile.

Test: `packages/core/test/import/route3-disabled.test.ts` drives the real apply path, reads the persisted report, checks the terminal rendering and supported alternatives, refuses activation, verifies that the source credential file is unchanged and no marker reaches target config/report/output.

## Validation

`host-tools/denylist.test.ts`, `import/route3-disabled.test.ts`, `openai-auth/auth.test.ts`, source/workflow positive and negative controls in `scripts/never-list.test.mjs`, and `lint-hygiene.test.mjs` are the named evidence. The new lint tests are included in the existing `--self-test` path. Gating tests remain offline; no CI polling or live calls.
