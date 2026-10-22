# F1 — Entscheidungsdienst: ADR und Config-Vertrag

Datum: 20.10.2026. Basis: `origin/main` `31f8dd62cb1bf022ae99cae58a9538e38df5c918`.
Branch: `codex/gp4-f1-decision-contract`. Auftrag Großpaket 4, Phase F1.

## Ergebnis

[ADR-015](../adr/ADR-015-decision-service.md) beschreibt `noul`, `choice`, `score`, die Modulgrenze
nach D70 mit einem Core-Client und dem Übergangsbackend `role`, gemeinsame Deadlines, Fallbacks,
Kalibrierung, datensparsame Turn-Ereignisse, D73-Egress und lokale Privacy-Durchsetzung.
Verbrauchertabelle: D30, D33, D69, D105, D116 und Kompaktierung mit Baseline-Status und Fallback.

Der bisher reservierte `decision`-Namespace ist geschlossen: `backend`, `timeoutMs`, `budgets`,
`confidence`, `classProfiles`; jedes Feld `live`/`advanced`. Standard `role`, alte Configs ohne
Namespace und bestehende Timeout-/Klassenprofile bleiben gültig. Neue Backend-Auswahl installiert
keine Laufzeit. Keine RPC- oder Engine-Vertragsänderung in F1; Engine-Pin und Lockfile unverändert.

## Prüfung

- Node 24.21.0, pnpm 10.28.0, Rust 1.95.0; `check-toolchain`: grün.
- Baseline `pnpm --filter @plur1bus/config-schema test`: 53/53.
- TDD: neue Verhaltensprüfungen gegen offenen Namespace rot (Defaults, unbekannte Auswahl,
  unbekannte Felder, Budgets und Konfidenz). Danach sieben neue Tests grün.
- Vollständige Config-Package-Suite: **60/60**, 0 Failures/Skips/Todos. Der alte Test für reservierte
  Namespaces enthält jetzt providers/oauth; decision hat einen eigenen vollständigen Default-Test.
- `cargo test -p plur1bus-config`: **20/20 Integrationstests**, keine ignorierten Tests. Der erste
  Lauf zeigte `0.0`/`0`-Parität im Schema; auf ganzzahlige Null vereinheitlicht, erneut grün.
- `pnpm gen`, `pnpm docs:gen`, Fixture-Driftprüfung, workspaceweiter `pnpm typecheck`,
  Hygiene und Dokumentlinks: grün. Generated-Dateien nur durch Generatoren verändert.
- Unabhängige Read-only-Prüfung von ADR, Schema, Tests und Diff: keine umsetzbaren Befunde.

Keine Inferenz, keine Modell-API, keine bezahlten Aufrufe; F1 benötigt keine Provider-Fakes.
CI wurde nicht gepollt. Native Plattformmessungen sind nicht Teil dieser Vertragsphase.

## Noch offen / Folgephasen

F2 muss die neuen Einstellungen tatsächlich lesen sowie Client, role-Backend, Triage-/Pruning-
Adapter, Trace, Metriken und beide geschützten RPC-Methoden liefern. D70-Modulpackaging,
Laya-ONNX, deutsches Gate, Jev/Kev und native Messungen bleiben F3/F4. F5–F7 integrieren weitere
Verbraucher und Web. F1 behauptet keine dieser Laufzeitfunktionen. Keine Owner-Frage blockiert F1.

Merge und Engine-Pin bleiben beim Controller; kein Merge/Rebase/Amend/Force-Push.
