# TODO-Inventar

Open work that is marked in the code, as of `origin/main` plus the branch `fix/known-gaps-media-embedding` (line numbers were checked against that tree on 2026-10-20). It has three parts: comment tokens, test markers and Rust `#[ignore]` markers.

## 1. TODO, FIXME, XXX and HACK comments

Every comment in the repo that contains an uppercase TODO, FIXME, XXX or HACK token (case-sensitive). Build output, dependency folders, generated files and the planning trees under docs/superpowers, docs/phase0 and docs/handoff are excluded. Scan command: `rg -n -e '\b(TODO|FIXME|XXX|HACK)\b'` with the exclusion globs listed below. Prose in docs that only reports TODO test counts of a verification run (milestones, handoffs, demos, ci) is not listed; prose that names an open item is.

| Datei:Zeile | Text | Modul |
|---|---|---|
| packages/core/src/dreams/index.ts:36 | TODO(engine): the pinned engine still writes DREAMS.md; until it follows D15 `exists` stays false for it | @plur1bus/core |
| packages/core/src/dreams/types.ts:115 | TODO(engine): rename of the diary file for harness hosts (the pinned engine still writes DREAMS.md) | @plur1bus/core |
| packages/core/src/dreams/scheduler.ts:105 | TODO(D111): emit these as catalogued log-schema events once packages/log-schema is on main; until then the logger line is the record | @plur1bus/core |
| packages/core/src/dreams/scheduler.ts:494 | TODO(engine): one guaranteed diary entry per deep sweep, C1 | @plur1bus/core |
| packages/core/src/media-search/caption/local.ts:22, 28, 31, 32, 36, 37, 42 | TODO-PIN: revision and per-file SHA-256 of the two caption models are placeholders; `isPinned()` (line 42) is not called anywhere yet | @plur1bus/core |
| docs/adr/ADR-009-dreaming-scheduler.md:317 | `TODO(D111)` marks the emit site (prose reference, not a code comment) | docs (ADR) |
| docs/media-search.md:72 | the caption model pins are still placeholders (`TODO-PIN`) and the download is not implemented | docs |
| docs/architecture/turn-pipeline.md:43, 237 | known policy hard-link name-alias TODO; the WebMCP `grant.`/`approval.` TODO tests are not fixed there | docs |
| apps/desktop/transport-spike/SSH.md:48 | direct RSA is a future TODO after a Marvin-safe version or audited backend | docs |

Removed since the last revision: `packages/core/src/session/compaction.ts` has no TODO token any more (the two `TODO(M2)` and `TODO` lines are gone).

### Zählung

| Modul | Anzahl |
|---|---|
| @plur1bus/core | 4 Zeilen mit TODO(...) plus 7 Zeilen TODO-PIN in einer Datei |
| docs | 5 Stellen in 4 Dateien |

### Ausgeschlossen

- `node_modules`, `target`, `dist`, `build`: Abhängigkeits- und Build-Ausgaben, keine Quelltexte.
- Generierte Dateien: `docs/rpc.md`, `docs/cli.md`, `docs/openapi.json` und Lockfiles.
- `docs/superpowers`, `docs/phase0`, `docs/handoff`: Planungsdokumente.
- `docs/reference/README.md` und diese Datei (Verweis auf das Inventar selbst).
- `apps/desktop/mock-harness/CONTRACT.md:19` enthält `XXXX-XXXX` als Code-Format-Platzhalter, kein Kommentar-Marker.

## 2. Test markers: todo tests

Tests that are marked `todo` (`test.todo`, `it.todo`, `{ todo: true }` or `{ todo: "<reason>" }`). Each is an open gap: the test states the wanted behaviour or the missing acceptance and is not run as a pass/fail test. The text is the test title, shortened. Scan: `rg -n -e 'todo: true|\btodo:\s|\.todo\(|\btodo\(' -g '*.ts' -g '*.mjs' -g '*.tsx'`.

| Modul | Anzahl |
|---|---|
| @plur1bus/core | 24 |
| @plur1bus/api | 6 |
| @plur1bus/remote-access | 4 |
| @plur1bus/embedding-adapters | 2 |
| @plur1bus/media | 1 |
| @plur1bus/web | 2 |
| @plur1bus/channels-matrix | 2 |
| apps/desktop | 10 |
| tests/acceptance | 4 |
| scripts/release | 1 |
| **Summe (statisch)** | **56** |

### @plur1bus/core

| Datei:Zeile | Lücke |
|---|---|
| packages/core/test/privacy/live-policy.test.ts:62 | settle reembed tokens and cost from actual provider usage after the approved Engine 1.15 host network port is wired (currently estimated) |
| packages/core/test/privacy/live-policy.test.ts:65 | automatically schedule engine-only restart with restartPending and Web/CLI hint when a live privacy transition needs Engine hot reconfiguration |
| packages/core/test/system-jobs/audit-c05.test.ts:108 | a second concurrent run of a singleton job runs the handler twice (no handler lock) |
| packages/core/test/config-load-hardening.test.ts:79 | core.recall.softBudgetMs above hardBudgetMs is accepted (needs the same cross-field rule in crates/plur1bus-config, else core and supervisor disagree) |
| packages/core/test/config-load-hardening.test.ts:80 | numbers without maximum (logs.keep, core.recall.capChars, session.compaction.*Tokens, media dimensions) and arrays/strings without maxItems/maxLeng... |
| packages/core/test/config-load-hardening.test.ts:81 | engine.baseDbPathOverride has no minLength/absolute-path constraint in the schema (engine-config.ts only ignores blank values) |
| packages/core/test/import/hermes-cards-own-store.test.ts:271 | a run without --adopt-store after a reembed take-over imports the parked cards without duplicate linking (no store named, the plain import); the do... |
| packages/core/test/toolcall/results.test.ts:527 | idempotency key collides for scope 'a:b' + operation 'c' and scope 'a' + operation 'b:c' |
| packages/core/test/toolcall/results.test.ts:536 | a cached approved result of another scope is served without a new approval |
| packages/core/test/toolcall/dialects.test.ts:39 | names such as constructor and __proto__ bypass the conservative fallback |
| packages/core/test/media-search/audit-c08.test.ts:177 | MediaIndexPort.remove and setCaption carry no scope, so the port cannot refuse a caller that does not own the medium |
| packages/core/test/engine-config.test.ts:233 | a key from the harness secret store reaches the engine as a reference |
| packages/core/test/composition/model-test.test.ts:63 | engine embedding/reranker role probes require the Phase D host ports |
| packages/core/test/host-tools/audit-b07.test.ts:66 | apps.open can launch executables but is registered as sys.read/low (auto-allowed) |
| packages/core/test/audit/chain-hardening.test.ts:47 | secrets inside 'detail' are written as given (redaction belongs to the event producers in rbac/identity) |
| packages/core/test/journal-hardening.test.ts:79 | a replaying file is read whole into memory (needs a streaming line reader and a per-line bound) |
| packages/core/test/channels/behaviour-runtime.test.ts:84 | engine per-request allowedScopes and searchable provenance-only capture are absent on pin 6868b7b1; restrictive profiles suppress engine memory calls |
| packages/core/test/warmup.test.ts:201 | models.warm() itself has no deadline (a first-run model download may legitimately take minutes); a hung provider keeps recallWarmPending true until... |
| packages/core/test/openai-auth/audit-b10.test.ts:34 | a forged callback request consumes the one-shot loopback listener (login DoS, no credential exposure) |
| packages/core/test/admin/person-status.test.ts:21 | channel inbound ignores person.disabled; switchboard is owned by the parallel security package |

### @plur1bus/api

| Datei:Zeile | Lücke |
|---|---|
| packages/api/test/remote-runtime.test.ts:80 | native Tailscale Serve, CA-verified edge and desktop pairing acceptance require a disposable joined host |
| packages/api/test/m3-agent-licences-e2e.test.ts:37 | EmbeddingGemma 2 selection and validated Jina migration over HTTP require pinned-engine target/validation support; existing test proves explicit re... |
| packages/api/test/hardening-session.test.ts:171 | the 64-session cap is global, so one account holder can push every other person's session out |

### @plur1bus/remote-access

| Datei:Zeile | Lücke |
|---|---|
| packages/remote-access/test/hardening-certs.test.ts:170 | a leaf with a critical extension nobody understands is imported (TLS clients such as rustls will refuse it at connect time) |
| packages/remote-access/test/hardening-certs.test.ts:350 | after a switch from A to B the harness will stage the retired anchor A again, and devices will accept it as their next anchor |
| packages/remote-access/test/hardening-pairing.test.ts:271 | a failed revocation write leaves the device connected and authorised in memory (docs/errors.md promises it is denied at once) |
| packages/remote-access/test/hardening-pairing.test.ts:282 | two store instances over one file overwrite each other (a stale instance can undo a revocation); the documented rule is one owner per file |

### @plur1bus/embedding-adapters

| Datei:Zeile | Lücke |
|---|---|
| packages/embedding-adapters/test/audit-c15.test.ts:155 | an input over maxBatchTokens but within maxInputTokens is sent alone (documented, pinned by an existing test); config does not reject maxBatchToken... |
| packages/embedding-adapters/test/audit-c15.test.ts:156 | docs/embedding-adapters.md says zero vectors are rejected 'when normalising'; the code now rejects them always (docs are outside this package) |

### @plur1bus/media

| Datei:Zeile | Lücke |
|---|---|
| packages/media/test/audit-c12.test.ts:166 | two jobs finishing at the same moment both publish (put() fails fast on a held lock instead of waiting) |

### @plur1bus/web

| Datei:Zeile | Lücke |
|---|---|
| packages/web/test/settings-known-gaps.test.ts:6 | no x-sensitive marker exists in config.schema.json, so the UI cannot tell secret-bearing keys from the schema; it relies on key names (config/model... |
| packages/web/test/bootstrap-account.test.ts:33 | physical platform/security-key interoperability requires owner hardware; CDP proves browser WebAuthn only |

### @plur1bus/channels-matrix

| Datei:Zeile | Lücke |
|---|---|
| packages/channels-matrix/test/crypto-store-spike.test.ts:39 | no complete IndexedDB-over-SQLite backend exists in the approved dependency set; actual WASM identity/session ratchets cannot be checkpointed to SQ... |
| packages/channels-matrix/test/crypto-store-spike.test.ts:40 | five-target persistent crypto restart, cross-signing bootstrap and owner-approved recovery backup are not accepted |

### apps/desktop

| Datei:Zeile | Lücke |
|---|---|
| apps/desktop/transport-spike/known-gaps.test.mjs:4 | Later/direct-RSA: restore encrypted RSA file login only with a Marvin-safe version or audited backend; outside v1 by Owner 2026-10-18 |
| apps/desktop/transport-spike/known-gaps.test.mjs:5 | H/platforms: same SSH suite on Windows x64/arm64 and Linux x64/arm64 |
| apps/desktop/transport-spike/known-gaps.test.mjs:6 | H/OpenSSH: 8.9/9.6 interoperability, negotiated algorithm allowlist and real PTY |
| apps/desktop/transport-spike/known-gaps.test.mjs:7 | H/transport: real SPA proxy HTTP/SSE/WS, jump host and LAN p95 overhead |
| apps/desktop/transport-spike/known-gaps.test.mjs:8 | H/agent: Windows pipe, isolated 1Password/FIDO fixture and hashed known_hosts |
| apps/desktop/transport-spike/known-gaps.test.mjs:9 | H/size: installed desktop binary delta on five release targets |

### tests/acceptance

| Datei:Zeile | Lücke |
|---|---|
| tests/acceptance/d111-known-gaps.test.mjs:4 | Q/config: source-level settings persist across restart with bounded trace expiry and live reload |
| tests/acceptance/d111-known-gaps.test.mjs:5 | Q/MCP: stderr uses the D111 process.output.line envelope while stdout stays protocol-only |
| tests/acceptance/d111-known-gaps.test.mjs:6 | Q/supervisor: D111 writer parity, trusted attribution, trace, live levels and child-output redaction |
| tests/acceptance/d111-known-gaps.test.mjs:7 | Q/spec-section-8: named D111 suite passes on all five native release targets |

### scripts/release

| Datei:Zeile | Lücke |
|---|---|
| scripts/release/test/audit-policy.test.mjs:88 | an exception is not scoped to the package it was approved for |

### Todo-Tests, die zur Laufzeit entstehen

Diese Tabellen erzeugen ihre Todos aus Daten; die Zahl ergibt nur ein Lauf der Datei.

| Datei | Quelle der Todos | Stand |
|---|---|---|
| packages/webmcp/test/rbac-matrix.test.ts:81, 135, 186 | je Methode ein Todo: GAP_UNRULED, GAP_UNRULED_DOCUMENTED, GAP_WRITE, GAP_HUMAN (docs/rbac.md, D55) | offen, Zahl nur per Lauf |
| packages/core/test/policy/permission-eval-e2e.test.ts:40 | Zeilen mit `knownGap` | 0 Zeilen (Assertion in Zeile 66) |
| packages/embedding-adapters/test/error-table.test.ts:107 | `KNOWN_GAPS` | leer |
| packages/web/test/routes-smoke.test.ts:46 | `KNOWN_GAPS` | leer |
| packages/voice-providers/test/error-table.test.ts:292 | Feld `gap` der Tabelle | kein Eintrag |

## 3. Tests mit KNOWN-GAP im Namen oder Kommentar, aber ohne todo-Flag

| Datei:Zeile | Stand |
|---|---|
| packages/core/test/import/provenance-imported.test.ts:86 | Prüft absichtlich den heutigen Zustand (die Bearbeitung einer Karte verliert die Herkunft, `provenance` bleibt `undefined`) und schlägt an dem Tag fehl, an dem die Engine das behebt. Braucht die echte Engine. Bewusst kein todo: das Flag würde diesen Alarm abschalten. docs/import.md Abschnitt 11 |
| packages/core/test/import/provenance-imported.test.ts:105 | Kommentar: Rollback je Import-Lauf ist ohne Engine-Undo nicht möglich |
| packages/core/test/import/hermes-acceptance3.test.ts:2, 47 | Kommentar: Hermes-Cron wird nicht importiert, bewusst zurückgestellt (docs/import.md) |
| packages/core/src/logs/output.ts:61 | Kommentar: der MCP-stdio-Spawn liegt in `packages/core/src/mcp/` und ist dort nicht gekapselt |
| packages/channels-matrix/test/split-property.test.ts:588, 692, 748, 759, 770 | Kommentare zu Produktabweichungen der Fence-Aufteilung (Properties 3b, 4, 4b, 4c) |

Geschlossen und umbenannt am 2026-10-20: `packages/core/test/composition/inbox.test.ts` (Migration überspringt eine ungültige Altmeldung und kopiert die folgenden) und `packages/core/test/dreams/scheduler-time.test.ts` (`runPhase` für einen entfernten Agenten läuft nicht). Beide Tests prüfen das gewünschte Verhalten und liefen bereits grün; nur der Name sprach noch von einer Lücke.
Ebenfalls geschlossen: `packages/embedding-adapters/test/audit-c15.test.ts` (Cloud-Provider unter `privacy.localOnly`) und die Probe `models.test` unter `privacy.localOnly` (`packages/core/test/composition/model-test.test.ts`, `open.test.ts`). Früher geschlossen: `packages/hostctl/test/hardening-hostctl.test.ts`.

## 4. Rust: `#[ignore]` mit KNOWN GAP

| Datei:Zeile | Lücke |
|---|---|
| crates/plur1bus-attest/tests/protocol_hardening.rs:431 | `clean_text` lässt Bidi- und Zero-Width-Zeichen im OS-Dialog |
| crates/plur1bus-containers/tests/private_network.rs:139 | `DockerRuntime::address` liefert den Containernamen statt einer privaten IP |
| crates/plur1bus-ext/tests/manifest_hardening.rs:644 | SICHERHEIT: ein Upgrade ändert `remote.url` oder `baseUrl`, der Consent-Hash bleibt gleich |
| crates/plur1bus-log-schema/tests/events.rs:708 | SICHERHEIT, latent: `config.schema.json` ohne `x-sensitive`, das Webhook-Secret wird nicht redigiert |
| crates/plur1bus/src/backup/hardening.rs:524 | SICHERHEIT: `config.json` liegt im Backup im Klartext, mit dem Telegram-Webhook-Secret |
| crates/plur1bus/tests/firstaid_bundle_hardening.rs:408 | SICHERHEIT, niedrig: ein hex-kodiertes registriertes Secret wird im Bundle nicht redigiert |
| crates/plur1bus/tests/coverage_login.rs:128 | UNKLAR: soll ein nur aus Leerraum bestehender API-Key abgelehnt werden? (docs/testing/coverage-2026-10-wave2.md, offene Frage 9) |

Weitere `#[ignore]` sind Umgebungs- oder Opt-in-Marker und keine Lücken: `apps/desktop/src-tauri/tests/controller_e2e.rs` (3, Docker, Podman, lokale Registry), `upgrade_e2e.rs` (2), `secrets.rs` (1, echter Keychain), `apps/desktop/src-tauri/examples/production_job.rs` (4 Subprozess-Einstiege) und `crates/plur1bus-ext/tests/fuzz.rs` (2, Nightly-Job).

## 5. Bewusst offen aus der Prüfung von 2026-10-20

- `packages/core/test/media-search/audit-c08.test.ts:177`: die Hostpfade sind geprüft (`media.search` liefert nur Treffer im Scope und mit `readable`, `media.caption.set` verlangt Person, `readable` und `editable`, `media.output.delete` verlangt das Schreibrecht am Eigentümer-Agenten). Offen ist nur, dass `MediaIndexPort.remove` und `setCaption` selbst keinen Scope tragen; das ist der Vertrag der Engine (`engine.media`) und braucht eine Änderung dort.
