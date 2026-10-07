# Typed error codes (aus dem Quellcode extrahiert)

Diese Liste enthält die typisierten Fehlercodes, Fehlerklassen und Fehler-Enums, die im Quellcode gefunden wurden, gruppiert nach Modul. Die Liste ist aus dem Quellcode extrahiert, nicht aus einer Spezifikation. Generierte Dateien (z.B. `packages/rpc-schema` ERROR_CODES aus `generated/names.json`, `crates/plur1bus-rpc` ErrorCode) und Testfixtures sind ausgenommen.

## packages/core/src/mcp/errors.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid-config` | core · mcp/errors | unklar – prüfen | packages/core/src/mcp/errors.ts:4 |
| `not-allowed` | core · mcp/errors | unklar – prüfen | packages/core/src/mcp/errors.ts:4 |
| `not-registered` | core · mcp/errors | unklar – prüfen | packages/core/src/mcp/errors.ts:4 |
| `connect-failed` | core · mcp/errors | retrybar (RETRYABLE-Set, Z.8) | packages/core/src/mcp/errors.ts:5 |
| `connect-timeout` | core · mcp/errors | retrybar (RETRYABLE-Set, Z.8) | packages/core/src/mcp/errors.ts:5 |
| `call-timeout` | core · mcp/errors | retrybar (RETRYABLE-Set, Z.8) | packages/core/src/mcp/errors.ts:5 |
| `aborted` | core · mcp/errors | unklar – prüfen | packages/core/src/mcp/errors.ts:5 |
| `unknown-tool` | core · mcp/errors | unklar – prüfen | packages/core/src/mcp/errors.ts:6 |
| `server-error` | core · mcp/errors | unklar – prüfen | packages/core/src/mcp/errors.ts:6 |
| `protocol` | core · mcp/errors | unklar – prüfen | packages/core/src/mcp/errors.ts:6 |
| `closed` | core · mcp/errors | retrybar (RETRYABLE-Set, Z.8) | packages/core/src/mcp/errors.ts:6 |
| `McpClientError` (Klasse) | core · mcp/errors | Fehlerklasse mit code, server, retryable (Z.11-13) | packages/core/src/mcp/errors.ts:10 |

## packages/core/src/engine-shim.d.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `source-busy` | core · engine-shim.d.ts | unklar – prüfen | packages/core/src/engine-shim.d.ts:16 |
| `insufficient-disk` | core · engine-shim.d.ts | unklar – prüfen | packages/core/src/engine-shim.d.ts:16 |
| `digest-mismatch` | core · engine-shim.d.ts | unklar – prüfen | packages/core/src/engine-shim.d.ts:16 |
| `not-found` | core · engine-shim.d.ts | unklar – prüfen | packages/core/src/engine-shim.d.ts:16 |
| `unsafe-path` | core · engine-shim.d.ts | unklar – prüfen | packages/core/src/engine-shim.d.ts:16 |
| `SnapshotError` (Klasse) | core · engine-shim.d.ts | unklar – prüfen | packages/core/src/engine-shim.d.ts:16 |

## packages/core/src/import/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `ImportError` (Klasse) | core · import/types | Ablehnung oder Fehler, den die CLI als error/1-Dokument mit Code, Reason und Exit-Code meldet (Z.7) | packages/core/src/import/types.ts:8 |

## packages/core/src/import/paths.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `env-var` | core · import/paths | unklar – prüfen | packages/core/src/import/paths.ts:260 |
| `foreign-path` | core · import/paths | unklar – prüfen | packages/core/src/import/paths.ts:260 |
| `drive-relative` | core · import/paths | unklar – prüfen | packages/core/src/import/paths.ts:260 |
| `home-unknown` | core · import/paths | unklar – prüfen | packages/core/src/import/paths.ts:260 |
| `outside-source-root` | core · import/paths | unklar – prüfen | packages/core/src/import/paths.ts:260 |

## packages/core/src/import/importers/hermes-stores.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `store-unreadable` | core · hermes-stores | Fallback, wenn err.code kein gültiges Token ist (Z.136) | packages/core/src/import/importers/hermes-stores.ts:136 |

## packages/core/src/discovery/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `failed:auth` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:11 |
| `failed:network` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:11 |
| `failed:server` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:11 |
| `failed:invalid` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:11 |
| `failed:empty` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:11 |
| `already_running` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:12 |
| `disabled` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:12 |
| `no-scanner` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:12 |
| `role_unavailable` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:28 |
| `shadowed_by_manual` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:29 |
| `empty_list` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:30 |
| `auth` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:32 |
| `network` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:32 |
| `timeout` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:32 |
| `server` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:32 |
| `rate-limited` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:32 |
| `invalid-request` | core · discovery/types | unklar – prüfen | packages/core/src/discovery/types.ts:32 |

## packages/core/src/discovery/overrides.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid` | core · discovery/overrides | unklar – prüfen | packages/core/src/discovery/overrides.ts:7 |
| `conflict` | core · discovery/overrides | unklar – prüfen | packages/core/src/discovery/overrides.ts:7 |
| `not-found` | core · discovery/overrides | unklar – prüfen | packages/core/src/discovery/overrides.ts:7 |
| `not-manual` | core · discovery/overrides | unklar – prüfen | packages/core/src/discovery/overrides.ts:7 |
| `CatalogError` (Klasse) | core · discovery/overrides | unklar – prüfen | packages/core/src/discovery/overrides.ts:6 |

## packages/core/src/discovery/http.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `ScanError` (Klasse) | core · discovery/http | unklar – prüfen | packages/core/src/discovery/http.ts:18 |

## packages/core/src/discovery/ports.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `CredentialUnavailableError` (Klasse) | core · discovery/ports | unklar – prüfen | packages/core/src/discovery/ports.ts:9 |

## packages/core/src/discovery/catalog-store.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `CatalogWriteError` (Klasse) | core · discovery/catalog-store | unklar – prüfen | packages/core/src/discovery/catalog-store.ts:12 |

## packages/core/src/embedding-migrate/driver.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `migration-active` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:11 |
| `migration-running` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:11 |
| `no-migration` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:11 |
| `not-runnable` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:11 |
| `not-abortable` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:11 |
| `not-ready-to-switch` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:11 |
| `plan-refused` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:12 |
| `switch-unavailable` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:12 |
| `switch-failed` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:12 |
| `state-corrupt` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:12 |
| `state-unreadable` | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:12 |
| `source-drift` | core · embedding-migrate/driver | Quelle/Generation/Config-Revision hat sich geändert (Regex, Z.81) | packages/core/src/embedding-migrate/driver.ts:81 |
| `confirmation-invalid` | core · embedding-migrate/driver | Re-Embedding-Bestätigung ungültig oder abgelaufen (Z.82) | packages/core/src/embedding-migrate/driver.ts:82 |
| `engine-error` | core · embedding-migrate/driver | Fallback-Fehler der Engine, nicht final (Z.83) | packages/core/src/embedding-migrate/driver.ts:83 |
| `engine-record-missing` | core · embedding-migrate/driver | Engine hat keinen Datensatz, neu planen (Z.156) | packages/core/src/embedding-migrate/driver.ts:156 |
| `engine-validate-unavailable` | core · embedding-migrate/driver | Engine bietet keine Generationsvalidierung (Z.170) | packages/core/src/embedding-migrate/driver.ts:170 |
| `engine-state-unexpected` | core · embedding-migrate/driver | unerwarteter Engine-Zustand (Z.176) | packages/core/src/embedding-migrate/driver.ts:176 |
| `MigrationError` (Klasse) | core · embedding-migrate/driver | unklar – prüfen | packages/core/src/embedding-migrate/driver.ts:14 |

## packages/core/src/embedding-migrate/probe.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `stored-identity-missing` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:15 |
| `stored-identity-invalid` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:15 |
| `target-identity-invalid` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:15 |
| `target-revision-unpinned` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:15 |
| `target-provider-unusable` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:15 |
| `target-model-unpinned` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:15 |
| `provider-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:16 |
| `model-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:16 |
| `revision-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:16 |
| `dimension-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:16 |
| `endpoint-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:16 |
| `query-prefix-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:16 |
| `passage-prefix-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:17 |
| `pooling-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:17 |
| `normalisation-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:17 |
| `dtype-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:17 |
| `artifacts-changed` | core · embedding-migrate/probe | unklar – prüfen | packages/core/src/embedding-migrate/probe.ts:17 |

## packages/core/src/embedding-migrate/state.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `MigrationStateError` (Klasse) | core · embedding-migrate/state | unklar – prüfen | packages/core/src/embedding-migrate/state.ts:31 |

## packages/core/src/auth/errors.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `login_failed` | core · auth/errors | unklar – prüfen | packages/core/src/auth/errors.ts:2 |
| `login_timeout` | core · auth/errors | unklar – prüfen | packages/core/src/auth/errors.ts:2 |
| `state_mismatch` | core · auth/errors | unklar – prüfen | packages/core/src/auth/errors.ts:2 |
| `access_denied` | core · auth/errors | unklar – prüfen | packages/core/src/auth/errors.ts:2 |
| `persist_failed` | core · auth/errors | unklar – prüfen | packages/core/src/auth/errors.ts:2 |
| `reauth_required` | core · auth/errors | gespeicherter Login tot (Refresh-Token abgelaufen/widerrufen), Person muss neu anmelden (Z.3) | packages/core/src/auth/errors.ts:3 |
| `refresh_failed` | core · auth/errors | Token-Endpoint nicht erreichbar oder 5xx, später erneut, Login intakt (Z.4) | packages/core/src/auth/errors.ts:4 |
| `no_credential` | core · auth/errors | nichts unter der Secret-Referenz gespeichert oder Pool leer (Z.5) | packages/core/src/auth/errors.ts:5 |
| `all_cooling_down` | core · auth/errors | alle Pool-Credentials im Cooldown (Z.6) | packages/core/src/auth/errors.ts:6 |
| `unknown_profile` | core · auth/errors | unklar – prüfen | packages/core/src/auth/errors.ts:7 |
| `delegated_login` | core · auth/errors | Login gehört einer Hersteller-CLI, Harness hält keinen Header (Z.8) | packages/core/src/auth/errors.ts:8 |
| `adc_unavailable` | core · auth/errors | unklar – prüfen | packages/core/src/auth/errors.ts:9 |
| `invalid_profile` | core · auth/errors | unklar – prüfen | packages/core/src/auth/errors.ts:10 |
| `invalid_secret_record` | core · auth/errors | unklar – prüfen | packages/core/src/auth/errors.ts:11 |
| `AuthError` (Klasse) | core · auth/errors | Fehlerklasse; Meldungen ohne Tokens oder Bodies (Z.13-14) | packages/core/src/auth/errors.ts:15 |

## packages/core/src/auth/pool.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `quota_exhausted` | core · auth/pool | Klassifikation: Quota-Hinweis, bestätigt (Z.37) | packages/core/src/auth/pool.ts:37 |
| `rate_limited` | core · auth/pool | Klassifikation: ambig (Z.38) | packages/core/src/auth/pool.ts:38 |
| `auth_rejected` | core · auth/pool | Klassifikation: HTTP 401, bestätigt (Z.40) | packages/core/src/auth/pool.ts:40 |
| `forbidden` | core · auth/pool | Klassifikation: HTTP 403, ambig (Z.41) | packages/core/src/auth/pool.ts:41 |

## packages/core/src/auth/http.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid_grant` | core · auth/http | OAuth-Wire-Code, der durchgereicht wird (Set Z.9) | packages/core/src/auth/http.ts:9 |
| `authorization_pending` | core · auth/http | OAuth-Wire-Code, der durchgereicht wird (Set Z.9) | packages/core/src/auth/http.ts:9 |
| `slow_down` | core · auth/http | OAuth-Wire-Code, der durchgereicht wird (Set Z.9) | packages/core/src/auth/http.ts:9 |
| `expired_token` | core · auth/http | OAuth-Wire-Code, der durchgereicht wird (Set Z.9) | packages/core/src/auth/http.ts:9 |
| `access_denied` | core · auth/http | OAuth-Wire-Code, der durchgereicht wird (Set Z.9) | packages/core/src/auth/http.ts:9 |
| `invalid_client` | core · auth/http | OAuth-Wire-Code, der durchgereicht wird (Set Z.9) | packages/core/src/auth/http.ts:9 |
| `invalid_request` | core · auth/http | OAuth-Wire-Code, der durchgereicht wird (Set Z.9) | packages/core/src/auth/http.ts:9 |
| `unsupported_grant_type` | core · auth/http | OAuth-Wire-Code, der durchgereicht wird (Set Z.9) | packages/core/src/auth/http.ts:9 |
| `OAuthHttpError` (Klasse) | core · auth/http | Keine Antwort, Endpoint oder Form überlebt die Grenze (Z.10) | packages/core/src/auth/http.ts:11 |

## packages/core/src/auth/refresh.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `RefreshRejected` (Klasse) | core · auth/refresh | Refresh abgelehnt; `transient` = Endpoint nicht erreichbar oder 5xx (Z.16) | packages/core/src/auth/refresh.ts:18 |

## packages/core/src/grants/store.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid-grant` | core · grants/store | unklar – prüfen | packages/core/src/grants/store.ts:21 |
| `ceiling-exceeded` | core · grants/store | unklar – prüfen | packages/core/src/grants/store.ts:21 |
| `surface-too-low` | core · grants/store | unklar – prüfen | packages/core/src/grants/store.ts:21 |
| `never-capability` | core · grants/store | unklar – prüfen | packages/core/src/grants/store.ts:21 |
| `duplicate-id` | core · grants/store | unklar – prüfen | packages/core/src/grants/store.ts:21 |
| `GrantError` (Klasse) | core · grants/store | unklar – prüfen | packages/core/src/grants/store.ts:22 |

## packages/core/src/collab/errors.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `unauthorized` | core · collab/errors | unklar – prüfen | packages/core/src/collab/errors.ts:4 |
| `not-found` | core · collab/errors | unklar – prüfen | packages/core/src/collab/errors.ts:4 |
| `conflict` | core · collab/errors | unklar – prüfen | packages/core/src/collab/errors.ts:4 |
| `invalid` | core · collab/errors | unklar – prüfen | packages/core/src/collab/errors.ts:4 |
| `archived` | core · collab/errors | unklar – prüfen | packages/core/src/collab/errors.ts:4 |
| `guardrail` | core · collab/errors | Guardrail-Verweigerung, Grund steht in `guardrail` (Z.1) | packages/core/src/collab/errors.ts:4 |
| `no-scope` | core · collab/errors | unklar – prüfen | packages/core/src/collab/errors.ts:4 |
| `aborted` | core · collab/errors | unklar – prüfen | packages/core/src/collab/errors.ts:4 |
| `storage` | core · collab/errors | unklar – prüfen | packages/core/src/collab/errors.ts:4 |
| `depth` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:9 |
| `cycle` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:9 |
| `self-call` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:9 |
| `fanout` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:9 |
| `pair-limit` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:9 |
| `timeout` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:9 |
| `token-budget` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:9 |
| `cost-budget` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:9 |
| `repeat` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:10 |
| `project-boundary` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:10 |
| `agent-inactive` | core · collab/errors | Guardrail-Grund, unklar – prüfen | packages/core/src/collab/errors.ts:10 |
| `CollabError` (Klasse) | core · collab/errors | unklar – prüfen | packages/core/src/collab/errors.ts:14 |

## packages/core/src/rbac/break-glass.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `not-permitted` | core · rbac/break-glass | unklar – prüfen | packages/core/src/rbac/break-glass.ts:25 |
| `invalid-target` | core · rbac/break-glass | unklar – prüfen | packages/core/src/rbac/break-glass.ts:25 |
| `self-target` | core · rbac/break-glass | unklar – prüfen | packages/core/src/rbac/break-glass.ts:25 |
| `reason-required` | core · rbac/break-glass | unklar – prüfen | packages/core/src/rbac/break-glass.ts:25 |
| `ttl-invalid` | core · rbac/break-glass | unklar – prüfen | packages/core/src/rbac/break-glass.ts:25 |
| `audit-failed` | core · rbac/break-glass | unklar – prüfen | packages/core/src/rbac/break-glass.ts:25 |
| `unknown-grant` | core · rbac/break-glass | unklar – prüfen | packages/core/src/rbac/break-glass.ts:25 |
| `BreakGlassError` (Klasse) | core · rbac/break-glass | unklar – prüfen | packages/core/src/rbac/break-glass.ts:26 |

## packages/core/src/rbac/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `unauthenticated` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:66 |
| `invalid-principal` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:66 |
| `unknown-action` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:66 |
| `resource-mismatch` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:66 |
| `token-scope` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:66 |
| `role-denied` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:67 |
| `not-owner` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:67 |
| `object-right-required` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:67 |
| `break-glass-required` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:67 |
| `audit-failed` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:67 |
| `agent-principal` | core · rbac/types | unklar – prüfen | packages/core/src/rbac/types.ts:67 |

## packages/core/src/identity/store.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid-params` | core · identity/store | unklar – prüfen | packages/core/src/identity/store.ts:7 |
| `not-found` | core · identity/store | unklar – prüfen | packages/core/src/identity/store.ts:7 |
| `invalid-code` | core · identity/store | unklar – prüfen | packages/core/src/identity/store.ts:7 |
| `expired` | core · identity/store | unklar – prüfen | packages/core/src/identity/store.ts:7 |
| `rate-limited` | core · identity/store | unklar – prüfen | packages/core/src/identity/store.ts:7 |
| `conflict` | core · identity/store | unklar – prüfen | packages/core/src/identity/store.ts:7 |
| `limit` | core · identity/store | unklar – prüfen | packages/core/src/identity/store.ts:7 |
| `storage` | core · identity/store | unklar – prüfen | packages/core/src/identity/store.ts:7 |
| `denied` | core · identity/store | unklar – prüfen | packages/core/src/identity/store.ts:7 |
| `IdentityError` (Klasse) | core · identity/store | Fehler des Identity-Stores; `code` ist das Vokabular für den RPC-Layer (Z.6) | packages/core/src/identity/store.ts:8 |

## packages/core/src/a2a/parts.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid` | core · a2a/parts | unklar – prüfen | packages/core/src/a2a/parts.ts:6 |
| `content-type` | core · a2a/parts | unklar – prüfen | packages/core/src/a2a/parts.ts:6 |
| `too-large` | core · a2a/parts | unklar – prüfen | packages/core/src/a2a/parts.ts:6 |
| `too-many` | core · a2a/parts | unklar – prüfen | packages/core/src/a2a/parts.ts:6 |
| `PartError` (Klasse) | core · a2a/parts | unklar – prüfen | packages/core/src/a2a/parts.ts:5 |

## packages/core/src/a2a/push.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `not-supported` | core · a2a/push | unklar – prüfen | packages/core/src/a2a/push.ts:22 |
| `denied` | core · a2a/push | unklar – prüfen | packages/core/src/a2a/push.ts:22 |
| `not-found` | core · a2a/push | unklar – prüfen | packages/core/src/a2a/push.ts:22 |
| `invalid` | core · a2a/push | unklar – prüfen | packages/core/src/a2a/push.ts:22 |
| `PushError` (Klasse) | core · a2a/push | unklar – prüfen | packages/core/src/a2a/push.ts:21 |

## packages/core/src/a2a/tasks.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `not-found` | core · a2a/tasks | unklar – prüfen | packages/core/src/a2a/tasks.ts:19 |
| `not-cancelable` | core · a2a/tasks | unklar – prüfen | packages/core/src/a2a/tasks.ts:19 |
| `too-many` | core · a2a/tasks | unklar – prüfen | packages/core/src/a2a/tasks.ts:19 |
| `no-provider` | core · a2a/tasks | unklar – prüfen | packages/core/src/a2a/tasks.ts:19 |
| `unsupported` | core · a2a/tasks | unklar – prüfen | packages/core/src/a2a/tasks.ts:19 |
| `invalid` | core · a2a/tasks | unklar – prüfen | packages/core/src/a2a/tasks.ts:19 |
| `TaskError` (Klasse) | core · a2a/tasks | unklar – prüfen | packages/core/src/a2a/tasks.ts:18 |

## packages/core/src/a2a/turn-port.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `failed` | core · a2a/turn-port | Turn-Ergebnis mit state "failed" wird als Fehler geworfen | packages/core/src/a2a/turn-port.ts:140 |

## packages/core/src/a2a/handler.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `BodyTooLarge` (Klasse) | core · a2a/handler | Body zu groß | packages/core/src/a2a/handler.ts:24 |
| `Invalid` (Klasse, intern) | core · a2a/handler | Hilfsklasse mit optionalem `reason` | packages/core/src/a2a/handler.ts:311 |

## packages/core/src/secrets/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `denied` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:22 |
| `not-found` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:22 |
| `invalid-name` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:22 |
| `invalid-value` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:22 |
| `invalid-ttl` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:22 |
| `no-backend` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:23 |
| `backend-unavailable` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:23 |
| `corrupt` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:23 |
| `storage` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:23 |
| `audit-unavailable` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:23 |
| `lease-invalid` | core · secrets/types | unklar – prüfen | packages/core/src/secrets/types.ts:23 |
| `SecretError` (Klasse) | core · secrets/types | Meldungen aus festen Texten, Codes und Secret-Namen, nie Werten (Z.25) | packages/core/src/secrets/types.ts:26 |

## packages/core/src/secrets/file-backend.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `dir-not-writable` | core · secrets/file-backend | Fallback-Grund, wenn der Fehler kein SecretError ist | packages/core/src/secrets/file-backend.ts:122 |

## packages/core/src/session/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid` | core · session/types | unklar – prüfen | packages/core/src/session/types.ts:85 |
| `not-found` | core · session/types | unklar – prüfen | packages/core/src/session/types.ts:85 |
| `conflict` | core · session/types | unklar – prüfen | packages/core/src/session/types.ts:85 |
| `immutable` | core · session/types | unklar – prüfen | packages/core/src/session/types.ts:85 |
| `storage` | core · session/types | unklar – prüfen | packages/core/src/session/types.ts:85 |
| `SessionError` (Klasse) | core · session/types | unklar – prüfen | packages/core/src/session/types.ts:86 |

## packages/core/src/session/turn-loop.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `NoProviderError` (Klasse) | core · session/turn-loop | kein Chat-Provider konfiguriert (Ableitung von SessionError) | packages/core/src/session/turn-loop.ts:31 |

## packages/core/src/budget/store.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `newer-schema` | core · budget/store | unklar – prüfen | packages/core/src/budget/store.ts:54 |
| `open-failed` | core · budget/store | unklar – prüfen | packages/core/src/budget/store.ts:54 |
| `BudgetStoreError` (Klasse) | core · budget/store | unklar – prüfen | packages/core/src/budget/store.ts:53 |

## packages/core/src/budget/service.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `budget-exceeded` | core · budget/service | Literal-Code der Klasse (Z.48) | packages/core/src/budget/service.ts:48 |
| `BudgetExceededError` (Klasse) | core · budget/service | unklar – prüfen | packages/core/src/budget/service.ts:47 |
| `BudgetInputError` (Klasse, RangeError) | core · budget/service | ungültige Budget-Eingabe (Name, RangeError) | packages/core/src/budget/service.ts:56 |

## packages/core/src/budget/retry.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `retry_budget_exceeded` | core · budget/retry | Literal-Code der Klasse (Z.10) | packages/core/src/budget/retry.ts:10 |
| `RetryBudgetExceededError` (Klasse) | core · budget/retry | unklar – prüfen | packages/core/src/budget/retry.ts:9 |

## packages/core/src/budget/calls.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `budget_exceeded` | core · budget/calls | Refusal-Code (kind `refuse`, Z.16; Literal Z.34) | packages/core/src/budget/calls.ts:16 |
| `hard` | core · budget/calls | Refusal-Grund (Z.16, Ternär Z.132) | packages/core/src/budget/calls.ts:16 |
| `unpriced-model` | core · budget/calls | Refusal-Grund (Z.16, Ternär Z.132) | packages/core/src/budget/calls.ts:16 |
| `CallBudgetExceededError` (Klasse) | core · budget/calls | unklar – prüfen | packages/core/src/budget/calls.ts:33 |
| `budget_usage_pending` | core · budget/calls | Literal-Code der Klasse (Z.42) | packages/core/src/budget/calls.ts:42 |
| `CallUsagePendingError` (Klasse) | core · budget/calls | unklar – prüfen | packages/core/src/budget/calls.ts:41 |

## packages/core/src/approvals/chain.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `chain-broken` | core · approvals/chain | Literal-Code der Klasse (Z.35) | packages/core/src/approvals/chain.ts:35 |
| `ApprovalChainError` (Klasse) | core · approvals/chain | unklar – prüfen | packages/core/src/approvals/chain.ts:34 |

## packages/core/src/approvals/store.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `ApprovalIntegrityError` (Klasse, erbt ApprovalChainError) | core · approvals/store | unklar – prüfen | packages/core/src/approvals/store.ts:31 |

## packages/core/src/approvals/db.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `newer-schema` | core · approvals/db | unklar – prüfen | packages/core/src/approvals/db.ts:97 |
| `open-failed` | core · approvals/db | unklar – prüfen | packages/core/src/approvals/db.ts:97 |
| `ApprovalsDbError` (Klasse) | core · approvals/db | unklar – prüfen | packages/core/src/approvals/db.ts:96 |

## packages/core/src/approvals/service.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `Refused` (Klasse, intern) | core · approvals/service | unklar – prüfen | packages/core/src/approvals/service.ts:136 |

## packages/core/src/config-load.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `ConfigInvalid` (Klasse) | core · config-load | unklar – prüfen | packages/core/src/config-load.ts:5 |

## packages/core/src/host-tools/errors.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `not_supported_on_platform` | core · host-tools/errors | unklar – prüfen | packages/core/src/host-tools/errors.ts:2 |
| `not_found` | core · host-tools/errors | unklar – prüfen | packages/core/src/host-tools/errors.ts:3 |
| `permission_denied` | core · host-tools/errors | unklar – prüfen | packages/core/src/host-tools/errors.ts:4 |
| `timeout` | core · host-tools/errors | unklar – prüfen | packages/core/src/host-tools/errors.ts:5 |
| `aborted` | core · host-tools/errors | unklar – prüfen | packages/core/src/host-tools/errors.ts:6 |
| `denied_by_denylist` | core · host-tools/errors | unklar – prüfen | packages/core/src/host-tools/errors.ts:7 |
| `invalid_input` | core · host-tools/errors | unklar – prüfen | packages/core/src/host-tools/errors.ts:8 |
| `too_large` | core · host-tools/errors | unklar – prüfen | packages/core/src/host-tools/errors.ts:9 |
| `HostFailure` (Klasse) | core · host-tools/errors | unklar – prüfen | packages/core/src/host-tools/errors.ts:14 |

## packages/core/src/policy/paths.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `not-a-string` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:21 |
| `empty` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:21 |
| `too-long` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:21 |
| `invalid-unicode` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:21 |
| `control-char` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:21 |
| `bidi-control` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:21 |
| `backslash` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:22 |
| `dot-dot` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:22 |
| `relative-no-cwd` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:22 |
| `drive-relative` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:22 |
| `device-path` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:22 |
| `unc-not-allowed` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:22 |
| `short-name` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:23 |
| `alternate-stream` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:23 |
| `forbidden-char` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:23 |
| `trailing-dot-space` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:23 |
| `reserved-device-name` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:23 |
| `special-tree` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:24 |
| `unresolvable` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:24 |
| `dangling-link` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:24 |
| `link-loop` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:24 |
| `not-directory` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:24 |
| `no-identity` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:24 |
| `bad-root` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:25 |
| `root-identity-changed` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:25 |
| `outside-root` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:25 |
| `hard-link` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:25 |
| `deny-listed` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:25 |
| `identity-changed` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:26 |
| `link-swap` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:26 |
| `unsupported-open` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:26 |
| `not-found` | core · policy/paths | unklar – prüfen | packages/core/src/policy/paths.ts:26 |

## packages/core/src/policy/decide.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `policy-never` | core · policy/decide | unklar – prüfen | packages/core/src/policy/decide.ts:111 |
| `deny-list` | core · policy/decide | unklar – prüfen | packages/core/src/policy/decide.ts:111 |
| `surface-untrusted` | core · policy/decide | unklar – prüfen | packages/core/src/policy/decide.ts:111 |
| `repeat-denied` | core · policy/decide | unklar – prüfen | packages/core/src/policy/decide.ts:111 |
| `prompt-cap` | core · policy/decide | unklar – prüfen | packages/core/src/policy/decide.ts:111 |

## packages/core/src/egress/gate.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid-url` | core · egress/gate | unklar – prüfen | packages/core/src/egress/gate.ts:9 |
| `scheme` | core · egress/gate | unklar – prüfen | packages/core/src/egress/gate.ts:9 |
| `port` | core · egress/gate | unklar – prüfen | packages/core/src/egress/gate.ts:9 |
| `host-not-allowed` | core · egress/gate | unklar – prüfen | packages/core/src/egress/gate.ts:9 |
| `loopback` | core · egress/gate | unklar – prüfen | packages/core/src/egress/gate.ts:9 |
| `private-address` | core · egress/gate | unklar – prüfen | packages/core/src/egress/gate.ts:9 |
| `not-found` | core · egress/gate | unklar – prüfen | packages/core/src/egress/gate.ts:9 |
| `EgressDenial` (Klasse, erbt WebFailure) | core · egress/gate | unklar – prüfen | packages/core/src/egress/gate.ts:12 |

## packages/core/src/tools/dispatcher.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `tool-unknown` | core · tools/dispatcher | unklar – prüfen | packages/core/src/tools/dispatcher.ts:42 |
| `tool-call-invalid` | core · tools/dispatcher | unklar – prüfen | packages/core/src/tools/dispatcher.ts:42 |
| `tool-denied` | core · tools/dispatcher | unklar – prüfen | packages/core/src/tools/dispatcher.ts:42 |
| `tool-not-approved` | core · tools/dispatcher | unklar – prüfen | packages/core/src/tools/dispatcher.ts:42 |
| `tool-timeout` | core · tools/dispatcher | unklar – prüfen | packages/core/src/tools/dispatcher.ts:42 |
| `tool-failed` | core · tools/dispatcher | unklar – prüfen | packages/core/src/tools/dispatcher.ts:42 |
| `tool-result-too-large` | core · tools/dispatcher | unklar – prüfen | packages/core/src/tools/dispatcher.ts:43 |
| `tool-result-invalid` | core · tools/dispatcher | unklar – prüfen | packages/core/src/tools/dispatcher.ts:43 |
| `aborted` | core · tools/dispatcher | unklar – prüfen | packages/core/src/tools/dispatcher.ts:43 |

## packages/core/src/tools/registry.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `name` | core · tools/registry | unklar – prüfen | packages/core/src/tools/registry.ts:51 |
| `description` | core · tools/registry | unklar – prüfen | packages/core/src/tools/registry.ts:51 |
| `schema` | core · tools/registry | unklar – prüfen | packages/core/src/tools/registry.ts:51 |
| `capability` | core · tools/registry | unklar – prüfen | packages/core/src/tools/registry.ts:51 |
| `effect` | core · tools/registry | unklar – prüfen | packages/core/src/tools/registry.ts:51 |
| `risk` | core · tools/registry | unklar – prüfen | packages/core/src/tools/registry.ts:51 |
| `limits` | core · tools/registry | unklar – prüfen | packages/core/src/tools/registry.ts:51 |
| `duplicate` | core · tools/registry | unklar – prüfen | packages/core/src/tools/registry.ts:51 |
| `RegistryError` (Klasse) | core · tools/registry | unklar – prüfen | packages/core/src/tools/registry.ts:52 |

## packages/core/src/tools/mcp-bridge.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `schema` | core · tools/mcp-bridge | unklar – prüfen | packages/core/src/tools/mcp-bridge.ts:25 |
| `name` | core · tools/mcp-bridge | unklar – prüfen | packages/core/src/tools/mcp-bridge.ts:25 |
| `too-long` | core · tools/mcp-bridge | unklar – prüfen | packages/core/src/tools/mcp-bridge.ts:25 |
| `collision` | core · tools/mcp-bridge | unklar – prüfen | packages/core/src/tools/mcp-bridge.ts:25 |

## packages/core/src/tools/fs/failure.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid-arguments` | core · tools/fs/failure | Argumente ungültig, korrigieren (TEXTS Z.20) | packages/core/src/tools/fs/failure.ts:6 |
| `path-refused` | core · tools/fs/failure | Pfad außerhalb freigegebener Ordner oder nicht erlaubt (TEXTS Z.21) | packages/core/src/tools/fs/failure.ts:7 |
| `not-found` | core · tools/fs/failure | nichts unter diesem Pfad (TEXTS Z.22) | packages/core/src/tools/fs/failure.ts:8 |
| `not-a-file` | core · tools/fs/failure | kein regulärer File (TEXTS Z.23) | packages/core/src/tools/fs/failure.ts:9 |
| `not-a-directory` | core · tools/fs/failure | kein Verzeichnis (TEXTS Z.24) | packages/core/src/tools/fs/failure.ts:10 |
| `exists` | core · tools/fs/failure | Datei existiert bereits (TEXTS Z.25) | packages/core/src/tools/fs/failure.ts:11 |
| `too-large` | core · tools/fs/failure | Größenlimit überschritten (TEXTS Z.26) | packages/core/src/tools/fs/failure.ts:12 |
| `binary-content` | core · tools/fs/failure | kein gültiges UTF-8-Text (TEXTS Z.27) | packages/core/src/tools/fs/failure.ts:13 |
| `changed` | core · tools/fs/failure | Datei während der Operation geändert, abgebrochen (TEXTS Z.28) | packages/core/src/tools/fs/failure.ts:14 |
| `aborted` | core · tools/fs/failure | abgebrochen (TEXTS Z.29) | packages/core/src/tools/fs/failure.ts:15 |
| `io-error` | core · tools/fs/failure | Dateisystemfehler (TEXTS Z.30) | packages/core/src/tools/fs/failure.ts:16 |
| `internal-error` | core · tools/fs/failure | unerwarteter Fehler im Tool (TEXTS Z.31) | packages/core/src/tools/fs/failure.ts:17 |
| `FsFailure` (Klasse) | core · tools/fs/failure | Typisierter Fehler der Dateitools, Kopfkommentar Z.1-2 | packages/core/src/tools/fs/failure.ts:34 |

## packages/core/src/tools/web/failure.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `invalid-arguments` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:5 |
| `invalid-url` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:6 |
| `private-address` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:7 |
| `egress-denied` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:8 |
| `not-found` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:9 |
| `gone` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:10 |
| `auth-required` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:11 |
| `paywall` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:12 |
| `rate-limited` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:13 |
| `timeout` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:14 |
| `too-large` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:15 |
| `unsupported-type` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:16 |
| `tls-error` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:17 |
| `needs-render` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:18 |
| `too-many-redirects` | core · tools/web/failure | unklar – prüfen | packages/core/src/tools/web/failure.ts:19 |
| `WebFailure` (Klasse) | core · tools/web/failure | Typisierter Fehler der Web-Tools, Kopfkommentar Z.1-3 | packages/core/src/tools/web/failure.ts:62 |

## packages/core/src/tools/web/fetch.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `network-error` | core · tools/web/fetch | Literal-Fallback, wenn der Fehler kein WebFailure ist | packages/core/src/tools/web/fetch.ts:343 |

## packages/core/src/tools/web/search.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `unexpected` | core · tools/web/search | Literal-Fallback, wenn der Fehler kein WebFailure ist | packages/core/src/tools/web/search.ts:207 |

## packages/core/src/tools/exec/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `disabled` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:97 |
| `invalid-input` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:97 |
| `cwd-refused` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:97 |
| `program-refused` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:97 |
| `not-allowlisted` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:97 |
| `env-refused` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:97 |
| `policy-denied` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:98 |
| `approval-denied` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:98 |
| `audit-failed` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:98 |
| `spawn-failed` | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:98 |
| `ExecFailure` (Klasse) | core · tools/exec/types | unklar – prüfen | packages/core/src/tools/exec/types.ts:100 |

## packages/core/src/catalog/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `signature_invalid` | core · catalog/types | unklar – prüfen | packages/core/src/catalog/types.ts:4 |
| `key_unknown` | core · catalog/types | unklar – prüfen | packages/core/src/catalog/types.ts:4 |
| `key_revoked` | core · catalog/types | unklar – prüfen | packages/core/src/catalog/types.ts:4 |
| `rollback_detected` | core · catalog/types | unklar – prüfen | packages/core/src/catalog/types.ts:4 |
| `stale_index` | core · catalog/types | unklar – prüfen | packages/core/src/catalog/types.ts:4 |
| `hash_mismatch` | core · catalog/types | unklar – prüfen | packages/core/src/catalog/types.ts:4 |
| `revoked_package` | core · catalog/types | unklar – prüfen | packages/core/src/catalog/types.ts:4 |
| `transport` | core · catalog/types | unklar – prüfen | packages/core/src/catalog/types.ts:4 |
| `CatalogError` (Klasse) | core · catalog/types | unklar – prüfen | packages/core/src/catalog/types.ts:7 |

## packages/core/src/catalog/ext-index/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `disabled` | core · ext-index/types | Katalog in der Konfiguration abgeschaltet (Z.4) | packages/core/src/catalog/ext-index/types.ts:4 |
| `invalid-config` | core · ext-index/types | URL, Key oder Limit in der Konfiguration unbrauchbar (Z.5) | packages/core/src/catalog/ext-index/types.ts:5 |
| `no-trusted-key` | core · ext-index/types | kein Public-Key konfiguriert, nichts verifizierbar (Z.6) | packages/core/src/catalog/ext-index/types.ts:6 |
| `unreachable` | core · ext-index/types | Egress fehlgeschlagen (Netz, DNS, Timeout, Policy) (Z.7) | packages/core/src/catalog/ext-index/types.ts:7 |
| `http-status` | core · ext-index/types | Server antwortete mit Nicht-200 (Z.8) | packages/core/src/catalog/ext-index/types.ts:8 |
| `too-large` | core · ext-index/types | Body über Größenlimit (Z.9) | packages/core/src/catalog/ext-index/types.ts:9 |
| `signature-invalid` | core · ext-index/types | Signatur mit keinem konfigurierten Key gültig (Z.10) | packages/core/src/catalog/ext-index/types.ts:10 |
| `malformed` | core · ext-index/types | signierte Bytes, kein gültiger v1-Index (Z.11) | packages/core/src/catalog/ext-index/types.ts:11 |
| `unsupported-format` | core · ext-index/types | `format` ist nicht 1 (Z.12) | packages/core/src/catalog/ext-index/types.ts:12 |
| `serial-rollback` | core · ext-index/types | Serial niedriger als die letzte akzeptierte (Z.13) | packages/core/src/catalog/ext-index/types.ts:13 |
| `serial-conflict` | core · ext-index/types | gleiche Serial, anderer Inhalt (Z.14) | packages/core/src/catalog/ext-index/types.ts:14 |
| `expired` | core · ext-index/types | frisch geladener Index bereits abgelaufen (Z.15) | packages/core/src/catalog/ext-index/types.ts:15 |
| `catalog-stale` | core · ext-index/types | Cache-Index abgelaufen, Aufrufer braucht frischen (Z.16) | packages/core/src/catalog/ext-index/types.ts:16 |
| `no-cache` | core · ext-index/types | offline und nichts gecacht (Z.17) | packages/core/src/catalog/ext-index/types.ts:17 |
| `ExtIndexError` (Klasse) | core · ext-index/types | typisierter Fehler des Katalogindex (Z.1) | packages/core/src/catalog/ext-index/types.ts:19 |

## packages/core/src/acp/server.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `parse` | core · acp/server | JSON-RPC -32700 (Wert aus ERR, Z.26) | packages/core/src/acp/server.ts:26 |
| `invalidRequest` | core · acp/server | JSON-RPC -32600 (Z.26) | packages/core/src/acp/server.ts:26 |
| `methodNotFound` | core · acp/server | JSON-RPC -32601 (Z.26) | packages/core/src/acp/server.ts:26 |
| `invalidParams` | core · acp/server | JSON-RPC -32602 (Z.26) | packages/core/src/acp/server.ts:26 |
| `internal` | core · acp/server | JSON-RPC -32603 (Z.26) | packages/core/src/acp/server.ts:26 |
| `busy` | core · acp/server | JSON-RPC -32000 (Z.26) | packages/core/src/acp/server.ts:26 |
| `AcpError` (Klasse) | core · acp/server | unklar – prüfen | packages/core/src/acp/server.ts:28 |

## packages/core/src/audit/chain.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `line-malformed` | core · audit/chain | Zeile nicht parsebar (Emit Z.251) | packages/core/src/audit/chain.ts:25 |
| `hash-mismatch` | core · audit/chain | prev-Hash passt nicht zur Vorgängerzeile (Emit Z.256) | packages/core/src/audit/chain.ts:25 |
| `seq-gap` | core · audit/chain | Sequenzlücke (Emit Z.257) | packages/core/src/audit/chain.ts:25 |
| `prefix-missing` | core · audit/chain | erste Zeile nicht GENESIS/seq 1 (Emit Z.254) | packages/core/src/audit/chain.ts:25 |
| `file-name-mismatch` | core · audit/chain | Rotationsnummer passt nicht zum ersten seq (Emit Z.262) | packages/core/src/audit/chain.ts:25 |
| `torn-tail` | core · audit/chain | unvollständige letzte Zeile (Emit Z.263) | packages/core/src/audit/chain.ts:25 |
| `anchor-missing` | core · audit/chain | Anker fehlt, obwohl Records existieren (Emit Z.268) | packages/core/src/audit/chain.ts:26 |
| `anchor-invalid` | core · audit/chain | Anker ungültig (Emit Z.271) | packages/core/src/audit/chain.ts:26 |
| `anchor-mismatch` | core · audit/chain | Anker passt nicht (Emit Z.277) | packages/core/src/audit/chain.ts:26 |
| `truncated` | core · audit/chain | Kette kürzer als Anker (Emit Z.274) | packages/core/src/audit/chain.ts:26 |

## packages/providers/src/errors.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `auth` | providers · errors | unklar – prüfen | packages/providers/src/errors.ts:19 |
| `rate_limit` | providers · errors | unklar – prüfen | packages/providers/src/errors.ts:20 |
| `overloaded` | providers · errors | unklar – prüfen | packages/providers/src/errors.ts:21 |
| `context_length` | providers · errors | unklar – prüfen | packages/providers/src/errors.ts:22 |
| `invalid_request` | providers · errors | unklar – prüfen | packages/providers/src/errors.ts:23 |
| `network` | providers · errors | unklar – prüfen | packages/providers/src/errors.ts:24 |
| `timeout` | providers · errors | Client-Timeout oder HTTP 408 (Kommentar Z.14) | packages/providers/src/errors.ts:25 |
| `aborted` | providers · errors | Aufrufer hat abgebrochen (Kommentar Z.15) | packages/providers/src/errors.ts:26 |
| `unknown` | providers · errors | nicht verstanden, Protokollfehler mit code "protocol" (Kommentar Z.16) | packages/providers/src/errors.ts:27 |
| `protocol` | providers · errors | Literal-Code bei nicht verstandener Antwort oder unbekanntem HTTP-Status (Z.78, Z.189) | packages/providers/src/errors.ts:78 |
| `redirect` | providers · errors | Literal-Code: unerwarteter 3xx, nicht gefolgt (Z.175) | packages/providers/src/errors.ts:175 |
| `ProviderError` (Klasse) | providers · errors | der einzige Fehlertyp des Adapters, ohne Body oder Credential (Z.45) | packages/providers/src/errors.ts:46 |

## packages/providers/src/gemini/errors.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `API_KEY_INVALID` | providers · gemini/errors | API-Key abgelehnt, Literal-Code (Z.118) | packages/providers/src/gemini/errors.ts:118 |
| `GeminiSafetyBlockError` (Klasse) | providers · gemini/errors | Safety-Block: Antwort ohne nutzbares Ergebnis, nur Urteil (Z.15-16) | packages/providers/src/gemini/errors.ts:17 |

## packages/providers/src/local/guard.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `unavailable` | providers · local/guard | lokaler Provider nicht erreichbar, nicht retrybar (Z.16) | packages/providers/src/local/guard.ts:16 |

## packages/providers/src/local/availability.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `unreachable` | providers · local/availability | unklar – prüfen | packages/providers/src/local/availability.ts:3 |
| `timeout` | providers · local/availability | unklar – prüfen | packages/providers/src/local/availability.ts:3 |
| `refused` | providers · local/availability | unklar – prüfen | packages/providers/src/local/availability.ts:3 |
| `protocol` | providers · local/availability | unklar – prüfen | packages/providers/src/local/availability.ts:3 |
| `no_models` | providers · local/availability | unklar – prüfen | packages/providers/src/local/availability.ts:3 |

## packages/providers/src/local/probe.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `Bad` (Klasse, intern) | providers · local/probe | unklar – prüfen | packages/providers/src/local/probe.ts:10 |

## packages/providers/src/router/router.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `unknown_profile` | providers · router/router | unklar – prüfen | packages/providers/src/router/router.ts:11 |
| `unsupported_strategy` | providers · router/router | unklar – prüfen | packages/providers/src/router/router.ts:11 |
| `no_candidate_available` | providers · router/router | unklar – prüfen | packages/providers/src/router/router.ts:11 |
| `budget_denied` | providers · router/router | unklar – prüfen | packages/providers/src/router/router.ts:11 |
| `attempts_exhausted` | providers · router/router | unklar – prüfen | packages/providers/src/router/router.ts:11 |
| `RouterError` (Klasse) | providers · router/router | Router konnte nicht platzieren, unterscheidet sich von ProviderError (Z.13) | packages/providers/src/router/router.ts:14 |

## packages/providers/src/profiles/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `malformed_model_ref` | providers · profiles/types | unklar – prüfen | packages/providers/src/profiles/types.ts:36 |
| `unknown_provider` | providers · profiles/types | unklar – prüfen | packages/providers/src/profiles/types.ts:37 |
| `unknown_model` | providers · profiles/types | unklar – prüfen | packages/providers/src/profiles/types.ts:38 |
| `duplicate_candidate` | providers · profiles/types | unklar – prüfen | packages/providers/src/profiles/types.ts:39 |
| `empty_candidates` | providers · profiles/types | unklar – prüfen | packages/providers/src/profiles/types.ts:40 |
| `invalid_strategy` | providers · profiles/types | unklar – prüfen | packages/providers/src/profiles/types.ts:41 |
| `aggregator_without_moa` | providers · profiles/types | unklar – prüfen | packages/providers/src/profiles/types.ts:42 |
| `moa_needs_two_candidates` | providers · profiles/types | unklar – prüfen | packages/providers/src/profiles/types.ts:43 |
| `ProfileConfigError` (Klasse) | providers · profiles/types | unklar – prüfen | packages/providers/src/profiles/types.ts:53 |

## packages/embedding-adapters/src/errors.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `auth` | embedding-adapters · errors | 401/403 oder Secret fehlt, Retry hilft nicht (Z.5) | packages/embedding-adapters/src/errors.ts:5 |
| `rate_limit` | embedding-adapters · errors | 429, ggf. retryAfterMs (Z.6) | packages/embedding-adapters/src/errors.ts:6 |
| `overloaded` | embedding-adapters · errors | 5xx / 529, transient (Z.7) | packages/embedding-adapters/src/errors.ts:7 |
| `invalid_request` | embedding-adapters · errors | 4xx durch den Aufrufer (Z.8) | packages/embedding-adapters/src/errors.ts:8 |
| `too_large` | embedding-adapters · errors | 413 oder Input über Limit, teilen oder kürzen (Z.9) | packages/embedding-adapters/src/errors.ts:9 |
| `network` | embedding-adapters · errors | keine Antwort erhalten (Z.10) | packages/embedding-adapters/src/errors.ts:10 |
| `timeout` | embedding-adapters · errors | Per-Attempt-Deadline abgelaufen (Z.11) | packages/embedding-adapters/src/errors.ts:11 |
| `aborted` | embedding-adapters · errors | AbortSignal des Aufrufers (Z.12) | packages/embedding-adapters/src/errors.ts:12 |
| `bad_response` | embedding-adapters · errors | Antwort abgelehnt: Form, Dimension, NaN/Inf, Redirect, zu groß (Z.13) | packages/embedding-adapters/src/errors.ts:13 |
| `AdapterError` (Klasse) | embedding-adapters · errors | einheitliche Fehler-Taxonomie aller Adapter (Z.1) | packages/embedding-adapters/src/errors.ts:32 |

## packages/embedding-adapters/src/config.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `ConfigError` (Klasse) | embedding-adapters · config | unklar – prüfen | packages/embedding-adapters/src/config.ts:16 |

## packages/api/src/errors.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `E_UNAUTHORIZED` | api · errors | HTTP 401, Authentifizierung nötig (Z.28) | packages/api/src/errors.ts:28 |
| `E_NOT_FOUND` | api · errors | HTTP 404, Route unbekannt (Z.30) | packages/api/src/errors.ts:30 |
| `E_INVALID_PARAMS` | api · errors | Fälle 405/413/415 (Z.31-34) | packages/api/src/errors.ts:31 |
| `E_DENIED` | api · errors | Fälle 403/421/429 (Z.35-41) | packages/api/src/errors.ts:35 |
| `E_NOT_AVAILABLE` | api · errors | HTTP 504, Request-Timeout (Z.40) | packages/api/src/errors.ts:40 |
| `E_INTERNAL` | api · errors | Core-Fehler wird auf 502 abgebildet (Z.63) | packages/api/src/errors.ts:63 |
| `E_STORAGE` | api · errors | Core-Fehler wird auf 502 abgebildet (Z.63) | packages/api/src/errors.ts:63 |
| `E_RPC_VERSION` | api · errors | Core-Handshake-Fehler wird auf 502 abgebildet (Z.65) | packages/api/src/errors.ts:65 |
| `E_CORE_UNAVAILABLE` | api · errors | HTTP 502/503, Core nicht erreichbar (Z.63-71) | packages/api/src/errors.ts:63 |
| `ApiError` (Klasse) | api · errors | Typisierter API-Fehler (Z.18) | packages/api/src/errors.ts:18 |

## packages/media/src/types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `content_policy` | media · types | unklar – prüfen | packages/media/src/types.ts:3 |
| `quota` | media · types | unklar – prüfen | packages/media/src/types.ts:3 |
| `too_large` | media · types | unklar – prüfen | packages/media/src/types.ts:3 |
| `unsupported_parameter` | media · types | unklar – prüfen | packages/media/src/types.ts:3 |
| `backend_unavailable` | media · types | unklar – prüfen | packages/media/src/types.ts:3 |
| `timeout` | media · types | unklar – prüfen | packages/media/src/types.ts:3 |
| `cancelled` | media · types | unklar – prüfen | packages/media/src/types.ts:3 |
| `invalid_response` | media · types | unklar – prüfen | packages/media/src/types.ts:3 |
| `interrupted` | media · types | unklar – prüfen | packages/media/src/types.ts:3 |
| `MediaError` (Klasse) | media · types | speichert nur einen stabilen Code, keine Bodies oder URLs (Z.4) | packages/media/src/types.ts:5 |

## packages/channels-telegram/src/api.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `bad-request` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:4 |
| `forbidden` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:5 |
| `rate-limited` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:6 |
| `unauthorized` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:7 |
| `conflict` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:8 |
| `http` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:9 |
| `network` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:10 |
| `timeout` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:11 |
| `aborted` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:12 |
| `protocol` | channels-telegram · api | unklar – prüfen | packages/channels-telegram/src/api.ts:13 |
| `TelegramApiError` (Klasse) | channels-telegram · api | Aus festem Text und redactierter Telegram-Beschreibung, nie mit Request-URL (Z.15) | packages/channels-telegram/src/api.ts:16 |

## packages/module-api/src/client.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `RpcCallError` (Klasse) | module-api · client | unklar – prüfen | packages/module-api/src/client.ts:5 |

## packages/module-api/src/rpc-error.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `RpcError` (Klasse) | module-api · rpc-error | unklar – prüfen | packages/module-api/src/rpc-error.ts:11 |

## packages/module-api/src/framing.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `LineTooLong` (Klasse) | module-api · framing | Zeile über MAX_LINE_BYTES (Z.1) | packages/module-api/src/framing.ts:3 |

## packages/module-api/src/trust.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `UntrustedRunDir` (Klasse) | module-api · trust | `run/` ist nicht vertrauenswürdig, nichts gelesen (Z.82) | packages/module-api/src/trust.ts:83 |

## packages/log-schema/src/index.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `not_object` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:117 |
| `invalid_level` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:118 |
| `unknown_event` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:119 |
| `wrong_stream` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:120 |
| `msg_too_long` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:121 |
| `attrs_too_large` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:122 |
| `schema` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:123 |
| `key_order` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:124 |
| `level_not_allowed` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:125 |
| `source_kind_not_allowed` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:126 |
| `stream_mismatch` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:127 |
| `attrs_invalid` | log-schema · index | unklar – prüfen | packages/log-schema/src/index.ts:128 |

## packages/web/src/api/errors.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `E_UNAUTHORIZED` | web · api/errors | Kopie des ErrorCode-Enums aus docs/rpc.md (Z.4-5) | packages/web/src/api/errors.ts:7 |
| `E_RPC_VERSION` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:7 |
| `E_NOT_AVAILABLE` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:7 |
| `E_CORE_UNAVAILABLE` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:7 |
| `E_INVALID_PARAMS` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:7 |
| `E_AGENT_UNKNOWN` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:7 |
| `E_CONFIG_INVALID` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:7 |
| `E_MODULE_UNKNOWN` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:8 |
| `E_INTERNAL` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:8 |
| `E_LOCKED` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:8 |
| `E_NOT_FOUND` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:8 |
| `E_DENIED` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:8 |
| `E_APPROVAL_REQUIRED` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:8 |
| `E_CONFLICT` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:8 |
| `E_STORAGE` | web · api/errors | Kopie des ErrorCode-Enums (Z.4-5) | packages/web/src/api/errors.ts:8 |
| `UnauthenticatedError` (Klasse) | web · api/errors | 401 bei Read oder RPC E_UNAUTHORIZED (Z.16) | packages/web/src/api/errors.ts:17 |
| `SessionExpiredError` (Klasse) | web · api/errors | 401 bei Write oder CSRF-Fetch (Z.21) | packages/web/src/api/errors.ts:22 |
| `ForbiddenError` (Klasse) | web · api/errors | 403 ohne csrf-Reason oder RPC E_DENIED (Z.26) | packages/web/src/api/errors.ts:27 |
| `CsrfError` (Klasse) | web · api/errors | CSRF-Token zweimal abgelehnt (Z.33) | packages/web/src/api/errors.ts:34 |
| `UnavailableError` (Klasse) | web · api/errors | Backend nicht da: 404/405/501-504, kein Netz, kein Wire-Format (Z.38-40) | packages/web/src/api/errors.ts:41 |
| `RpcError` (Klasse) | web · api/errors | JSON-RPC-Fehlerobjekt (Z.52-53) | packages/web/src/api/errors.ts:54 |
| `HttpError` (Klasse) | web · api/errors | sonstige Non-2xx-Antwort (Z.64) | packages/web/src/api/errors.ts:65 |
| `AbortedError` (Klasse) | web · api/errors | AbortSignal des Aufrufers (Z.75) | packages/web/src/api/errors.ts:76 |

## packages/web/src/pages/common/load.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `forbidden` | web · pages/common/load | unklar – prüfen | packages/web/src/pages/common/load.ts:9 |
| `unavailable` | web · pages/common/load | unklar – prüfen | packages/web/src/pages/common/load.ts:9 |
| `not-found` | web · pages/common/load | unklar – prüfen | packages/web/src/pages/common/load.ts:9 |
| `error` | web · pages/common/load | unklar – prüfen | packages/web/src/pages/common/load.ts:9 |

## packages/web/src/pages/models/rpc-types.ts
| Code | Module | Meaning | Source |
|---|---|---|---|
| `failed:auth` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:32 |
| `failed:network` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:32 |
| `failed:server` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:32 |
| `failed:invalid` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:32 |
| `failed:empty` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:32 |
| `already_running` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:33 |
| `disabled` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:33 |
| `no-scanner` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:33 |
| `role_unavailable` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:36 |
| `shadowed_by_manual` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:36 |
| `empty_list` | web · models/rpc-types | unklar – prüfen | packages/web/src/pages/models/rpc-types.ts:36 |

## crates/plur1bus-config/src/lib.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `NotJson` | plur1bus-config · lib | unklar – prüfen | crates/plur1bus-config/src/lib.rs:13 |
| `Invalid` | plur1bus-config · lib | unklar – prüfen | crates/plur1bus-config/src/lib.rs:14 |
| `Io` | plur1bus-config · lib | I/O-Fehler (From-Impl Z.18-20) | crates/plur1bus-config/src/lib.rs:15 |
| `UnknownKey` | plur1bus-config · lib | unklar – prüfen | crates/plur1bus-config/src/lib.rs:16 |

## crates/plur1bus-log-schema/src/lib.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `NotObject` | plur1bus-log-schema · lib | Ablehnungsgrund; Prüfreihenfolge laut Enum-Doc (Z.415), Schreibweise siehe as_str (Z.436) | crates/plur1bus-log-schema/src/lib.rs:418 |
| `InvalidLevel` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.437) | crates/plur1bus-log-schema/src/lib.rs:419 |
| `UnknownEvent` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.438) | crates/plur1bus-log-schema/src/lib.rs:420 |
| `WrongStream` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.439) | crates/plur1bus-log-schema/src/lib.rs:421 |
| `MsgTooLong` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.440) | crates/plur1bus-log-schema/src/lib.rs:422 |
| `AttrsTooLarge` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.441) | crates/plur1bus-log-schema/src/lib.rs:423 |
| `Schema` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.442) | crates/plur1bus-log-schema/src/lib.rs:424 |
| `KeyOrder` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.443) | crates/plur1bus-log-schema/src/lib.rs:425 |
| `LevelNotAllowed` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.444) | crates/plur1bus-log-schema/src/lib.rs:426 |
| `SourceKindNotAllowed` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.445) | crates/plur1bus-log-schema/src/lib.rs:427 |
| `StreamMismatch` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.446) | crates/plur1bus-log-schema/src/lib.rs:428 |
| `AttrsInvalid` | plur1bus-log-schema · lib | Ablehnungsgrund (as_str Z.447) | crates/plur1bus-log-schema/src/lib.rs:429 |

## crates/plur1bus-rpc/src/error.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `Call` (Variante RpcError) | plur1bus-rpc · error | Fehler vom Core mit ErrorCode, reason, detail (Z.7-19) | crates/plur1bus-rpc/src/error.rs:7 |
| `Unavailable` (Variante RpcError) | plur1bus-rpc · error | Core nicht erreichbar (Display Z.58) | crates/plur1bus-rpc/src/error.rs:20 |
| `Version` (Variante RpcError) | plur1bus-rpc · error | RPC-Major-Mismatch (Display Z.61) | crates/plur1bus-rpc/src/error.rs:24 |
| `Protocol` (Variante RpcError) | plur1bus-rpc · error | Protokollfehler, z.B. ungültige Bytes (Z.74-76) | crates/plur1bus-rpc/src/error.rs:27 |
| `E_CORE_UNAVAILABLE` | plur1bus-rpc · error | Exit-/JSON-Code für Unavailable (Z.116) | crates/plur1bus-rpc/src/error.rs:116 |
| `E_RPC_VERSION` | plur1bus-rpc · error | Exit-/JSON-Code für Version (Z.117) | crates/plur1bus-rpc/src/error.rs:117 |
| `E_INTERNAL` | plur1bus-rpc · error | Exit-/JSON-Code für Protocol und Fallback (Z.36, Z.118) | crates/plur1bus-rpc/src/error.rs:118 |

## crates/plur1bus/src/firstaid_bundle/mod.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `Refused` | plur1bus · firstaid_bundle | Re-Scan findet, was der Redactor hätte entfernen müssen (Z.33) | crates/plur1bus/src/firstaid_bundle/mod.rs:34 |
| `Io` | plur1bus · firstaid_bundle | I/O-Fehler (From-Impl Z.38) | crates/plur1bus/src/firstaid_bundle/mod.rs:35 |

## crates/plur1bus/src/service/mod.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `Io` | plur1bus · service | Unit-Datei lesen oder schreiben fehlgeschlagen (Z.86) | crates/plur1bus/src/service/mod.rs:87 |
| `Spawn` | plur1bus · service | Manager-Befehl nicht startbar, z.B. systemctl fehlt (Z.88) | crates/plur1bus/src/service/mod.rs:89 |
| `Command` | plur1bus · service | Manager-Befehl lief und scheiterte (Z.90) | crates/plur1bus/src/service/mod.rs:91 |
| `PathNotUtf8` | plur1bus · service | Pfad im Unit ist nicht UTF-8 (Z.97) | crates/plur1bus/src/service/mod.rs:98 |
| `PathHasPercent` | plur1bus · service | Task Scheduler expandiert `%` im Pfad (Z.99-100) | crates/plur1bus/src/service/mod.rs:101 |
| `StillLoaded` | plur1bus · service | Job nach Stop-Timeout noch geladen (Z.102) | crates/plur1bus/src/service/mod.rs:103 |

## crates/plur1bus/src/install/fetch.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `Unreachable` | plur1bus · install/fetch | Quelle nicht erreichbar oder nicht lesbar (Z.18-19) | crates/plur1bus/src/install/fetch.rs:20 |
| `Http` | plur1bus · install/fetch | Nicht-Erfolgs-Status des Servers (Z.21) | crates/plur1bus/src/install/fetch.rs:22 |
| `TooLarge` | plur1bus · install/fetch | Quelle größer als Limit, nichts behalten (Z.23) | crates/plur1bus/src/install/fetch.rs:24 |
| `DigestMismatch` | plur1bus · install/fetch | SHA-256 weicht vom Pin ab, nichts behalten (Z.25) | crates/plur1bus/src/install/fetch.rs:26 |
| `Io` | plur1bus · install/fetch | Schreiben der lokalen Kopie fehlgeschlagen (Z.27) | crates/plur1bus/src/install/fetch.rs:28 |

## crates/plur1bus/src/install/archive.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `UnsafeEntry` | plur1bus · install/archive | Eintrag könnte außerhalb von `into` schreiben (Z.27) | crates/plur1bus/src/install/archive.rs:28 |
| `Unsupported` | plur1bus · install/archive | kein tar.gz/zip, korrupt oder Eintragsart nicht erzeugbar (Z.29) | crates/plur1bus/src/install/archive.rs:30 |
| `TooLarge` | plur1bus · install/archive | entpackt größer als MAX_EXTRACTED_BYTES (Z.31) | crates/plur1bus/src/install/archive.rs:32 |
| `Io` | plur1bus · install/archive | Schreiben des entpackten Baums fehlgeschlagen (Z.33) | crates/plur1bus/src/install/archive.rs:34 |
| `DigestMismatch` (PayloadError) | plur1bus · install/archive | Digest-Prüfung von verify_and_extract (Z.62-63) | crates/plur1bus/src/install/archive.rs:65 |
| `Archive` (PayloadError) | plur1bus · install/archive | Extraktionsfehler, umschließt ArchiveError (Z.62-63) | crates/plur1bus/src/install/archive.rs:66 |
| `Io` (PayloadError) | plur1bus · install/archive | unklar – prüfen | crates/plur1bus/src/install/archive.rs:67 |

## crates/plur1bus/src/supervisor/config.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `Invalid` (SetError) | plur1bus · supervisor/config | Schema lehnt das Ergebnis ab, E_CONFIG_INVALID (Z.53) | crates/plur1bus/src/supervisor/config.rs:54 |
| `ForeignHostStorePath` (SetError) | plur1bus · supervisor/config | Engine-Store würde fremdes Host-Verzeichnis teilen, E_CONFIG_INVALID (Z.55) | crates/plur1bus/src/supervisor/config.rs:56 |
| `Conflict` (SetError) | plur1bus · supervisor/config | ifRevision nennt andere Revision, E_CONFLICT (Z.57) | crates/plur1bus/src/supervisor/config.rs:58 |
| `Unavailable` (SetError) | plur1bus · supervisor/config | keine gültige Konfiguration läuft, E_NOT_AVAILABLE (Z.59) | crates/plur1bus/src/supervisor/config.rs:60 |
| `Io` (SetError) | plur1bus · supervisor/config | Datei nicht sicherbar oder schreibbar, nichts geändert, E_INTERNAL (Z.61) | crates/plur1bus/src/supervisor/config.rs:62 |

## crates/plur1bus/src/supervisor/state.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `LockHeld` | plur1bus · supervisor/state | unklar – prüfen | crates/plur1bus/src/supervisor/state.rs:67 |
| `ConfigInvalid` | plur1bus · supervisor/state | unklar – prüfen | crates/plur1bus/src/supervisor/state.rs:68 |
| `EngineContract` | plur1bus · supervisor/state | unklar – prüfen | crates/plur1bus/src/supervisor/state.rs:69 |
| `ReadyTimeout` | plur1bus · supervisor/state | unklar – prüfen | crates/plur1bus/src/supervisor/state.rs:70 |
| `AdoptedExit` | plur1bus · supervisor/state | unklar – prüfen | crates/plur1bus/src/supervisor/state.rs:71 |
| `ManifestInvalid` | plur1bus · supervisor/state | unklar – prüfen | crates/plur1bus/src/supervisor/state.rs:72 |
| `ApiVersionUnsupported` | plur1bus · supervisor/state | API-Version nicht unterstützt (B12, Doc Z.63) | crates/plur1bus/src/supervisor/state.rs:73 |
| `GaveUp` | plur1bus · supervisor/state | Backoff aufgegeben: fünf Exits im Fenster (Doc Z.63-64) | crates/plur1bus/src/supervisor/state.rs:74 |
| `None` | plur1bus · supervisor/state | unklar – prüfen | crates/plur1bus/src/supervisor/state.rs:75 |

## crates/plur1bus/src/modules/install.rs
| Code | Module | Meaning | Source |
|---|---|---|---|
| `NotADirectory` | plur1bus · modules/install | Quelle fehlt oder ist kein Verzeichnis (Z.17) | crates/plur1bus/src/modules/install.rs:18 |
| `Manifest` | plur1bus · modules/install | module.json fehlt, ist ungültig oder entry fehlt (Z.19) | crates/plur1bus/src/modules/install.rs:20 |
| `Symlink` | plur1bus · modules/install | Symlink im Quellbaum (Z.21) | crates/plur1bus/src/modules/install.rs:22 |
| `SpecialFile` | plur1bus · modules/install | FIFO, Socket oder Device im Quellbaum (Z.23) | crates/plur1bus/src/modules/install.rs:24 |
| `EntryOutside` | plur1bus · modules/install | entry ist absolut oder liegt außerhalb (Z.25) | crates/plur1bus/src/modules/install.rs:26 |
| `Reserved` | plur1bus · modules/install | reservierter Modulname: core, supervisor (Z.27) | crates/plur1bus/src/modules/install.rs:28 |
| `SocketPathTooLong` | plur1bus · modules/install | Socket-Pfad überschreitet sun_path (Z.29-30) | crates/plur1bus/src/modules/install.rs:31 |
| `Io` | plur1bus · modules/install | Kopieren, Umbenennen oder Entfernen fehlgeschlagen (Z.32) | crates/plur1bus/src/modules/install.rs:33 |

