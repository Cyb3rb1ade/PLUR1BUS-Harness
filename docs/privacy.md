# Model privacy

Settings > Privacy offers the basic “Only local models” switch. Interactive CLI setup asks the same question;
unattended setup preserves the configured choice. Only Owner/Admin may change these audited settings.

The switch covers model requests: chat, role models, compaction, voice, media, embedding, reranking and engine LLM
features. Web search and fetching remain governed by their own egress policy. A refusal never silently selects a
cloud provider or substitutes another embedding model / vector space.

Loopback is local. A home-network server must be listed explicitly in `privacy.localEndpoints`, by exact origin
including a nondefault port. LAN addresses, DNS names, tunnels and private address ranges are not trusted implicitly.
This allowlist grants no secret, egress, TLS, license or service authority.

An agent can override the installation setting for its own model calls. When **any** agent explicitly requires local
models, the shared engine must stay local for everyone. Settings shows the pinning agent IDs; a conflicting engine
write reports `local-only-shared-engine` and those IDs. Rust `1staid check` appends `privacy.local-only`: off/consistent
is `ok`, inconsistent cloud configuration is `fail`, and consistent explicit overrides are `info` with the agent list.

Changes apply before the next model request. An in-flight cloud response may finish; the next tool round is checked
again. Doctor reflects accepted live policy without rerunning every provisioning probe.

Engine model changes still follow the existing migration/restart path. Migrate and restart a remote engine before
enabling the switch; the running endpoint inventory is checked alongside the proposed config. The automatic
engine-only restart and actual reembed usage are pending the public Engine ports: see [egress](egress.md#live-local-only-policy-ii).

## Lern-Pass: Prüfspeicher und Löschfristen

`state/dreams/learn.db` enthält abgeleitete Befunde, Evidenzreferenzen, Laufmetadaten und
inhaltsfreie Entscheidungsquittungen. Belegauszüge werden ausschließlich live aus dem
Session-Store mit aktuellen Leserechten geladen. Der Lern-Pass ist standardmäßig aus.

Erasure einer Session bereinigt den Prüfspeicher direkt nach dem Tombstone-Commit.
Agent schließen/archivieren/löschen, Projekt archivieren, Identität entfernen und
Person deaktivieren lösen ebenfalls einen Abgleich aus. Der Core wiederholt ihn beim
Start und vor Lernläufen und Review-Zugriffen. Ein Restore durchläuft denselben Abgleich.
Ein Befund mit gelöschten Belegen wird vorsorglich vollständig zurückgezogen, sein
Text und Verify-Snippets werden gelöscht, verbleibende Referenzen werden geprüft. Er
zählt nicht mehr in die Präzision. Eine neue Extraktion kann eine neue Revision anlegen;
eine alte Zustimmung gilt dafür nicht. Bereits laufende Extraktionen dürfen nach der
Löschung keine Checkpoints oder Befunde zurückschreiben.

Extraktions-Checkpoints verschwinden bei Veröffentlichung oder endgültiger Verweigerung.
Wiederaufnehmbare Unterbrechungen, Budgetstopps und Providerfehler behalten sie höchstens
`dreams.learn.checkpointDays` (Default 7, einstellbar von 1 bis 7 Tagen).
30 Tage nach einer Entscheidung werden Befundtext und Verify-Snippets entfernt.
Schlüssel, Hash, Prüfer, Ergebnis, Zeit und Operationsquittung bleiben erhalten.
Der Abgleich läuft im bestehenden Scheduler, ohne zusätzlichen Timer. SQLite nutzt
`secure_delete`; nach einer Bereinigung wird das WAL geleert.

Ruling: `learn.db` gehört zum privaten Backup, damit Review und Kalibrierung einen
Restore überstehen. Die vorhandene SQLite-Allowlist erfasst es als eigenes konsistentes
Datenbank-Abbild. Ein `1staid bundle` enthält diese Datenbank niemals.
