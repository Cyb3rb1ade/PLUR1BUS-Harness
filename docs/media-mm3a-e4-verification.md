# MM-3a: E4-Verifikation für PR #866

Geprüft am 2026-11-01 gegen den Re-Review auf `fc47ccd1`. Dieser Nachweis gilt für
die drei E4-Fixes, nicht für die spätere Engine-Anbindung oder Medieninferenz.

## Store und Integrationsprüfungen

- Prune/Recovery lesen unter der Store-Sperre keine Nutzdaten und berechnen dort keinen Payload-Hash.
  Die deterministische Read-Spionage bleibt bei null; gleich große Bit-Korruption bleibt gespeichert,
  und `getUploaded` verweigert sie weiterhin wegen des falschen Hashes.
- Der Paralleltest füllt eine konfigurierte Quota zu über 99 % mit vier Uploads zu je 4 MiB.
  Ein zweiter Store lädt während Prune ein Bild hoch, bei 200 ms Sperrfrist. Nur im Test verzögert
  eine Lesenaht Nutzdatenzugriffe um 300 ms: der alte Scan scheitert, der Metadatenpfad besteht.
  Das ist ein deterministischer Regressionstest, kein 1-GiB-Durchsatzbenchmark.
- Eingespeiste EIO/EACCES/EMFILE erhalten Bytes und Owner-Bindungen; Warnungen enthalten nur
  `storage-unavailable`. Spätere Läufe können belegte Korruption oder regulär abgelaufene Uploads
  weiterhin entfernen. Die neun neuen Store-Regressionen scheiterten vor dem Fix und bestehen danach.
- Store-Fokus: 33/33; Media komplett: 465 bestanden, 0 Fehler, 2 bestehende CoreML-Plattform-Skips;
  Produktionsfabrik: 3/3; Core-Medienintegration: 101/101, jeweils ohne Fehler oder Skips.
- Globale TypeScript-Prüfung, `pnpm lint` (163 bestanden, 0 Fehler, 3 bestehende TODOs)
  und `pnpm docs:check` bestanden. Keine neue RPC-/Schema-/Contract-Version.

## 20 aufeinanderfolgende Browser-Dateiläufe

Der Produktfix hält den Speichern-Knopf nach erfolgreichem `config.set` bis zum akzeptierten
Reload gesperrt. Der Regressionstest hält `config.get` gezielt zurück und prüft einen weiteren
Klick ohne zweiten Schreibaufruf, Fehlerbehandlung und einen Refresh mit gleicher Revision.

Node 24.21.0; tatsächlicher Browser Chromium 154.0.8037.57 unter Linux.
Je Lauf ein neuer Node-Prozess mit der vollständigen `media-capabilities.test.ts`, seriell,
Abbruch beim ersten Fehler, kein Test- oder Prozess-Retry. Die Quellhashes wurden vor jedem Lauf geprüft.
Der bestehende lokale System-Browser-Override war aktiv; dies ist kein positiver Lauf mit dem
gepinnten CI-Browser. Dessen vorheriger Download lieferte HTTP 403. Der Required-Browser-Guard
und der CI-Pin bleiben erhalten.

```bash
for mm_run in {01..20}; do
  PLUR1BUS_WEB_BROWSER= PLUR1BUS_WEB_E2E_REQUIRED= PLUR1BUS_CHROMIUM=/usr/bin/chromium \
    node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning \
    --test --test-reporter=tap --test-concurrency=1 --test-timeout=120000 \
    packages/web/test/media-capabilities.test.ts > "run-$mm_run.log" 2>&1 || exit 1
done
```

Zeitraum (UTC): `2026-11-01T19:20:01.674Z` bis `2026-11-01T19:23:46.212Z`.

| Lauf | Bestanden | Fehler / Skips / TODO / Abbruch | Exit |
|---:|---:|---:|---:|
| 01 | 16 | 0 / 0 / 0 / 0 | 0 |
| 02 | 16 | 0 / 0 / 0 / 0 | 0 |
| 03 | 16 | 0 / 0 / 0 / 0 | 0 |
| 04 | 16 | 0 / 0 / 0 / 0 | 0 |
| 05 | 16 | 0 / 0 / 0 / 0 | 0 |
| 06 | 16 | 0 / 0 / 0 / 0 | 0 |
| 07 | 16 | 0 / 0 / 0 / 0 | 0 |
| 08 | 16 | 0 / 0 / 0 / 0 | 0 |
| 09 | 16 | 0 / 0 / 0 / 0 | 0 |
| 10 | 16 | 0 / 0 / 0 / 0 | 0 |
| 11 | 16 | 0 / 0 / 0 / 0 | 0 |
| 12 | 16 | 0 / 0 / 0 / 0 | 0 |
| 13 | 16 | 0 / 0 / 0 / 0 | 0 |
| 14 | 16 | 0 / 0 / 0 / 0 | 0 |
| 15 | 16 | 0 / 0 / 0 / 0 | 0 |
| 16 | 16 | 0 / 0 / 0 / 0 | 0 |
| 17 | 16 | 0 / 0 / 0 / 0 | 0 |
| 18 | 16 | 0 / 0 / 0 / 0 | 0 |
| 19 | 16 | 0 / 0 / 0 / 0 | 0 |
| 20 | 16 | 0 / 0 / 0 / 0 | 0 |

**Gesamt: 320 bestanden, keine Fehler, Skips, TODOs, Abbrüche oder Retries.**

Quell-SHA-256 der gesamten Serie:

| Datei | SHA-256 |
|---|---|
| `packages/web/src/pages/media-search/override.ts` | `05f11303d5fd04a3fbfb90c7e35714670594b1eafb7031d3534c85344221df6e` |
| `packages/web/test/media-capabilities.test.ts` | `09e2c5d9b8badc0139406a8458fab1d8e98f4893271394bb893150ded6c6c378` |
| `packages/web/src/pages/common/load.ts` | `d7d77876679284d979db6eace4f3f95a4220e33e7c980f66a972786e2038dfc8` |

Die 20 Roh-TAP-Logs und `summary.json` liegen unter
`/workspace/reports/mm866-e4-browser-20/`; Root und eine unabhängige Nachprüfung haben alle
Roh-Zähler und Quellhashes gelesen und bestätigt. Der deterministische RED-Lauf und die
anschließenden grünen Fokusläufe sind separat erhalten. Vor der Serie scheiterte ein neu
erweiterter Fehlerpfadtest an einem mehrdeutigen Retry-Knopf-Selektor; dieser wurde auf den
betroffenen Fehlerbereich begrenzt. In der aufgezeichneten 20er-Serie trat kein Fehler auf.
