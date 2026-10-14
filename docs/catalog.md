# Signed catalogue trust

The catalogue groundwork from #162 is now exposed through `createCatalogClient` in
`packages/core/src/catalog/index.ts`, and through the original `createExtIndexClient`
entry point in `catalog/ext-index/index.ts`. Both names create the **same** trust
client. All client operations return `{ ok: true, value }` or
`{ ok: false, error: { code, message } }`; they do not throw to callers.
The old exceptions remain internal to the low-level #162 schema/crypto helpers.

This implements the trust portion of D81/D82 and Track X4 / desktop D2. It does not
install, enable, disable, or delete extensions. X1's worker-side `.p1x` manifest and
payload verification remains mandatory after a catalogue download (spec §7.2.1's
“two signatures”). The catalogue client authenticates the artifact's complete bytes
through the hash in a threshold-signed index; it does not parse ZIP files or replace
the package worker.

## V1 inventory (before this change)

Baseline: `origin/main` at `a4638b8f`, including #162. Paths below are relative to
`packages/core/`, except documentation. This inventory determines the missing work;
it is not a claim that all of Track X is complete.

| Spec requirement | On main? | File / test on baseline |
| --- | --- | --- |
| §7.2.1, §8.1: exact-byte Ed25519 verification | Yes, 1-of-n configured keys | `src/catalog/ext-index/verify.ts`; `test/catalog/ext-index/ext-index.test.ts` |
| V2: k-of-n threshold and key expiry | No | — |
| §8.1: provisioned root and authenticated rotation chain | Partial: manually configured keys, no rotation file | `src/catalog/ext-index/types.ts`, `verify.ts`; configured-key test |
| §7.2.1, Q11: persistent serial rollback, expiry, same-serial conflict | Partial: present, but cache fallback on security failure; no offline grace | `src/catalog/ext-index/client.ts`, `store.ts`; rollback/expiry tests |
| §7.2.1: signed artifact hash and metadata version binding | Partial: hash/size fields parsed; no download verifier | `src/catalog/ext-index/verify.ts`; shape tests |
| §7.2 / §8.5: key/package revocations and installed reporting | No: `revocations` only checked as an array | `src/catalog/ext-index/verify.ts` |
| §7.2.1: HTTPS, egress, limits, timeout, safe redirects | Partial: abstract `EgressPort` requiring a caller-supplied adapter | `src/catalog/ext-index/client.ts`, `types.ts`; fake egress/HTTP tests |
| §7.2.1: atomic offline cache and corruption recovery | Partial: individually atomic files; serial floor present | `src/catalog/ext-index/store.ts`; offline/tamper tests |
| V7: typed result objects | No: typed exceptions | `src/catalog/ext-index/types.ts` |
| Q2–Q4 / Q12–Q13, X5: production hosting, keys, publishing | Deferred as specified | `docs/superpowers/specs/2026-09-27-extensions-ecosystem-design.md` §13; `docs/milestones.md` Track X |

Implementation and integration attacks now live in `src/catalog/{client,verify,store,types}.ts`
and `test/catalog/trust.test.ts`. #162's crypto/shape regressions remain under
`test/catalog/ext-index/`. `test/catalog/signing.ts` generates throwaway Ed25519 keys
at runtime; no private or production public key is committed. All integration tests
use a local fake server through the real egress service; none contacts the Internet.

## Trust anchor and transport

`CatalogConfig.root` is provisioned configuration, not a network response. The
bundled `BUNDLED_CATALOG_ROOT` is deliberately an empty, expired **configuration
placeholder**. With no real root configured, requests fail `key_unknown` before
network access. The owner must provision the primary/backup extension public keys
before publishing. Extension keys are separate from harness updater keys (§13 Q4).

The config requires `url`, normally
`https://extensions.plur1bus.app/v1/index.json` (§13 Q2). Hosting is X5's Pages + DNS
work (§13 Q3). The client uses the existing `Egress.request` service directly;
its host/port allowlist, SSRF/DNS-pinning checks, TLS verification, streaming byte
cap and timeout all apply. No identifiers, installed inventory or secret headers
are sent. Package URLs also pass the same egress policy. Configure explicit hosts
for the catalogue/mirror and artifact storage; the client does not widen policy.

All redirects are refused **before following**, including same-host redirects.
This deliberately strengthens §7.2.1's redirect-host rule to the task's no-other-host
redirect requirement. Publishing must use direct artifact URLs; integration with
GitHub release redirects requires a separately reviewed per-hop policy follow-up.
Plain HTTP works only when `testOrigin` explicitly equals the request origin and
its hostname is loopback. Egress must independently permit that loopback host/port.
It is a local testing option, not a production HTTP downgrade.

Defaults: metadata/envelope limit 4 MiB (configurable up to 8 MiB), artifact limit
128 MiB, timeout 15 seconds per request, at most 64 rotations and 64 keys/signatures
per root/envelope. Each artifact also has its signed `size` as a streaming cap.
Network oversize/timeouts/status/egress/redirect errors return `transport`.

## Wire format

This task upgrades #162's raw `.minisig` file to an explicit threshold envelope.
It uses raw Ed25519 signatures, **not** minisign's textual packet format. Existing
unsigned/legacy/missing-field documents are not silently upgraded or trusted.
X5 must publish this format; tooling must not assume compatibility with the
package worker's independent `p1x.json.minisig` format.

Each signed document is delivered as JSON:

```json
{
  "payload": "BASE64_OF_EXACT_UTF8_JSON_BYTES",
  "signatures": [
    { "keyId": "ext-primary", "signature": "BASE64_OF_64_BYTE_ED25519_SIGNATURE" }
  ]
}
```

The producer chooses one deterministic JSON encoding (for example UTF-8 without
BOM, stable field ordering, no insignificant whitespace) and signs those bytes.
The verifier base64-decodes and verifies **exactly the supplied bytes**, before
parsing the payload. It never reserializes a payload to verify it. Whitespace and
field-order changes therefore invalidate a signature. SHA-256 pins below also
refer to decoded original payload bytes, not the surrounding envelope.

Threshold defaults to 1 in an owner-provisioned root. A root explicitly carries
`threshold`; k distinct key identities AND distinct public-key material are
required. Duplicate signatures count once. Unknown, expired, revoked or invalid
signatures are refused, even when other signatures would meet the threshold.
Timestamps are UTC ISO strings ending in `Z`; versions are safe positive integers
(except the index serial, which retains #162's nonnegative integer format).

### Root and rotation

A provisioned root and each rotation payload use:

```json
{
  "type": "root", "version": 1, "threshold": 1,
  "expires": "2027-01-01T00:00:00Z",
  "keys": [
    { "id": "ext-primary", "publicKey": "BASE64_RAW_32_BYTE_ED25519_KEY", "expires": "2027-01-01T00:00:00Z" },
    { "id": "ext-backup", "publicKey": "BASE64_RAW_32_BYTE_ED25519_KEY", "expires": "2027-01-01T00:00:00Z" }
  ]
}
```

The `rotations` endpoint (default: sibling of the index URL; configurable with
`rotationsUrl`) returns an array of signed envelopes, empty before any rotation.
Each next root version is exactly previous + 1 and is signed by the **old** root's
threshold, not by the proposed new keys. The complete chain from the provisioned
root is required, including on refresh. The final index/revocation documents must
name the final root version and verify under its threshold. Trust history cannot
be rolled back or changed at an already accepted version.

Previously accepted exact rotation payload hashes are persisted. Such historical
delegations may be replayed after their authorizing keys expire or are revoked;
this exception never authorizes a new or modified rotation, and never exempts the
final root or current metadata signatures from expiry/revocation. A client that
missed a rotation until its old authorizing keys expired fails closed and needs a
new release-provisioned trust anchor. Loss of all usable keys likewise requires
an owner-provisioned release, not network trust-on-first-use.

### Index

The decoded index retains #162's package structure and adds mandatory pins:

```json
{
  "format": 1, "serial": 42, "rootVersion": 1,
  "generatedAt": "2026-10-07T00:00:00Z", "expires": "2026-11-21T00:00:00Z",
  "revocation": { "version": 3, "sha256": "64_LOWERCASE_HEX_DIGITS" },
  "packages": [{
    "id": "owner/skill", "kind": "skill", "name": "skill",
    "versions": [{
      "version": "1.0.0", "url": "https://artifacts.example/skill-1.0.0.p1x",
      "size": 1234, "sha256": "64_LOWERCASE_HEX_DIGITS"
    }]
  }]
}
```

Q11 recommends 45 days validity with an owner-approved monthly re-sign. Re-signing
with a different expiry must increase `serial`, since equal serials accept only
identical payload bytes. Future-generated or malformed metadata is refused.
Embedded nonempty legacy `revocations` arrays are refused: the signed pinned file
below is the single source of revocation truth.

`download({ serial, id, version })` resolves URL/hash/size internally from the
reverified cache. A stale selection handle, mutated caller result or metadata from
another index cannot supply arbitrary artifact metadata. Hash and exact size are
checked before bytes are returned, then trust is rechecked at completion. The
caller must still send those bytes through X1's independent package verification
before installation. This PR adds no installer wiring.

### Revocations

The `revocations` endpoint (default: sibling of the index; configurable with
`revocationsUrl`) delivers another threshold-signed envelope:

```json
{
  "type": "revocations", "version": 3, "rootVersion": 1,
  "expires": "2026-11-21T00:00:00Z",
  "keys": ["compromised-key-id"],
  "packages": [{ "id": "owner/skill", "versions": ["1.0.0", "1.0.1"], "reason": "Security advisory" }]
}
```

Index pins bind both the list version and exact payload hash. A root-version,
version or hash mismatch is refused, preventing mix-and-match. Revocation versions
are monotonic with same-version content conflict protection. Revocations are
permanent: later lists must retain previously revoked key IDs and package versions;
rotations cannot resurrect them. Revoked public-key material is remembered too,
so changing a revoked key's ID cannot restore its authority.

Only exact package versions are accepted in `versions`; this explicit list is the
wire contract for this client. X5 must expand spec §7.2's semver ranges into exact
listed versions; the client does not approximate semver ranges. Installed copies
are matched by ID/version regardless of installation source.

A list cannot authorize itself solely with the key it revokes. Use enough
nonrevoked trusted signers to satisfy the threshold (or rotate first). Revoked
versions disappear from the offered index and `download` returns `revoked_package`.
`InstalledCatalogPort.list/report` reports matching installed copies as
`{ id, version, status: "revoked", reason }`, including cached revocations after
index expiry. Reporting failure is a visible `transport` result. No uninstall,
deactivation, process stop or other installation mutation occurs here.

## Persistent state and offline behavior

Use `createCatalogFileStore` with a private catalogue state directory owned by the
core. `checkpoint.json` holds monotonic index/root/revocation versions and hashes,
accepted rotation hashes and permanent revocations. `snapshot.json` holds original
signed envelopes and the complete rotation chain. The checkpoint is security state;
the snapshot is replaceable payload cache. Do not delete the checkpoint to fix a
cache problem. The host filesystem permissions and clock are trusted; an attacker
who can replace the whole security state or reset the host clock is outside this
client's threat boundary.

Writes use unique exclusive temporary files, restrictive file permissions,
file fsync, atomic rename and directory fsync on POSIX. The checkpoint is raised **before** replacing the
snapshot. A crash between them may require a refetch, but never lowers the floor.
Clients sharing a resolved directory in one core process serialize the complete
read/verify/write or read/download operation. The cache directory must have one
owning core process; this store is not a multiprocess database.

Each cache use replays the chain and verifies signatures, versions, hashes,
revocations and expiration. Corrupt JSON payload cache is discarded logically and
replaced online; a malformed/tampered signed payload fails verification offline.
A damaged/missing checkpoint beside a snapshot fails closed with
`rollback_detected`, even online. Cache repair never silently resets trust history.
On upgrade, a legacy `last-serial` is retained as a floor: the new-format signed
index must have a strictly higher serial. Legacy raw index/signature files are not
used offline because they lack authenticated rotation/revocation pins.

`get()` first refreshes. Only a `transport` failure permits cache fallback, with a
visible `refreshError`. Signature/rollback/revocation/freeze failures do not become
successful cache results. A fresh valid cache works offline. After expiry:

- Default `offlineGraceMs: 0` returns `stale_index`.
- Within a configured grace period, cache reads return `stale: true`; downloads
  remain forbidden. Grace does not extend key/root validity.
- Beyond grace, reads return `stale_index`. Known package revocations are still
  reported through the installed port when cached signatures remain valid.
- Installed extensions keep running; this client never controls their runtime.

## Error classes

| Code | Meaning |
| --- | --- |
| `signature_invalid` | Tampered/malformed document, invalid or insufficient threshold signatures, expired signer, wrong metadata pins, or absent package identity |
| `key_unknown` | Missing provisioned root or an unknown signature key ID |
| `key_revoked` | Revoked signer/material or attempted removal of a permanent key revocation |
| `rollback_detected` | Older/conflicting index/root/list, skipped root version, mismatched selection serial, or damaged security checkpoint |
| `stale_index` | Expired index/revocation/root, exhausted offline grace, or download requested from stale metadata |
| `hash_mismatch` | Downloaded artifact hash or exact size differs from signed metadata |
| `revoked_package` | Selected package version is revoked or a newer list removes a permanent package revocation |
| `transport` | HTTPS/egress/status/redirect/size/timeout/abort, filesystem or installed-reporting failure |

## Follow-ups

- X5 publishing/signing tool: deterministic producer bytes, threshold envelopes,
  rotation chain, exact-version revocations, direct asset hosting, owner-approved
  monthly serial/expiry refresh, real extension keys and custody/DNS setup.
- `plur1bus-ext`: consume authenticated downloads and revocation reports; retain
  package-manifest verification and implement deactivation/locking of installed
  revoked packages. No installation logic changed here.
- X3 / D2 UI: show trust, freshness, typed errors, offline fallback and revocation
  reports; wire the port without introducing a second trust store.
- Remaining X4 search/install/update/preflight integration. X1–X3/X5 are not
  declared complete by this trust-client PR; Q12's first packages remain owner work.

## Edge-case behaviour (characterised, PR #409)

The tests under `packages/core/test/catalog/` pin three areas that share the word "catalogue": the signed extension
index (`packages/core/src/catalog/`), the curated model metadata table (`packages/core/src/discovery/metadata.ts`) and the
built-in voice catalog (`packages/voice-providers/src/local/catalog.ts`, `packages/core/src/voice/v3-catalog.ts`).
What follows is what the code does today. Cases tagged "characterization" in the tests were never specified; where one
looks like a defect it is listed under [Open points](#open-points-offene-punkte) and is not a commitment. Test references
are `file > test name` relative to `packages/core/test/catalog/`.

### Signed index: parsing and validation (`verify.ts`, `ext-index/verify.ts`)

All shape failures from `parseCatalogIndex`, `parseRevocations`, `parseRoot`, `envelope`, `payload` and `timestamp` are
`CatalogError` with code `signature_invalid`, except where noted. The 600-case seeded mutation test
(`index-entries.test.ts > 600 random mutations ...`) asserts nothing else than a typed `signature_invalid` ever escapes.

* **Payload decoding.** The payload must be UTF-8 JSON; invalid UTF-8, an empty payload and trailing text are refused.
  A leading UTF-8 byte order mark is tolerated: the decoder drops it, while the signature still covers the original
  bytes. Test: `index-entries.test.ts > characterization: ... a UTF-8 byte order mark in front of the JSON is tolerated ...`.
* **Pins.** The index must carry a positive integer `rootVersion` and `revocation: { version, sha256 }` (64 lowercase hex
  characters). An embedded `revocations` array is refused unless it is empty; the parser always returns `revocations: []`.
  Unknown extra fields on the index, a package or a version are carried along untouched. Test:
  `index-entries.test.ts > characterization: ... unknown extra fields on the index, a package or a version are carried along untouched`.
* **Entries.** `generatedAt` must precede `expires`. Package id, kind and name are strings (id non-empty; empty kind and
  name are accepted). A version needs a non-empty `version`, lowercase 64-hex `sha256`, a positive safe-integer `size`
  and a plain `https:` URL without credentials. `http:` is accepted only for the exact origin passed as `testOrigin`.
  Duplicate versions within a package are refused.
* **Package ids are compared exactly.** `owner/skill`, `Owner/Skill`, `owner/skill ` (trailing space), a Cyrillic look-alike
  letter, a zero-width character and a division-slash variant are six separate packages; none is refused. Test:
  `index-entries.test.ts > characterization: ... ids are compared exactly, so look-alike ids ... are separate packages and none of them is refused`.
* **Duplicate package id** is refused, but the message is the generic `invalid index/package metadata`; the specific
  `duplicate package id <id>` only exists in the lower-level `ext-index` parser. Test:
  `index-entries.test.ts > characterization: ... a duplicate package id surfaces as the generic 'invalid index/package metadata' ...`.
* **Empty content.** An index with no packages and a package with no versions both parse. The client later filters out
  packages without versions (`client.ts`, the `filter((p) => p.versions.length > 0)` after revoked versions are removed).
  Test: `index-entries.test.ts > an index with no packages, and a package with no versions, are accepted by the parser ...`.
* **Timestamps** must match `YYYY-MM-DDTHH:MM:SS[.mmm]Z` exactly (UTC, 0 or 3 fractional digits, no surrounding
  whitespace) and `Date.parse` must succeed. The pattern is not a calendar check: `2026-02-30T00:00:00Z` is read as
  2 March and `T24:00:00Z` as midnight of the next day. `T23:59:60Z` and month 13 are refused. Tests:
  `index-entries.test.ts > only UTC 'YYYY-MM-DDTHH:MM:SS[.mmm]Z' is accepted`, `... characterization: ... a calendar-invalid date that still matches the timestamp pattern rolls over instead of being refused ...`.

### Signed index: revocations, roots and envelopes

* **Revocation file.** Needs `type: "revocations"`, positive `version` and `rootVersion`, a set of non-empty key ids (a
  key listed twice is refused), `expires`, and packages with non-empty `id`, string `reason` and at least one non-empty
  version string. A violation in a package reads `... (exact versions required)`. Tests: `index-entries.test.ts > revocation files` block.
  * The "exact versions" rule is only "non-empty strings": `1.*`, `<2.0.0` and `*` are accepted. The client compares versions
    with `includes`, i.e. literally, so such entries revoke nothing. Test: `... characterization: ... 'exact versions required' is only checked as non-empty strings ...`.
  * A revocation may name a key or a package that the index does not contain. Test: `... characterization: ... a revocation may name a package or key the index does not contain ...`.
* **Roots.** `threshold` defaults to 1 and must be a positive integer not above the number of keys; at most 64 keys. An
  empty key list is `key_unknown` ("no extension root keys provisioned"), not `signature_invalid`. Each key needs a
  non-empty id, a raw 32-byte Ed25519 public key in canonical base64 and a valid `expires`; ids and key material must
  be unique. Test: `index-entries.test.ts > trust roots`.
* **Envelopes.** Shape: object with a string `payload` and at most 64 `{ keyId, signature }` entries. Base64 must be
  canonical (padding, alphabet, length, no trailing bits); signatures must be 64 bytes. The threshold counts *distinct*
  trusted signers. Revoked key: `key_revoked`. Expired key: `signature_invalid`. Expired root: `stale_index`; with
  `historical = true` expired keys and roots still count. A key expiring exactly "now" is already expired. Tests:
  `index-entries.test.ts > signed envelopes`.
  * A signature by a key id the root does not list yields `key_unknown` for the **whole** envelope, even when valid
    signatures from listed keys sit next to it (the loop throws on the first unknown id). Test: `index-entries.test.ts > a signature by a key the root does not list is key_unknown, even next to valid ones ...`.

### Model metadata table (`discovery/metadata.ts`)

`loadMetadataTable(raw)` validates a table (`schema: "plur1bus.model-metadata/1"`, non-empty `revision`, `vendors` object of
rule arrays) and compiles it. A rule needs a string `pattern` (at most 200 characters, starting with `^` and ending
with `$`, no numbered or named back-reference, no lookaround, unique across the table, compiling as a JavaScript
`RegExp`), a `kind` and `capabilities` from the vocabularies, an optional positive-integer `contextWindow` and optional
string `aliases` (unique across the table). All violations are collected into one error `invalid model metadata table:` with
one line per violation; a rejected table loads nothing (no partial result). `lookup` tries the vendor section first,
then `generic`; the first matching rule wins. Tests: `model-metadata.test.ts` (validation block).

* Calling `loadMetadataTable(undefined)` loads the bundled table (default parameter), so an `undefined` that stems from a
  failed read looks like success. Test: `model-metadata.test.ts > characterization: ... asking for the table with an undefined value loads the bundled table instead of failing ...`.
* Unknown extra fields on the table or on a rule are ignored without a message. Test: `... characterization: ... unknown extra fields on the table or on a rule are ignored without a message`.
* The "RE2-safe subset" is exactly the checks above. A nested quantifier such as `^(a+)+$` is accepted although it is
  catastrophic in a backtracking engine; the pattern is only compiled by the loader, never run. Test: `... characterization: ... the 'RE2-safe subset' is only the three listed restrictions ...`.

### Built-in voice catalog (`voice-providers` `local/catalog.ts`, core `voice/v3-catalog.ts`)

* `loadCatalog(override)` merges an owner override over the built-in catalog. A built-in model that is overridden keeps
  its **built-in licence** as long as the override points at the built-in bytes. An override may change a built-in model's
  `download` url or `sha256` **only together with its own, valid licence record** whose licence id differs from the built-in
  one (a stored confirmation for the built-in package never carries over to other bytes); otherwise it is rejected with the
  licence validation error (`model <id>: licence needs id, name, commercial (true|false|null) and status`). Every other field
  stays overridable. Tests: `voice-catalog.test.ts > built-in models: download url and checksum change only together with an own licence record`.
* `models` or `languages` in an override that are not objects (`5`, `"x"`, an array), and entries of them that are not
  objects, are a validation error (`catalogOverride.models is not an object`, `catalogOverride.languages is not an object`,
  `model <id> is not an object`, `language <code>: stt.fast and tts.fast are required`). Absent keys are fine. An override
  that is not an object as a whole is refused (`catalogOverride is not an object`). Test:
  `voice-catalog.test.ts > 'models' or 'languages' that are not objects, and entries of them that are not objects, are a validation error ...`.
* Invalid override entries throw `VoiceProviderError` with code `catalog` and a message starting `voice catalog: ` that
  names the entry: role paths escaping the model directory, and model ids that are not safe directory names
  (separators, leading dot or dash, empty, spaces, non-ASCII, and the names `__proto__`, `constructor` and `prototype`). The merge does not mutate the built-in catalog or the
  override object. Tests: `voice-catalog.test.ts > voice catalog overrides: invalid entries are rejected ...`.
* The built-in German quality voice is `voice-martin-de`: its licence's `commercial` value is `null` (unknown), so
  `needsLicenceConfirmation` is true, and it has no package, so `downloadable` is not ok. It is therefore gated twice
  (licence confirmation and missing download). Test: `voice-catalog.test.ts > characterization: ... the built-in catalog's German quality voice is a model with an unknown licence and no package ...`.
* `voiceV3Catalog(override, profiles)` clones the loaded catalog and **replaces the whole `tts` selection of `de` and
  `en`** with `{ fast, quality }` from the profiles (default `V3_TTS_DEFAULTS`); other languages from an override keep
  their selection; stt, vad, models and licences are unchanged. The declared `tts.fallback` of `de` and `en` (for
  example `kokoro-multi` for English) is kept, as `docs/voice-local.md` describes. The profile ids are validated: the result
  is parsed as a whole, so an unknown id or a model of the wrong kind is a `catalog` error naming it (for example
  `language de: tts.fast names unknown model nope`). Tests: `voice-catalog.test.ts > voiceV3Catalog`.
* **Owner decision 2026-10-14:** `piper-en-lessac-low` stays the English `tts.fast` preselection of the built-in
  catalog. It is research-only (licence `Blizzard-2013-Lessac-research`, `commercial: false`), so preselection never
  replaces the per-model confirmation: `downloadModel` and `LocalVoice.setLanguage` refuse it with `licence_required`
  unless `piper-en-lessac-low@Blizzard-2013-Lessac-research` was confirmed. Tests: `voice-catalog.test.ts > owner decision 2026-10-14 ...`
  and `packages/voice-providers/test/local-voice.test.ts > owner decision 2026-10-14 ...`.

### Open points (Offene Punkte)

These are observations, not decisions. Do not rely on them.

1. **Look-alike package ids are not refused** (case, trailing space, homoglyphs, zero-width characters). The index is
   threshold-signed, so this is only reachable through a compromised or careless publisher, but nothing in the client
   warns about near-duplicate ids.
2. **Calendar-invalid timestamps roll over** (`2026-02-30` is 2 March, `T24:00:00Z` is the next day), so a signed expiry can
   mean a different instant than it reads.
3. **Revocation versions are not validated as exact versions.** A range or wildcard is accepted and silently has no effect,
   although the error message demands "exact versions".
4. **Revocations are not required to resolve** to a known key or package. Probably intended for forward revocation, but
   undecided.
5. **One stray signature rejects an otherwise valid envelope** (`key_unknown`). It may be intended (fail closed) but it
   also blocks signing with a key that is not yet in the root.
6. **Generic duplicate-id error.** The caller cannot tell which id was duplicated.
7. **`loadMetadataTable(undefined)` falls back to the bundled table**, hiding a failed read of an external table.
8. **The "RE2-safe" check does not exclude nested quantifiers**; rules are JavaScript `RegExp`, so a hostile external
   table could cause catastrophic backtracking when `lookup` runs. Neither the loader nor `lookup` bounds this.
9. **Voice catalog (resolved 2026-10-14).** Overrides of built-in models change url or checksum only with their own licence
   record; `voiceV3Catalog` keeps the TTS fallback tier and validates profile ids; non-object `models`/`languages` (and their
   entries) in an override are rejected; the model ids `__proto__`, `constructor` and `prototype` are rejected; the research-only
   English fast voice stays preselected by decision, behind the mandatory licence confirmation (see "Built-in voice catalog").
