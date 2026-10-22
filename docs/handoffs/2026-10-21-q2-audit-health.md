# GP5 Q2: Audit-Gesundheit im Status

Basis: Q1 `089f93f3a7` / Draft #677 auf Controller-PR #664. Q2 erweitert die beiden
vorhandenen Statusmethoden; es gibt keine neue RPC-Methode. Engine-Pin und Lockfile bleiben
unverändert. #662 bleibt eine externe Voraussetzung für die separate Detail-Redaktion.

## Verhalten und Zugriff

`core.status.audit` und `daemon.status.audit` verwenden dieselbe optionale, geschlossene
`AuditHealth`-Definition. Der Abschnitt enthält:

- beobachteten Tail-/Anker-Zustand `ok` oder `refusing` mit Code, letzte Sequenz und Beobachtungszeit;
- Zeitpunkt der letzten erfolgreichen **expliziten** `audit.verify`-Prüfung, anfangs `null`;
- Zahl der Pending-Zeilen, verworfene Zeilen und Pending-Metadaten;
- letzte beobachtete Anker-Heilung und letzten Reanchor mit Zeit und Akteur.

Die Metadaten enthalten keinen `detail`- oder `target`-Inhalt. Akteure werden auf `user` und `host`
mit höchstens 128 Zeichen begrenzt; unbekannte Pending-Aktionen erscheinen als `unknown`,
Refusal-Codes werden auf die bekannten Writer-Codes beschränkt.

Core gibt den Abschnitt nur an menschliche Owner/Admin mit `audit.read` frei. Andere Rollen,
Agenten und Tokens ohne diesen Scope behalten die bisherige öffentliche Statusantwort ohne
`audit`. Die Prüfung schränkt bestehende Statusrechte nicht ein. Beim Supervisor gilt der lokale
Supervisor-Token wie bisher als Zugriff des OS-Owners. Delegierte menschliche Owner/Admin können
nun zusätzlich `daemon.status` lesen; `audit` verlangt auch dort `audit.read`. Die bestehende
Verweigerung anderer delegierter Supervisor-Operationen bleibt bestehen.

## Kosten und Verifikationszeit

Beide Prozesse halten einen Cache mit 30 Sekunden TTL; ein Rücksprung der Uhr erneuert ihn.
Ein erneuter Statusaufruf innerhalb der TTL liest die Audit-Dateien nicht erneut. Beim Erneuern
werden Metadaten gelesen und höchstens die beiden neuesten vollständigen Zeilen gehasht.
Es läuft keine historische Verifikation für jeden Statusaufruf.

`state: ok` beschreibt den beobachteten Tail-/Anker-Zustand, nicht die historische Integrität
aller Zeilen. Ältere Manipulationen findet weiterhin die explizite Verifikation. Der Reader nimmt
keine Writer-Sperre, heilt keinen Anker und erzeugt oder kürzt keine Torn-Datei. Insbesondere
ruft Rust niemals den mutierenden `audit::chain::tail` aus dem Statuspfad auf. Ein abgerissener
Rest bleibt bytegenau erhalten. Wie jeder Cache kann die Beobachtung bis zu 30 Sekunden alt sein;
sie ist eine Momentaufnahme, keine Zusage über einen späteren Append oder eine zukünftige Sperre.

Eine erfolgreiche explizite Verifikation schreibt ausschließlich ihren Zeitpunkt atomar in
`logs/audit-chain.verified.json` (`v: 1`, `at` in Epoch-Millisekunden). Die temporäre Datei wird
privat erstellt und vor dem Rename mit dem Plattform-ACL gesichert. Die Chain-Beweisdateien
bleiben unverändert. Ein Fehler dieser Metadaten-Persistenz führt zu `E_STORAGE`. Eine fehlgeschlagene
Verifikation überschreibt den letzten Erfolgszeitpunkt nicht. Core invalidiert nach Erfolg seinen
Cache; der Supervisor liest den gemeinsamen Marker beim nächsten Cache-Refresh. Nach einem
Prozessneustart bleibt der letzte bekannte Erfolgszeitpunkt so verfügbar. Ein fehlender oder
ungültiger Marker ergibt `null`, nicht eine erfundene Verifikation.

## Lokale Evidenz

Die Tests decken tatsächliche TS-/Rust-Chain-Writer, unabhängige Metadatenleser und einen direkten
TS-/Rust-Vergleich über denselben Dateien ab: intakt, heilbarer Ein-Zeilen-Rückstand, ungültiger
Anker, Pending-Journal mit Drop-Header, erfolgreicher Verifikationsmarker sowie Torn-/Leerzeilen.
Rollen, eingeschränkte Token-Scopes, Cache-TTL, Core-RPC und Supervisor-RPC werden separat geprüft.
Die Schema-Inventare und Rust-RPC-Typentabellen bleiben vollständig; beide Statustypen lesen das
neue Feld, öffentliche Antworten ohne das Feld bleiben gültig.

Core-Integration verwendet die echte gepinnte Engine mit dem bestehenden Flat-Embedder-Testseam.
Die Supervisor-Prozesssuite verwendet ihren vorhandenen Fake-Core-Prozess; kein Engine-Fake oder
Resolver-Ersatz wurde ergänzt. Metadata-Fixtures enthalten synthetische Ereignisse. Der vorhandene
TODO in `audit/chain-hardening.test.ts` zur Detail-Redaktion ist unverändert und gehört zu #662.
Die vorhandenen ignorierten Rust-Fälle bleiben ebenfalls unverändert.

Prüfbefehle (Node 24.21, Cargo separat unter `target/gp5-q2`):

```bash
pnpm gen
pnpm --filter @plur1bus/rpc-schema test
pnpm --filter @plur1bus/core test
CARGO_TARGET_DIR=target/gp5-q2 cargo test -p plur1bus --bin plur1bus
CARGO_TARGET_DIR=target/gp5-q2 cargo test -p plur1bus --test supervisor_children
CARGO_TARGET_DIR=target/gp5-q2 cargo test -p plur1bus-rpc --test roundtrip --test fixtures --test capabilities
CARGO_TARGET_DIR=target/gp5-q2 cargo clippy -p plur1bus --bin plur1bus --test supervisor_children -p plur1bus-rpc --test roundtrip -- -D warnings
cargo fmt --all -- --check
pnpm lint
CARGO_TARGET_DIR=target/gp5-q2 PLUR1BUS_BIN="$PWD/target/gp5-q2/debug/plur1bus" pnpm docs:gen
CARGO_TARGET_DIR=target/gp5-q2 PLUR1BUS_BIN="$PWD/target/gp5-q2/debug/plur1bus" pnpm docs:check
```

Keine CI-Abfrage, kein Merge und kein Deployment. Die vollständige Workspace-TS-Suite aus T1
endete ohne Gesamtabschluss und gilt als unvollständig; sie ist keine grüne Q2-Evidenz.

## Ergebnisse und bestehende Baseline-Fehler

- Vollständige Core-Suite: 9.906 Tests, 9.854 bestanden, **neun fehlgeschlagen**, 20 vorhandene
  Skips und 23 vorhandene TODOs. Der Lauf ist ausdrücklich nicht grün.
- Alle neun Fehler reproduzieren unverändert im T1-Baseline-Worktree ohne Q2:
  `node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning --test --test-concurrency=1 packages/core/test/import/fs-atomic.test.ts`
  ergibt 24 bestanden / drei Fehler; derselbe Befehl für `rollback-ledger.test.ts` ergibt
  47 bestanden / sechs Fehler. Die Import-Implementierungen und diese Tests sind durch Q2 unverändert.
- `fs-atomic.test.ts`: Zeilen 167 (Root/Nachfahren, auch nicht existente Pfade), 194 (`..` vor
  dem Vergleich auflösen), 223 (dangling Symlink).
- `rollback-ledger.test.ts`: Zeilen 60 (unchanged/revert/restore), 68 (Snapshot/Report/Manifest),
  99 (gelöschte Datei wiederherstellen), 211 (Report mit anderem Run), 234 (ungültiger Manifest-Inhalt),
  465 (Fehler beim Wiederherstellen einer gelöschten Datei).
- Audit/RBAC/Schema-Fokus: 87 Tests, 86 bestanden, null Fehler, ein vorhandener Redaktions-TODO.
  Nach den letzten Reader-Präzisierungen: Health/Core-RPC/Schema 17/17, Rust-Parität 4/4.
- RPC-Schema-Paket 58/58; Rust-Capabilities/Fixtures/Roundtrip 12/12.
- Rust-CLI-Unit 611 bestanden, null Fehler, ein vorhandener Backup-Secret-Ignore.
- Supervisor-Prozesssuite 20 bestanden, null Fehler, ein vorhandener Prozessgruppen-Ignore (#689).
- `pnpm lint` einschließlich Typecheck: grün, 108 Skripttests bestanden.
- `pnpm gen`, `pnpm docs:gen`, `pnpm docs:check`, Clippy und Formatierung: grün.

Für die lokale Nachprüfung liegen die Ausgaben unter `/tmp/gp5-q2-*.log`. Die vollständige
Core-Suite wurde durchgelaufen, die beiden Baseline-Dateien separat im unberührten T1-Worktree
nachgestellt. Weder die Fehler noch die vorhandenen TODOs/Skips wurden gelöscht oder gelockert.
