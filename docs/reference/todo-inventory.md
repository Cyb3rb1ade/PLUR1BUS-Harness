# TODO-Inventar

This inventory lists every comment in the repo that contains an uppercase TODO, FIXME, XXX or HACK token (case-sensitive). Build output, dependency folders, generated files and the planning trees under docs/superpowers, docs/phase0 and docs/handoff are excluded. Scan command: `rg -n -e '\b(TODO|FIXME|XXX|HACK)\b'` with the exclusion globs listed below.

| Datei:Zeile | Text | Modul |
|---|---|---|
| docs/adr/ADR-009-dreaming-scheduler.md:315 | `TODO(D111)` marks the emit site (prose reference, not a code comment) | docs (ADR) |
| packages/core/src/session/compaction.ts:3 | TODO(M2): LLM summarisation behind the same `Summarizer` shape; thresholds from measured provider token counts | @plur1bus/core |
| packages/core/src/session/compaction.ts:24 | Measured counts replace it (L14, TODO) | @plur1bus/core |
| packages/core/src/dreams/types.ts:111 | the pinned engine still writes DREAMS.md: TODO(engine) rename for harness hosts | @plur1bus/core |
| packages/core/src/dreams/scheduler.ts:93 | TODO(D111): emit these as catalogued log-schema events once packages/log-schema is on main | @plur1bus/core |
| packages/core/src/dreams/scheduler.ts:432 | TODO(engine): one guaranteed diary entry per deep sweep, C1 | @plur1bus/core |
| packages/core/src/dreams/index.ts:29 | TODO(engine): the pinned engine still writes DREAMS.md; until it follows D15 `exists` stays false | @plur1bus/core |

## Zählung je Modul

| Modul | Anzahl |
|---|---|
| @plur1bus/core | 6 |
| docs (ADR) | 1 |
| **Summe** | **7** |

## Ausgeschlossen

- `node_modules`, `target`, `dist`, `build`: Abhängigkeits- und Build-Ausgaben, keine Quelltexte.
- Generierte Dateien: `docs/rpc.md`, `docs/cli.md`, `docs/openapi.json` und Lockfiles. Sie enthalten keine Treffer.
- `docs/superpowers`, `docs/phase0`, `docs/handoff`: Planungsdokumente. 5 Treffer in 5 Dateien wurden ausgeschlossen (nur als Anzahl genannt).
- `apps/desktop/mock-harness/CONTRACT.md:19` enthält `XXXX-XXXX` als Code-Format-Platzhalter, kein Kommentar-Marker.
