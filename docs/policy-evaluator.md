# Policy evaluator (D109, part 1)

`packages/core/src/policy/` is the pure decision function of the D109 permission model
(`docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md`, D109 §2–§9). It is **not wired into any
dispatcher yet**; the approval store, path canonicalisation (`paths.ts`) and the `grant`/`approval` RPC are separate parts.

- `effects.ts` — the effect axis (`read`, `local-write`, `local-destructive`, `external`, `money`) and the mappings from D103
  `sideEffects`, extension `tools[].effect` and MCP annotations (annotations only raise).
- `capabilities.ts` — the capability table (default class inside/outside roots, grant ceiling, minimum surface, base risk) and
  `DEFAULTS` (grant lifetimes, the 90-day `always` expiry, prompt cap, batch size). **All defaults live here**, so owner answers to Q12–Q19 change one file.
- `decide.ts` — `decide(call, ctx, { grants, clock })` returns `allow`, `ask(request)` or `deny(reason, rule)`.
  Precedence: deny-list > never > `tools.deny` > grants > roots > default. Names are case-folded; `tools.deny` entries are exact names or `*` globs (an unreadable entry denies everything); invalid grants (non-finite times, missing surface) are ignored; an unknown effect counts as `money`; a per-agent `allowed` override never lifts the roots. Grants come in through `GrantSource`; time through `Clock`.
  Also exports the helpers surfaces and the store will reuse: `maxScopeFor`, `requiredSurface`, `surfaceMayDecide`, `grantExpiry`, `grantReviewDue`, `pathCovered`.

The caller computes the call's flags (`outsideRoots`, `denyListHit`, `privileged`, …) and passes canonical targets; the evaluator never
inspects a path for the deny-list. Tests: `packages/core/test/policy/` (`permission-eval` is the table-driven adversarial set: every attack
row must be refused, at least 95 % of the benign twins allowed).

## Fail-closed rules added by the B08 audit

- **Malformed input is refused, not half-evaluated.** `decide()` returns `deny` / `policy-never` with rule `invalid-call` when the call's flags are missing or not booleans (`outsideRoots`, `denyListHit` are required booleans, the optional flags booleans when present), or `tool`, `actionHash` or `targets` have the wrong type; and rule `invalid-context` for a subject kind outside the vocabulary, a `headless` context without a non-empty `jobId`, token scopes, hand-off scopes or `deniedActionHashes` that are not lists of strings, and a missing person or agent id. A prompt counter that is not a number below the cap (`NaN`, a string) is read as "cap reached".
- **`tools.deny`** must be an array of non-empty strings; anything else denies every call (`tools.deny:invalid`). `*` matches any run of characters including line breaks; the matcher is not a regular expression, so many wildcards cannot stall it.
- **Grants.** A revocation marker other than `false` or absent revokes the grant. A grant whose `lastUsedAt` lies in the future never applies (it would stretch the idle and 90-day expiry).
- **Batches.** When the number of targets makes a call a batch, `ApprovalRequest.flags.batch` is `true`, so `surfaceMayDecide` caps the scope at `once` for the decision as well as for the offered options.
- **`pathCovered`.** A POSIX path (`/…`) separates on `/` only (a backslash is a file-name character); drive and UNC paths accept both separators; the two families never cover each other.
- **Effects.** An extension effect outside `read`/`write`/`destructive` maps to `external`; an MCP `declared` effect outside the vocabulary is read as undeclared (`external`) before annotations are applied.

Path layer (`paths.ts`): `canonicalisePath` refuses with `deny-listed` (detail "invalid deny-list entry") a deny list that is not an array and any entry that can never match: an empty or relative `path` (an unexpanded `~`, an unset variable), a `name` that is empty, `.`, `..` or contains a separator, or an entry with neither or both of `name`/`path`. "Home is never a root" compares the real path of a root with both `home` and the real path of `home`, so a home that is a symbolic link is still refused (`bad-root`).

## Grant tiers for home and system trees; shell path grants; deny entries (policy-grant-tiers fix)

- **`systemTree` is set where paths are canonicalised.** `canonicalisePath` returns `systemTree` for a real target that is a home directory, a drive root, `/`, `/home`, `/Users`, `C:\Users` or lies in a system tree (`isSystemTreePath`, same list as `isForbiddenRoot`, compared case- and NFC-folded). The `file.*` tool classifiers, `exec.run` (cwd) and the host-tool classifier copy it into the call flags, so `maxScopeFor` caps the options at `task` and `requiredSurface` asks for T3.
- **Grant creation enforces it.** `GrantStore.create` refuses a path grant that reaches home or a system tree (`grantReachesSystemTree`: the path is one, it holds the home, or, when recursive, it holds a system tree) above `task` (`ceiling-exceeded`) or decided below T3 (`surface-too-low`). `grant.create` reports the same with `E_INVALID_PARAMS` reason `ceiling-exceeded` or `E_DENIED` reason `surface-untrusted`; `approval.decide` with scope `always`/`session` on a read whose grant directory is the home answers `scope-unavailable`, a `task` decision below T3 answers `surface-untrusted`, and the request stays pending. A once approval of the single call is unchanged.
- **`shell.exec` grants never replace the sandbox.** A path grant (what an approved `exec.run` produces) applies without a sandbox only when it carries `acknowledgedUnsandboxed`, exactly like a capability grant (Q17). `exec.run` classification sets `sandboxed` from `tools.sandbox.required` (true unless the owner turned it off).
- **Deny entries with `.` or `..`.** `invalidDenyEntry` refuses an absolute `path` entry with a `.` or `..` segment (it can never match a canonical path). `denyEntriesFor` collapses such segments lexically in environment overrides (`CLAUDE_CONFIG_DIR=/srv/agents/../claude` protects `/srv/claude`); a link in the part before `..` is not followed.

