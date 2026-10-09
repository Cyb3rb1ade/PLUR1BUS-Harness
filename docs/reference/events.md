# Event reference

This reference is extracted from source, not generated. The first table lists the event catalogue in `packages/log-schema/schema/catalogue.json`. The second lists typed events emitted from `packages/*/src` and `crates/*/src` (tests excluded). Re-check against source when the code changes.

Conventions:
- Catalogue `Fields`: the closed attribute group of each entry (`attrGroups`). `*` marks a required attribute (`requiredAttrs`). Common attributes (`repeat`, `window_ms`, `link_trace_id`, `foreign_message`, `untrusted`, `truncated`, `bytes`) apply to every event and are not repeated. Audit groups `audit_licence`, `audit_setup`, `audit_repair`, `audit_ext_install`, `audit_ext_state`, `audit_ext_remove` are open and tolerate further keys.
- Module `Fields`: the keys of the object literal at the emit site.
- `†` in the module table: the same name exists in the catalogue (possibly on another stream).
- `Source module` in the module table: the emitting module, followed by the stream in parentheses (`log`, `audit`, `bus`, `notify`, `broadcast`).

## Catalog events (log schema)

| Event | Source module | Fields | Source |
|---|---|---|---|
| `log.level.changed` | any (diagnostic) | source_key*, from, to*, until | packages/log-schema/schema/catalogue.json:1433 |
| `log.level.expired` | any (diagnostic) | source_key*, from*, to, until | packages/log-schema/schema/catalogue.json:1480 |
| `log.suppressed` | any (diagnostic) | dropped*, window_ms, reason | packages/log-schema/schema/catalogue.json:1527 |
| `log.unregistered` | any (diagnostic) | attempted* | packages/log-schema/schema/catalogue.json:1572 |
| `log.unattributed` | any (diagnostic) | original*, expected_source, file | packages/log-schema/schema/catalogue.json:1615 |
| `log.retention.pruned` | any (diagnostic) | stream*, files*, bytes, older_than_days | packages/log-schema/schema/catalogue.json:1661 |
| `log.redaction.failed` | any (diagnostic) | attempted_event* | packages/log-schema/schema/catalogue.json:1708 |
| `process.output.line` | any (diagnostic) | text*, untrusted* | packages/log-schema/schema/catalogue.json:1751 |
| `process.output.suppressed` | any (diagnostic) | dropped*, window_ms* | packages/log-schema/schema/catalogue.json:1799 |
| `supervisor.process.started` | harness (diagnostic) | role*, pid*, version, reason | packages/log-schema/schema/catalogue.json:1846 |
| `supervisor.process.stopping` | harness (diagnostic) | role*, pid, version, reason | packages/log-schema/schema/catalogue.json:1884 |
| `supervisor.process.exited` | harness (diagnostic) | role, pid, exit_code*, signal, planned*, expected_code | packages/log-schema/schema/catalogue.json:1921 |
| `supervisor.child.spawned` | harness (diagnostic) | role*, pid*, version, reason | packages/log-schema/schema/catalogue.json:1964 |
| `supervisor.child.exited` | harness (diagnostic) | role*, pid, exit_code, signal, planned*, expected_code | packages/log-schema/schema/catalogue.json:2002 |
| `supervisor.child.restarting` | harness (diagnostic) | role*, attempt*, delay_ms*, exit_code, signal, reason | packages/log-schema/schema/catalogue.json:2045 |
| `supervisor.child.given_up` | harness (diagnostic) | role*, attempts*, window_ms, reason | packages/log-schema/schema/catalogue.json:2086 |
| `supervisor.health.failed` | harness (diagnostic) | role*, consecutive_failures, timeout_ms, reason | packages/log-schema/schema/catalogue.json:2130 |
| `supervisor.health.hung` | harness (diagnostic) | role*, consecutive_failures, timeout_ms*, reason | packages/log-schema/schema/catalogue.json:2167 |
| `supervisor.adoption.completed` | harness (diagnostic) | role*, pid* | packages/log-schema/schema/catalogue.json:2205 |
| `supervisor.config.applied` | harness (diagnostic) | keys*, revision, restart_class, reason | packages/log-schema/schema/catalogue.json:2242 |
| `supervisor.config.rejected` | harness (diagnostic) | keys, revision, restart_class, reason* | packages/log-schema/schema/catalogue.json:2281 |
| `supervisor.subscriber.dropped` | harness (diagnostic) | channel*, reason*, queued | packages/log-schema/schema/catalogue.json:2321 |
| `core.process.started` | harness (diagnostic) | role, pid*, version, reason | packages/log-schema/schema/catalogue.json:2359 |
| `core.process.ready` | harness (diagnostic) | role, pid*, version, reason | packages/log-schema/schema/catalogue.json:2396 |
| `core.process.stopping` | harness (diagnostic) | role, pid, version, reason | packages/log-schema/schema/catalogue.json:2434 |
| `core.config.applied` | harness (diagnostic) | keys*, revision, restart_class, reason | packages/log-schema/schema/catalogue.json:2469 |
| `core.config.fallback` | harness (diagnostic) | keys, revision, restart_class, reason* | packages/log-schema/schema/catalogue.json:2508 |
| `core.watch.lost` | harness (diagnostic) | keys, revision, restart_class, reason* | packages/log-schema/schema/catalogue.json:2548 |
| `core.orphan.detected` | harness (diagnostic) | role, pid*, version, reason | packages/log-schema/schema/catalogue.json:2588 |
| `core.rpc.failed` | harness (diagnostic) | method*, reason, peer | packages/log-schema/schema/catalogue.json:2625 |
| `engine.status.degraded` | harness (diagnostic) | status*, component*, reason | packages/log-schema/schema/catalogue.json:2669 |
| `engine.status.failed` | harness (diagnostic) | status*, component*, reason | packages/log-schema/schema/catalogue.json:2707 |
| `engine.recall.completed` | harness (diagnostic) | soft_budget_ms, hard_budget_ms, results*, degraded_reason | packages/log-schema/schema/catalogue.json:2745 |
| `engine.recall.budget_exceeded` | harness (diagnostic) | soft_budget_ms, hard_budget_ms*, results, degraded_reason | packages/log-schema/schema/catalogue.json:2785 |
| `engine.capture.failed` | harness (diagnostic) | operation*, reason*, agent_count | packages/log-schema/schema/catalogue.json:2825 |
| `engine.acl.denied` | harness (diagnostic) | operation*, reason, agent_count | packages/log-schema/schema/catalogue.json:2864 |
| `engine.model.loading` | harness (diagnostic) | model*, runtime, reason | packages/log-schema/schema/catalogue.json:2901 |
| `engine.model.ready` | harness (diagnostic) | model*, runtime, reason | packages/log-schema/schema/catalogue.json:2937 |
| `scheduler.run.started` | harness (diagnostic) | job*, run_id, reason, attempt | packages/log-schema/schema/catalogue.json:2974 |
| `scheduler.run.skipped` | harness (diagnostic) | job*, run_id, reason*, attempt | packages/log-schema/schema/catalogue.json:3011 |
| `scheduler.run.completed` | harness (diagnostic) | job*, run_id, reason, attempt | packages/log-schema/schema/catalogue.json:3051 |
| `scheduler.run.failed` | harness (diagnostic) | job*, run_id, reason*, attempt | packages/log-schema/schema/catalogue.json:3089 |
| `api.request.completed` | harness (diagnostic) | method*, route*, status*, reason | packages/log-schema/schema/catalogue.json:3128 |
| `api.auth.failed` | harness (diagnostic) | method*, route*, status, reason | packages/log-schema/schema/catalogue.json:3170 |
| `api.rate.limited` | harness (diagnostic) | method*, route*, status, reason | packages/log-schema/schema/catalogue.json:3208 |
| `api.stream.dropped` | harness (diagnostic) | method, route*, status, reason* | packages/log-schema/schema/catalogue.json:3246 |
| `module.process.started` | harness (diagnostic) | module*, reason, keys | packages/log-schema/schema/catalogue.json:3285 |
| `module.config.invalid` | harness (diagnostic) | module*, reason, keys* | packages/log-schema/schema/catalogue.json:3324 |
| `module.core.connected` | harness (diagnostic) | module*, reason, keys | packages/log-schema/schema/catalogue.json:3364 |
| `module.core.lost` | harness (diagnostic) | module*, reason, keys | packages/log-schema/schema/catalogue.json:3403 |
| `ext.load.failed` | extension (diagnostic) | extension*, reason* | packages/log-schema/schema/catalogue.json:3442 |
| `mcp.server.started` | extension (diagnostic) | server*, tool, timeout_ms, attempt, exit_code, signal, planned, protocol_code | packages/log-schema/schema/catalogue.json:3479 |
| `mcp.server.exited` | extension (diagnostic) | server*, tool, timeout_ms, attempt, exit_code, signal, planned*, protocol_code | packages/log-schema/schema/catalogue.json:3516 |
| `mcp.server.timeout` | extension (diagnostic) | server*, tool, timeout_ms*, attempt, exit_code, signal, planned, protocol_code | packages/log-schema/schema/catalogue.json:3557 |
| `mcp.call.completed` | extension (diagnostic) | server*, tool*, timeout_ms, attempt, exit_code, signal, planned, protocol_code | packages/log-schema/schema/catalogue.json:3596 |
| `mcp.call.failed` | extension (diagnostic) | server*, tool*, timeout_ms, attempt, exit_code, signal, planned, protocol_code | packages/log-schema/schema/catalogue.json:3637 |
| `skill.script.exited` | extension (diagnostic) | skill*, script*, exit_code*, signal | packages/log-schema/schema/catalogue.json:3680 |
| `provider.request.completed` | provider (diagnostic) | model*, capability*, provider_request_id, http_status, retry_after_s, retry_in_ms, attempt, max_attempts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ttft_ms, finish_reason, limit, remaining, reset_s | packages/log-schema/schema/catalogue.json:3722 |
| `provider.request.retrying` | provider (diagnostic) | model*, capability, provider_request_id, http_status, retry_after_s, retry_in_ms*, attempt*, max_attempts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ttft_ms, finish_reason, limit, remaining, reset_s | packages/log-schema/schema/catalogue.json:3766 |
| `provider.request.failed` | provider (diagnostic) | model*, capability*, provider_request_id, http_status, retry_after_s, retry_in_ms, attempt, max_attempts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ttft_ms, finish_reason, limit, remaining, reset_s | packages/log-schema/schema/catalogue.json:3811 |
| `provider.rate.limited` | provider (diagnostic) | model*, capability, provider_request_id, http_status, retry_after_s, retry_in_ms, attempt, max_attempts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ttft_ms, finish_reason, limit, remaining, reset_s | packages/log-schema/schema/catalogue.json:3863 |
| `provider.oauth.refreshed` | provider (diagnostic) | profile*, expires_in_s, reason | packages/log-schema/schema/catalogue.json:3905 |
| `provider.oauth.refresh_failed` | provider (diagnostic) | profile*, expires_in_s, reason* | packages/log-schema/schema/catalogue.json:3941 |
| `provider.auth.expiring` | provider (diagnostic) | profile*, expires_in_s*, reason | packages/log-schema/schema/catalogue.json:3985 |
| `provider.payload.captured` | provider (payload) | agent*, capture_id*, bytes | packages/log-schema/schema/catalogue.json:4022 |
| `model.load.started` | model (diagnostic) | model*, runtime, rss_mb, reason, exit_code, signal, planned | packages/log-schema/schema/catalogue.json:4061 |
| `model.load.completed` | model (diagnostic) | model*, runtime, rss_mb, reason, exit_code, signal, planned | packages/log-schema/schema/catalogue.json:4097 |
| `model.load.failed` | model (diagnostic) | model*, runtime, rss_mb, reason*, exit_code, signal, planned | packages/log-schema/schema/catalogue.json:4134 |
| `model.process.exited` | model (diagnostic) | model*, runtime, rss_mb, reason, exit_code, signal, planned* | packages/log-schema/schema/catalogue.json:4178 |
| `model.memory.pressure` | model (diagnostic) | model*, runtime, rss_mb*, reason, exit_code, signal, planned | packages/log-schema/schema/catalogue.json:4218 |
| `model.unloaded` | model (diagnostic) | model*, runtime, rss_mb, reason, exit_code, signal, planned | packages/log-schema/schema/catalogue.json:4256 |
| `cli.session.started` | cli (diagnostic) | cli*, exit_code, signal, planned, acp_code, reason | packages/log-schema/schema/catalogue.json:4292 |
| `cli.session.exited` | cli (diagnostic) | cli*, exit_code*, signal, planned, acp_code, reason | packages/log-schema/schema/catalogue.json:4329 |
| `cli.acp.failed` | cli (diagnostic) | cli*, exit_code, signal, planned, acp_code*, reason | packages/log-schema/schema/catalogue.json:4369 |
| `cli.login.required` | cli (diagnostic) | cli*, exit_code, signal, planned, acp_code, reason | packages/log-schema/schema/catalogue.json:4414 |
| `channel.connection.lost` | channel (diagnostic) | channel*, account, attempt, retry_after_s, reason, delivered | packages/log-schema/schema/catalogue.json:4451 |
| `channel.connection.restored` | channel (diagnostic) | channel*, account, attempt, retry_after_s, reason, delivered | packages/log-schema/schema/catalogue.json:4488 |
| `channel.message.received` | channel (diagnostic) | channel*, account, attempt, retry_after_s, reason, delivered | packages/log-schema/schema/catalogue.json:4525 |
| `channel.message.sent` | channel (diagnostic) | channel*, account, attempt, retry_after_s, reason, delivered | packages/log-schema/schema/catalogue.json:4565 |
| `channel.delivery.failed` | channel (diagnostic) | channel*, account, attempt, retry_after_s, reason*, delivered | packages/log-schema/schema/catalogue.json:4605 |
| `channel.rate.limited` | channel (diagnostic) | channel*, account, attempt, retry_after_s, reason, delivered | packages/log-schema/schema/catalogue.json:4651 |
| `host.helper.connected` | host (diagnostic) | helper*, capability, reason | packages/log-schema/schema/catalogue.json:4688 |
| `host.helper.lost` | host (diagnostic) | helper*, capability, reason | packages/log-schema/schema/catalogue.json:4724 |
| `host.call.denied` | host (diagnostic) | helper, capability*, reason | packages/log-schema/schema/catalogue.json:4760 |
| `host.signature.invalid` | host (diagnostic) | helper*, capability, reason | packages/log-schema/schema/catalogue.json:4797 |
| `host.bridge.failed` | host (diagnostic) | helper*, capability, reason* | packages/log-schema/schema/catalogue.json:4839 |
| `desktop.app.started` | desktop (diagnostic) | component*, reason, crash_id, exit_code | packages/log-schema/schema/catalogue.json:4882 |
| `desktop.app.crashed` | desktop (diagnostic) | component*, reason, crash_id*, exit_code | packages/log-schema/schema/catalogue.json:4918 |
| `desktop.connection.lost` | desktop (diagnostic) | component*, reason, crash_id, exit_code | packages/log-schema/schema/catalogue.json:4963 |
| `desktop.webview.failed` | desktop (diagnostic) | component*, reason*, crash_id, exit_code | packages/log-schema/schema/catalogue.json:4999 |
| `desktop.update.failed` | desktop (diagnostic) | component*, reason*, crash_id, exit_code | packages/log-schema/schema/catalogue.json:5042 |
| `desktop.deeplink.ignored` | desktop (diagnostic) | component, reason*, crash_id, exit_code | packages/log-schema/schema/catalogue.json:5085 |
| `os.service.installed` | os (diagnostic) | manager*, unit, reason, exit_code | packages/log-schema/schema/catalogue.json:5122 |
| `os.service.restarted` | os (diagnostic) | manager*, unit, reason, exit_code | packages/log-schema/schema/catalogue.json:5159 |
| `os.service.failed` | os (diagnostic) | manager*, unit, reason*, exit_code | packages/log-schema/schema/catalogue.json:5196 |
| `os.power.resumed` | os (diagnostic) | manager*, unit, reason, exit_code | packages/log-schema/schema/catalogue.json:5240 |
| `licence.accept-nc` | harness (audit) | useClass*, acceptedAt | packages/log-schema/schema/catalogue.json:5277 |
| `setup.complete` | harness (audit) | target, channel, core, profile | packages/log-schema/schema/catalogue.json:5308 |
| `repair.*` | harness (audit) | status*, reason, detail | packages/log-schema/schema/catalogue.json:5339 |
| `ext.install` | harness (audit) | id*, version*, kind, sha256*, trust, keyId, acknowledged, replaced, via | packages/log-schema/schema/catalogue.json:5372 |
| `ext.enable` | harness (audit) | kind, agents, via | packages/log-schema/schema/catalogue.json:5411 |
| `ext.disable` | harness (audit) | kind, agents, via | packages/log-schema/schema/catalogue.json:5441 |
| `ext.uninstall` | harness (audit) | kind, version, trashId, purged, cascade, moved, secrets, via | packages/log-schema/schema/catalogue.json:5471 |
| `ext.purge` | harness (audit) | kind, version, trashId, purged, cascade, moved, secrets, via | packages/log-schema/schema/catalogue.json:5503 |
| `ext.restore` | harness (audit) | kind, version, trashId, purged, cascade, moved, secrets, via | packages/log-schema/schema/catalogue.json:5535 |
| `config.set` | harness (audit) | key*, restart_class, old, new | packages/log-schema/schema/catalogue.json:5567 |
| `module.install` | harness (audit) | name*, version | packages/log-schema/schema/catalogue.json:5599 |
| `module.uninstall` | harness (audit) | name*, version | packages/log-schema/schema/catalogue.json:5629 |
| `secret.create` | harness (audit) | name* | packages/log-schema/schema/catalogue.json:5659 |
| `secret.rotate` | harness (audit) | name* | packages/log-schema/schema/catalogue.json:5688 |
| `secret.delete` | harness (audit) | name* | packages/log-schema/schema/catalogue.json:5717 |
| `auth.login` | harness (audit) | profile* | packages/log-schema/schema/catalogue.json:5746 |
| `auth.logout` | harness (audit) | profile* | packages/log-schema/schema/catalogue.json:5775 |
| `log.payload_capture.enabled` | harness (audit) | agent*, until*, actor | packages/log-schema/schema/catalogue.json:5804 |
| `log.payload_capture.disabled` | harness (audit) | agent*, until, actor | packages/log-schema/schema/catalogue.json:5836 |
| `logs.otlp.enabled` | harness (audit) | endpoint*, signals | packages/log-schema/schema/catalogue.json:5867 |
| `logs.otlp.disabled` | harness (audit) | endpoint, signals | packages/log-schema/schema/catalogue.json:5899 |
| `logs.retention.changed` | harness (audit) | key*, old_days, new_days* | packages/log-schema/schema/catalogue.json:5929 |
| `approval.requested` | harness (audit) | request_id*, decision, tool*, store_ref | packages/log-schema/schema/catalogue.json:5961 |
| `approval.decided` | harness (audit) | request_id*, decision*, tool, store_ref | packages/log-schema/schema/catalogue.json:5994 |
| `grant.created` | harness (audit) | grant_id*, scope*, until, store_ref | packages/log-schema/schema/catalogue.json:6027 |
| `grant.revoked` | harness (audit) | grant_id*, scope, until, store_ref | packages/log-schema/schema/catalogue.json:6059 |
| `grant.expired` | harness (audit) | grant_id*, scope, until, store_ref | packages/log-schema/schema/catalogue.json:6090 |
| `policy.denied` | harness (audit) | tool*, reason*, store_ref | packages/log-schema/schema/catalogue.json:6121 |
| `approvals.integrity_failed` | harness (audit) | store_ref*, reason | packages/log-schema/schema/catalogue.json:6153 |
| `device.paired` | harness (audit) | device_id* | packages/log-schema/schema/catalogue.json:6183 |
| `device.revoked` | harness (audit) | device_id* | packages/log-schema/schema/catalogue.json:6212 |
| `user.break_glass` | harness (audit) | target*, reason* | packages/log-schema/schema/catalogue.json:6241 |

## Typed events emitted in modules

| Event | Source module | Fields | Source |
|---|---|---|---|
| `mcp.client.error` | core/mcp (log, debug) | server, message | packages/core/src/mcp/connection.ts:111 |
| `mcp.server.env-missing` | core/mcp (log, warn) | server, names | packages/core/src/mcp/connection.ts:120 |
| `mcp.server.spawn` | core/mcp (log, debug) | server, command, argCount, envNames | packages/core/src/mcp/connection.ts:123 |
| `mcp.server.started` † | core/mcp (log, info) | server, scope, transport, pid, protocolVersion | packages/core/src/mcp/connection.ts:159 |
| `mcp.server.list-truncated` | core/mcp (log, warn) | server, pages | packages/core/src/mcp/connection.ts:195 |
| `mcp.tool.excluded` | core/mcp (log, warn) | server, reason | packages/core/src/mcp/connection.ts:209 |
| `mcp.server.stopped` | core/mcp (log, info) | server, mode | packages/core/src/mcp/connection.ts:317 |
| `mcp.server.stderr` | core/mcp (log, debug) | server, line | packages/core/src/mcp/connection.ts:344 |
| `mcp.server.registered` | core/mcp (log, info) | server, scope, transport, trust | packages/core/src/mcp/registry.ts:105 |
| `mcp.observer.failed` | core/mcp (log, warn) | server | packages/core/src/mcp/registry.ts:286 |
| `mcp.server.idle-stop` | core/mcp (log, info) | server, idleMs | packages/core/src/mcp/registry.ts:322 |
| `model.discovered` | core/discovery (log, info) | source, trace_id, provider, count, models, reappeared, truncated | packages/core/src/discovery/events-logger.ts:21 |
| `model.scan.completed` | core/discovery (log, debug) | source, trace_id, provider, result, duration_ms, counts | packages/core/src/discovery/events-logger.ts:90 |
| `model.catalog.reenrich_failed` | core (log, warn) | none | packages/core/src/core.ts:400 |
| `channel.factory.failed` | core/channels (log, error) | channel, error | packages/core/src/channels/registry.ts:117 |
| `channel.started` | core/channels (log, info) | channel | packages/core/src/channels/registry.ts:132 |
| `channel.crashed` | core/channels (log, warn) | channel, error, attempts | packages/core/src/channels/registry.ts:159 |
| `channel.gave-up` | core/channels (log, error) | channel, attempts | packages/core/src/channels/registry.ts:162 |
| `channel.stop.failed` | core/channels (log, warn) | channel, error | packages/core/src/channels/registry.ts:176 |
| `channel.inbound.dropped` | core/channels (log, warn) | channel, reason (registry); reason (router) | packages/core/src/channels/registry.ts:187, :189, :190; packages/core/src/channels/router.ts:34 |
| `channel.inbound.failed` | core/channels (log, error) | channel, error | packages/core/src/channels/router.ts:37 |
| `channel.identity.failed` | core/channels (log, error) | channel, error | packages/core/src/channels/router.ts:60 |
| `channel.session.failed` | core/channels (log, error) | channel, error | packages/core/src/channels/router.ts:76 |
| `channel.pairing.failed` | core/channels (log, error) | channel, error | packages/core/src/channels/router.ts:90 |
| `channel.send.failed` | core/channels (log, warn) | channel, error | packages/core/src/channels/router.ts:109 |
| `channel.telegram.started` | channels-telegram (log, info) | allowed, resumed | packages/channels-telegram/src/channel.ts:182 |
| `channel.telegram.stopped` | channels-telegram (log, info) | none | packages/channels-telegram/src/channel.ts:212 |
| `channel.telegram.auth-failed` | channels-telegram (log, error) | none | packages/channels-telegram/src/channel.ts:194, :410 |
| `channel.telegram.offset-save-failed` | channels-telegram (log, error) | none | packages/channels-telegram/src/channel.ts:389 |
| `channel.telegram.poll-failed` | channels-telegram (log, warn) | kind, waitMs | packages/channels-telegram/src/channel.ts:419 |
| `channel.telegram.request-retry` | channels-telegram (log, warn) | kind, waitMs, attempt | packages/channels-telegram/src/channel.ts:475 |
| `channel.telegram.rejected` | channels-telegram (log, warn) | chatId | packages/channels-telegram/src/channel.ts:504 |
| `channel.telegram.migrated` | channels-telegram (log, info) | chatId, newChatId | packages/channels-telegram/src/channel.ts:514 |
| `channel.telegram.media-rejected` | channels-telegram (log, warn) | chatId | packages/channels-telegram/src/channel.ts:532 |
| `channel.telegram.command-send-failed` | channels-telegram (log, warn) | none | packages/channels-telegram/src/channel.ts:564, :575 |
| `channel.telegram.handler-failed` | channels-telegram (log, error) | none | packages/channels-telegram/src/channel.ts:586 |
| `channel.telegram.framework-rich-turn-gap` | channels-telegram (log, warn) | none | packages/channels-telegram/src/channel.ts:592 |
| `channel.telegram.host-failed` | channels-telegram (log, error) | none | packages/channels-telegram/src/channel.ts:598 |
| `channel.telegram.callback-rejected` | channels-telegram (log, warn) | none | packages/channels-telegram/src/channel.ts:623 |
| `channel.telegram.callback-answer-failed` | channels-telegram (log, warn) | none | packages/channels-telegram/src/channel.ts:628 |
| `auth.refresh.start` | core/auth (log) | profileId, credentialId | packages/core/src/auth/refresh.ts:93 |
| `auth.refresh.rejected` | core/auth (log) | profileId, credentialId | packages/core/src/auth/refresh.ts:100 |
| `auth.refresh.transient` | core/auth (log) | profileId, credentialId, usable | packages/core/src/auth/refresh.ts:109 |
| `auth.refresh.ok` | core/auth (log) | profileId, credentialId, generation | packages/core/src/auth/refresh.ts:123 |
| `auth.persist.failed` | core/auth (log) | profileId, credentialId | packages/core/src/auth/refresh.ts:141 |
| `auth.login.ok` | core/auth (log) | profileId, method | packages/core/src/auth/login.ts:185 |
| `auth.login.failed` | core/auth (log) | profileId, code | packages/core/src/auth/login.ts:189 |
| `auth.pool.cooldown` | core/auth (log) | profileId, credentialId, code, certainty, scope, ms, sole | packages/core/src/auth/pool.ts:116 |
| `auth.lease.rejected` | core/auth (log) | profileId, credentialId, action | packages/core/src/auth/credentials.ts:123 |
| `log.level.changed` † | core/logs (log) | source_key, from (optional), to | packages/core/src/logs/writer.ts:133 |
| `log.level.expired` † | core/logs (log) | source_key, from, to | packages/core/src/logs/writer.ts:25 |
| `log.unregistered` † | core/logs (log) | attempted | packages/core/src/logs/writer.ts:67 |
| `log.redaction.failed` † | core/logs (log) | attempted_event | packages/core/src/logs/writer.ts:74, :124 |
| `log.suppressed` † | core/logs (log) | dropped, window_ms, reason | packages/core/src/logs/writer.ts:103 |
| `log.retention.pruned` † | core/logs (log) | stream, files, older_than_days (plus sink.prune result fields) | packages/core/src/logs/writer.ts:108 |
| `daemon.start` | crates/plur1bus supervisor (rust log, info) | child | crates/plur1bus/src/supervisor/server.rs:341 |
| `auth.rate-limited` | api (audit) | class, route, ip | packages/api/src/server.ts:200; packages/api/src/routes.ts:346 |
| `auth.token.used-denied` | api (audit) | reason, ip | packages/api/src/server.ts:262, :266 |
| `auth.denied` | api (audit) | reason, method, ip, action; also via, token at :274 | packages/api/src/server.ts:274, :303 |
| `auth.csrf-refused` | api (audit) | route, ip | packages/api/src/server.ts:289 |
| `auth.session.rotated` | api (audit) | route | packages/api/src/server.ts:298 |
| `auth.login.failure` | api (audit) | via, reason, ip | packages/api/src/routes.ts:312, :320 |
| `auth.login.success` | api (audit) | via, ip | packages/api/src/routes.ts:335, :360 |
| `auth.totp.failure` | api (audit) | stage, ip | packages/api/src/routes.ts:352, :382, :390 |
| `auth.totp.backup-used` | api (audit) | remaining, ip | packages/api/src/routes.ts:361 |
| `auth.totp.enabled` | api (audit) | ip | packages/api/src/routes.ts:383 |
| `auth.totp.disabled` | api (audit) | ip | packages/api/src/routes.ts:391 |
| `auth.logout` † | api (audit) | ip | packages/api/src/routes.ts:429 |
| `auth.logout-all` | api (audit) | revoked, ip | packages/api/src/routes.ts:436 |
| `auth.token.created` | api (audit) | name, scopes, expiresAt, ip | packages/api/src/routes.ts:475 |
| `auth.token.revoked` | api (audit) | ip | packages/api/src/routes.ts:483 |
| `policy.decision` | core/tools (audit) | PolicyAuditFields (person, agentId, tool, capability, outcome, via, rule, among others; list not fully checked) | packages/core/src/tools/dispatcher.ts:126, :141, :144 |
| `policy.outcome` | core/tools (audit) | PolicyAuditFields | packages/core/src/tools/dispatcher.ts:260 |
| `exec.refused` | core/tools/exec (audit) | code, argc, plus extra (content unclear) | packages/core/src/tools/exec/run.ts:62, :66 |
| `exec.run` | core/tools/exec (audit) | decision, via, base (content unclear) | packages/core/src/tools/exec/run.ts:115 |
| `exec.result` | core/tools/exec (audit) | actionHash, outcome, exitCode, signal, truncated, durationMs | packages/core/src/tools/exec/run.ts:124, :143, :147 |
| `rbac.unauthenticated` | core/rbac (audit) | action, reason | packages/core/src/rbac/guard.ts:100, :104 |
| `rbac.denied` | core/rbac (audit) | action, reason, role | packages/core/src/rbac/guard.ts:109 |
| `break-glass.granted` | core/rbac (audit); api notice | audit: grantId, reason, issuedAt, expiresAt, ttlMs; notice: grantId, holderUserId, reason, at, expiresAt | packages/core/src/rbac/break-glass.ts:103; packages/api/src/notices.ts:18 |
| `break-glass.expired` | core/rbac (audit) | grantId, holderUserId, expiresAt | packages/core/src/rbac/break-glass.ts:67 |
| `break-glass.notify-failed` | core/rbac (audit) | grantId, error | packages/core/src/rbac/break-glass.ts:108 |
| `break-glass.revoked` | core/rbac (audit) | grantId, holderUserId | packages/core/src/rbac/break-glass.ts:117 |
| `break-glass.used` | core/rbac (audit) | grantId, action | packages/core/src/rbac/break-glass.ts:130 |
| `a2a.rate-limited` | core/a2a (audit) | scope | packages/core/src/a2a/handler.ts:149, :151, :162 |
| `a2a.unauthenticated` | core/a2a (audit) | reason | packages/core/src/a2a/handler.ts:157 |
| `a2a.denied` | core/a2a (audit) | action, reason | packages/core/src/a2a/handler.ts:168, :178 |
| `a2a.too-large` | core/a2a (audit) | bytes (:185) or limit (:191) | packages/core/src/a2a/handler.ts:185, :191 |
| `secret.set` | core/secrets (audit) | backend | packages/core/src/secrets/store.ts:100 |
| `secret.get` | core/secrets (audit) | none | packages/core/src/secrets/store.ts:110 |
| `secret.reveal` | core/secrets (audit) | none | packages/core/src/secrets/store.ts:121 |
| `secret.delete` | core/secrets (audit) | none | packages/core/src/secrets/store.ts:133 |
| `secret.list` | core/secrets (audit) | backend | packages/core/src/secrets/store.ts:146 |
| `secret.lease` | core/secrets (audit) | purpose, profileId, ttlMs | packages/core/src/secrets/store.ts:157 |
| `secret.lease.read` | core/secrets (audit) | leaseId | packages/core/src/secrets/store.ts:165 |
| `secret.lease.revoke` | core/secrets (audit) | leaseId | packages/core/src/secrets/store.ts:170 |
| `secret.denied` | core/secrets (audit) | method | packages/core/src/secrets/store.ts:44 |
| `identity.human.create` | core/identity (audit) | displayName | packages/core/src/identity/service.ts:140 |
| `link.requested` | core/identity (audit) | channel, accountId, userId | packages/core/src/identity/service.ts:148 |
| `identity.link` | core/identity (audit) | humanId, channel, accountId, userId, proof | packages/core/src/identity/service.ts:154 |
| `identity.pair.start` | core/identity (audit) | humanId, channel, expiresAt | packages/core/src/identity/service.ts:181 |
| `identity.pair.rate-limited` | core/identity (audit) | retryAfterMs, reason (:169); retryAfterMs plus handle (:220) | packages/core/src/identity/service.ts:169, :220 |
| `identity.pair.claim` | core/identity (audit) | result, reason (:224); result, humanId plus handle (:228) | packages/core/src/identity/service.ts:224, :228 |
| `identity.pair.confirm` | core/identity (audit) | result, linkId, humanId, channel, accountId, userId | packages/core/src/identity/service.ts:251 |
| `identity.unlink` | core/identity (audit) | humanId, channel, accountId, userId | packages/core/src/identity/service.ts:269 |
| `identity.backfill` | core/identity (audit) | from, to, count, dryRun, at, receipt | packages/core/src/identity/backfill.ts:53 |
| `identity.backfill.reversed` | core/identity (audit) | count, dryRun, from, to | packages/core/src/identity/backfill.ts:68 |
| `approval.requested` † | core/approvals (audit) | auditFieldsOf(ask) plus fields not checked | packages/core/src/approvals/service.ts:244 |
| `approval.refused` | core/approvals (audit) | person, requestId, decision, scope (:351); auditFieldsOf plus reason, requestId (:233, :429) | packages/core/src/approvals/service.ts:233, :351, :429 |
| `approval.parked` | core/approvals (audit) | requestId, person, tool, capability, actionHash | packages/core/src/approvals/service.ts:289 |
| `approval.cancelled` | core/approvals (audit) | requestId, by (:297); person, requestId, by, capability, actionHash (:454) | packages/core/src/approvals/service.ts:297, :454 |
| `approval.expired` | core/approvals (audit) | requestId, person, capability, actionHash | packages/core/src/approvals/service.ts:314 |
| `approval.decided` † | core/approvals (audit) | fields unclear, check | packages/core/src/approvals/service.ts:376 |
| `approval.consumed` | core/approvals (audit) | auditFieldsOf plus requestId, grantId, scope | packages/core/src/approvals/service.ts:424 |
| `approvals.integrity-failure` | core/approvals (audit) | brokenAt, failure | packages/core/src/approvals/service.ts:174, :467 |
| `approvals.held-rejected` | core/approvals (audit) | person, agentId, taskId, sessionId (optional), rejected (rest unclear) | packages/core/src/approvals/service.ts:507 |
| `grant.created` † | core/grants (audit) | person, agentId, capability, grantId, grantScope, matchKind, targets (path), by, reason, actionHash (per call) | packages/core/src/grants/store.ts:226 (body at :183) |
| `grant.used` | core/grants (audit) | as grant.created | packages/core/src/grants/store.ts:297 |
| `grant.consumed` | core/grants (audit) | as grant.created, plus actionHash | packages/core/src/grants/store.ts:327 |
| `grant.revoked` † | core/grants (audit) | as grant.created, plus by, reason | packages/core/src/grants/store.ts:258, :265 |
| `grant.ended` | core/grants (audit) | as grant.revoked | packages/core/src/grants/store.ts:258, :265 |
| `licence.accept-nc` † | crates/plur1bus install (rust audit) | useClass, acceptedAt | crates/plur1bus/src/install/setup.rs:939 |
| `setup.complete` † | crates/plur1bus install (rust audit) | target, channel, core, profile | crates/plur1bus/src/install/setup.rs:316 |
| `backup.create` | crates/plur1bus commands (rust audit) | files, bytes, units | crates/plur1bus/src/commands/backup.rs:114 |
| `backup.restore` | crates/plur1bus commands (rust audit) | units, preRestore | crates/plur1bus/src/commands/backup.rs:186 |
| `ext.enable` † | crates/plur1bus ext/lifecycle (rust audit) | kind, agents, via | crates/plur1bus/src/ext/lifecycle.rs:638, :645 |
| `ext.disable` † | crates/plur1bus ext/lifecycle (rust audit) | kind, agents, via | crates/plur1bus/src/ext/lifecycle.rs:638, :645 |
| `ext.install` † | crates/plur1bus ext/commit (rust audit) | detail content unclear | crates/plur1bus/src/ext/commit.rs:740 |
| `ext.uninstall` † | crates/plur1bus ext/remove (rust audit) | detail content unclear | crates/plur1bus/src/ext/remove.rs:232, :336–340, :585 |
| `ext.purge` † | crates/plur1bus ext/remove (rust audit) | detail content unclear | crates/plur1bus/src/ext/remove.rs:232, :336–340 |
| `ext.restore` † | crates/plur1bus ext/remove (rust audit) | detail content unclear | crates/plur1bus/src/ext/remove.rs:733 |
| `update.apply` | crates/plur1bus update (rust audit) | from, to, id | crates/plur1bus/src/update/mod.rs:319 |
| `update.rollback` | crates/plur1bus update (rust audit) | from, to, id | crates/plur1bus/src/update/mod.rs:439 |
| `repair.<step>` † | crates/plur1bus repair (rust audit) | status, reason, detail | crates/plur1bus/src/repair/mod.rs:248–250 |
| `approval.requested` † | core/approvals (bus) | approval, nonce, foregroundUntil | packages/core/src/approvals/service.ts:275 |
| `approval.parked` | core/approvals (bus) | approval | packages/core/src/approvals/service.ts:290 |
| `approval.resolved` | core/approvals (bus) | approval, outcome, scope, grantIds | packages/core/src/approvals/service.ts:302, :315, :396, :461 |
| `grant.changed` | core/approvals (bus) | change, grantId, person, agent, capability, scope | packages/core/src/approvals/service.ts:399 |
| `guardrail.refused` | core/collab (bus) | projectId, traceId, agentId, data.reason | packages/core/src/collab/service.ts:141 |
| `project.created` | core/collab (bus) | projectId, data.name, data.owner | packages/core/src/collab/service.ts:253 |
| `project.archived` | core/collab (bus) | projectId, data (empty) | packages/core/src/collab/service.ts:270 |
| `project.member.added` | core/collab (bus) | projectId, data.userId, data.role | packages/core/src/collab/service.ts:277 |
| `project.member.removed` | core/collab (bus) | projectId, data.userId | packages/core/src/collab/service.ts:284 |
| `project.agent.added` | core/collab (bus) | projectId, data.agentId | packages/core/src/collab/service.ts:291 |
| `project.agent.removed` | core/collab (bus) | projectId, data.agentId | packages/core/src/collab/service.ts:298 |
| `consult.started` | core/collab (bus) | projectId, traceId, agentId, data.fromAgent, data.spanId | packages/core/src/collab/service.ts:324 |
| `consult.finished` | core/collab (bus) | projectId, traceId, agentId, data.spanId, data.status | packages/core/src/collab/service.ts:336, :351 |
| `delegate.queued` | core/collab (bus) | projectId, traceId, agentId, data.taskId, data.spanId | packages/core/src/collab/service.ts:392 |
| `delegate.started` | core/collab (bus) | projectId, traceId, agentId, data.taskId, data.spanId | packages/core/src/collab/service.ts:399 |
| `delegate.finished` | core/collab (bus) | projectId, traceId, agentId, data.taskId, data.status, data.truncated | packages/core/src/collab/service.ts:415 |
| `trigger.importance` | core/dreams (bus) | agentId, phase | packages/core/src/dreams/scheduler.ts:226 |
| `breaker.closed` | core/dreams (bus) | agentId, phase | packages/core/src/dreams/scheduler.ts:268 |
| `breaker.opened` | core/dreams (bus) | agentId, reason | packages/core/src/dreams/scheduler.ts:279 |
| `run.started` | core/dreams (bus) | agentId, phase, runId, trigger | packages/core/src/dreams/scheduler.ts:333 |
| `run.finished` | core/dreams (bus) | agentId, phase, runId, outcome, reason | packages/core/src/dreams/scheduler.ts:351 |
| `provider.skipped` | providers/router (bus) | profile, target, reason, detail (only :118) | packages/providers/src/router/router.ts:97, :118 |
| `provider.fallback` | providers/router (bus) | profile, from, to, reason | packages/providers/src/router/router.ts:124 |
| `provider.retry` | providers/router (bus) | profile, target, attempt, delayMs, reason | packages/providers/src/router/router.ts:163 |
| `provider.breaker` | providers/router (bus) | target, from, to | packages/providers/src/router/router.ts:202 |
| `budget.soft` | core/budget (bus) | kind, scope, agentId (scope=agent only), period, metric, limit, used, periodKey | packages/core/src/budget/service.ts:190, :222 (factory :153–154) |
| `budget.hard` | core/budget (bus) | kind, scope, agentId (scope=agent only), period, metric, limit, used, periodKey | packages/core/src/budget/service.ts:221 (factory :153–154) |
| `warn` | core/budget/calls (bus, no namespace) | scope, id, used, limit, metric | packages/core/src/budget/calls.ts:140 |
| `refuse` | core/budget/calls (bus, no namespace) | refusal | packages/core/src/budget/calls.ts:168 |
| `reserve` | core/budget/calls (bus, no namespace) | reservationId, tokens, costMicros | packages/core/src/budget/calls.ts:171 |
| `settle` | core/budget/calls (bus, no namespace) | reservationId, tokens, costMicros, overages | packages/core/src/budget/calls.ts:191 |
| `prompt.unknown-model` | core/prompt (bus) | agentId, model | packages/core/src/prompt/builder.ts:91 |
| `prompt.zone-clipped` | core/prompt (bus) | agentId, model, zone, from, to, cap, reason | packages/core/src/prompt/builder.ts:112 |
| `prompt.below-minimum` | core/prompt (bus) | agentId, model, tokensEstimate, minTokens | packages/core/src/prompt/builder.ts:138 |
| `prompt.lookback-risk` | core/prompt (bus) | agentId, model, positions, lookback | packages/core/src/prompt/builder.ts:174 |
| `prompt.prefix-invalidated` | core/prompt (bus) | agentId, model, from, reason (:196); agentId, model, previousModel, reason (:204) | packages/core/src/prompt/builder.ts:196, :204 |
| `prompt.block-clipped` | core/prompt (type only) | agentId, model, block, from, to, reason | packages/core/src/prompt/types.ts:86 (no emit in src; tests only) |
| `prompt.block-dropped` | core/prompt (type only) | agentId, model, block, from, to, reason | packages/core/src/prompt/types.ts:87 (no emit in src; tests only) |
| `turn.started` | core/session (store event) | turnId, turnSeq, messageId | packages/core/src/session/store.ts:240 |
| `turn.completed` | core/session (store event) | turnId, messageId, plus data | packages/core/src/session/store.ts:253 |
| `turn.failed` | core/session (store event) | turnId, error, plus data (recovered on restart) | packages/core/src/session/store.ts:266, :274 |
| `delta` | core/session (turn loop) | index, text | packages/core/src/session/turn-loop.ts:97 |
| `tool.call` | core/session (turn loop) | id, name, args (optional) | packages/core/src/session/turn-loop.ts:99 |
| `tool.result` | core/session (turn loop) | id, output, isError (:105); id, output (:109) | packages/core/src/session/turn-loop.ts:105, :109 |
| `core.state` | core (notify) | process | packages/core/src/core.ts:203 |
| `engine.event` | core (notify) | name, agentId (optional), payload | packages/core/src/core.ts:356 |
| `agent.activity` | core (notify) | agentId, activity | packages/core/src/core.ts:375 |
| `models.changed` | core (notify) | unklar – prüfen (discovery event) | packages/core/src/core.ts:434 |
| `session.event` | core/session (notify) | agentId, event | packages/core/src/session/service.ts:44 |
| `approval.requested` / `approval.resolved` / `grant.changed` (RPC mapping) | core/approvals (notify) | approval (record), change, grant | packages/core/src/approvals/notify.ts:72–89 |
| `config.changed` | crates/plur1bus supervisor (broadcast) | unklar – prüfen (params) | crates/plur1bus/src/supervisor/config.rs:263 |
| `module.state` | crates/plur1bus supervisor (broadcast) | unklar – prüfen (module state) | crates/plur1bus/src/supervisor/mod.rs:282 |
| `ext.changed` | crates/plur1bus supervisor (broadcast) | unklar – prüfen (change) | crates/plur1bus/src/supervisor/ext.rs:173 |

## Zählung

- Katalog (`packages/log-schema/schema/catalogue.json`, `events[]`, Zeilen 1433–6241): 128 Einträge. Davon 95 diagnostic, 1 payload (`provider.payload.captured`) und 32 audit, einschließlich der `repair.*`-Familie.
- Typed Events aus Modulen: 186 Zeilen, 184 verschiedene Namen. `approval.requested` (audit und bus) und `approval.parked` (audit und bus) erscheinen jeweils zweimal. Aufschlüsselung: logger 56, audit TypeScript 64 (api 15, core 49), Rust audit 13, bus, notify und broadcast 53.
- Zeilen mit † (Name auch im Katalog): 22.
- Ausgeschlossen: RPC-Methodennamen (z. B. `daemon.start` in `commands/daemon.rs`, `config.get`), Dateinamen, Upstream-SSE-Typen der Provider (`packages/providers/src/responses/response.ts:273–294`), ACP- und Session-Relays (`acp/backend.ts:72–73`, `session/provider.ts:52–53`, ein Fake-Provider in `src`), Rust-Logmeldungen ohne punktierten Namen und A2A-Task-Protokoll-Updates (`a2a/tasks.ts`).

## Namensabweichungen und offene Punkte

1. Katalog und Emitter weichen ab: `auth.login` (Katalog) vs. `auth.login.success`/`auth.login.failure` (emittiert); `secret.create`/`rotate`/`delete` vs. `secret.set`/`get`; `approvals.integrity_failed` (Katalog) vs. `approvals.integrity-failure` (emittiert). Viele emittierte Namen (`exec.*`, `rbac.*`, `a2a.*`, `identity.*`, `channel.telegram.*`) stehen nicht im Katalog.
2. Felder unklar: `approval.decided` (approvals/service.ts:376), Basisfelder von `exec.run`, vollständige `PolicyAuditFields`, Rest von `approvals.held-rejected`, `models.changed`, Rust-Payloads von `config.changed`/`module.state`/`ext.changed`, Rust `ext.install/uninstall/purge/restore` im Detail.
3. Dynamische Eventnamen sind nicht aufgelistet: Rust `.warn(&what)` in supervisor/adopt.rs:547 und `&hung` in supervisor/child.rs:1297,1305; core.ts:283 und :410; channels-telegram `#log(level, event)`.
4. Typisiert, aber nicht emittiert: `prompt.block-clipped` und `prompt.block-dropped` (nur Tests). Katalogeinträge ohne Emitter: `grant.expired`, `policy.denied`, `device.paired`, `config.set`, `log.payload_capture.*`.
5. Die Events in `budget/calls.ts` (`warn`, `refuse`, `reserve`, `settle`) haben keinen punktierten Namensraum; zu entscheiden, ob sie so bleiben.
