# Coverage-Welle 2 2026-10: Tests für die neuen Pakete

Dieser Bericht gehört zum Branch `haiku/test-coverage-wave2` (Basis `origin/main`, Stand `433ca5b3`, nach #306).
Der Auftrag war, die Testabdeckung der neu gemergten Pakete zu erhöhen, **ausschließlich mit neuen Testdateien**.
Produktionscode, bestehende Tests, `package.json`, Lockfiles und Konfigurationen sind unverändert.
Die PR-Prüfung `git diff --name-status origin/main | grep -v '^A'` ist leer: alle Änderungen sind Hinzufügungen.

## Zusammenfassung

- **25 neue TypeScript-Testdateien** (hostctl 8, media 6, remote-access 5, api 2, embedding-adapters 4) und **5 neue Rust-Testdateien** (`coverage_completions`, `coverage_login`, `coverage_channel`, `coverage_uninstall`, `coverage_update`).
- **Tests:** 256 in hostctl, 109 in media, 77 in remote-access, 17 in api, 64 in embedding-adapters (TS) und 53 in Rust. Die übersprungenen sind alle als `BUG:` oder `UNKLAR:` markiert.
- **Befunde:** 2 Bugs (P3, als übersprungene Tests mit korrekter Erwartung), 11 offene Fragen (UNKLAR). Kein Produktcode wurde geändert.
- **Coverage:** Alle 25 Zieldateien erreichen 100 % Zeilen. Die Zweigabdeckung liegt bei 83–100 % (Tabelle unten, niedrigster Wert `search.ts`).
- **Gates:** `pnpm lint` (Typecheck und Hygiene) grün, `pnpm docs:check` grün, alle Paketsuiten grün. Jede neue Datei wurde 5× hintereinander ausgeführt: unter **macOS** durch die Agenten (lokal, Node v26.8.2), unter **Linux** von mir nachgeprüft im Container `node:26.11.1` (TS-Dateien) bzw. `rust:1.95` (Rust-Dateien).
- **Gefundenes Flake:** Ein Lauf von `coverage_login` schlug unter Linux fehl (`BrokenPipe` beim Schreiben in stdin, weil der Prozess vor dem Lesen beendet wurde). Die Testhilfe ignoriert diesen erwarteten Schreibfehler jetzt; danach 10/10 Läufe unter Linux grün. Der Fehler war ein Testproblem, kein Produktfehler.

## Methode

- **Zielbereiche:** `packages/hostctl`, `packages/media`, `packages/remote-access`, `packages/api` (ohne remote-access-Teile), `packages/embedding-adapters`, plus `crates/plur1bus` für `uninstall`, `login`, `channel`, `completions` und `update`.
- **Test-Runner:** `packages/hostctl` nutzt vitest. Alle anderen Pakete nutzen `node:test` mit `--experimental-strip-types`. Die Vorgaben wurden entsprechend übertragen.
- **Coverage-Messung:**
  - `media`, `remote-access`, `api`, `embedding-adapters`: `node --experimental-test-coverage` mit `--test-coverage-include='src/**/*.ts'`, Ausgabe als lcov. Der Paket-Befehl liefert keine Tabelle, siehe Befund F-1.
  - `hostctl`: Das Paket hat kein Coverage-Werkzeug. Für die Messung wurde `@vitest/coverage-v8@4.0.18` im Arbeitsklon hinzugefügt, gemessen und danach per `git checkout` samt Lockfile zurückgesetzt. Ein Abgriff über `NODE_V8_COVERAGE` lieferte keine Quelldateien, weil vitest die transformierten `src`-Dateien nicht als Datei-URLs ausführt (Befund F-2).
  - `crates/plur1bus`: Kein Coverage-Werkzeug im Repo. Rust-Abdeckung ist nicht gemessen, es werden keine Zahlen angegeben.
- **Auswahl der 25 Dateien:** Ranking nach `(100 − Zeilen %) + (100 − Zweige %)` über die Zielpakete, auf Basis von `origin/main`. Für `embedding/cohere.ts` und `retry.ts` gab es denselben Score (10.0). `retry.ts` ist die 25. Datei.
- **Stabilität:** Keine Wall-Clock-Asserts, keine festen Ports (Port 0), Temp-Verzeichnisse per `mkdtemp` mit Aufräumen, `socket.setNoDelay(true)` auf akzeptierten Sockets, Streams zeilenweise gepuffert, auf beobachtbare Ereignisse gewartet. Timeouts in hostctl laufen über Fake-Timer, nicht über die Wanduhr.
- **Verifikation:** Jede neue Datei einzeln 5× hintereinander (macOS lokal, Linux im Container). Danach die Paketsuiten vollständig, `pnpm lint`, `pnpm docs:check`, die fünf Rust-Dateien mit `cargo test -p plur1bus --test <name>` (Cargo akzeptiert kein Glob bei `--test`).

## Neue Testdateien

| Paket | Datei | Ziel (`src/…`) | Tests (pass / skip) |
|---|---|---|---|
| hostctl | `test/pool.coverage.test.ts` | `pool.ts` | 10 / 0 |
| hostctl | `test/search.coverage.test.ts` | `search.ts` | 21 / 1 |
| hostctl | `test/index.coverage.test.ts` | `index.ts` | 51 / 4 |
| hostctl | `test/native.coverage.test.ts` | `native.ts` | 10 / 0 |
| hostctl | `test/processes.coverage.test.ts` | `processes.ts` | 65 / 0 |
| hostctl | `test/errors.coverage.test.ts` | `errors.ts` | 45 / 3 |
| hostctl | `test/atomic.coverage.test.ts` | `atomic.ts` | 16 / 0 |
| hostctl | `test/files.coverage.test.ts` | `files.ts` | 38 / 0 |
| media | `test/adapters-coreml-jsonl.coverage.test.ts` | `adapters/coreml-jsonl.ts` | 18 / 0 |
| media | `test/adapters-shared-images.coverage.test.ts` | `adapters/_shared/images.ts` | 27 / 0 |
| media | `test/coreml.coverage.test.ts` | `coreml.ts` | 23 / 0 |
| media | `test/cost.coverage.test.ts` | `cost.ts` | 6 / 0 |
| media | `test/http.coverage.test.ts` | `http.ts` | 22 / 0 |
| media | `test/store.coverage.test.ts` | `store.ts` | 13 / 0 |
| media | `test/coverage-helpers.coverage.ts` (Helfer, kein Test) | — | — |
| remote-access | `test/x509.coverage.test.ts` | `x509.ts` | 20 / 2 |
| remote-access | `test/tailscale.coverage.test.ts` | `tailscale.ts` | 22 / 1 |
| remote-access | `test/company-ca.coverage.test.ts` | `company-ca.ts` | 9 / 0 |
| remote-access | `test/pinning.coverage.test.ts` | `pinning.ts` | 8 / 1 |
| remote-access | `test/pair-proof.coverage.test.ts` | `pair-proof.ts` | 14 / 0 |
| api | `test/api-notices.coverage.test.ts` | `notices.ts` | 13 / 1 |
| api | `test/api-owner-token-platform.coverage.test.ts` | `owner-token.ts` (Windows-Pfad) | 3 / 0 |
| embedding-adapters | `test/deps.coverage.test.ts` | `deps.ts` | 12 / 0 |
| embedding-adapters | `test/embedding-ollama.coverage.test.ts` | `embedding/ollama.ts` | 20 / 0 |
| embedding-adapters | `test/rerank-base.coverage.test.ts` | `rerank/base.ts` | 6 / 1 |
| embedding-adapters | `test/retry.coverage.test.ts` | `retry.ts` | 25 / 0 |
| crates/plur1bus | `tests/coverage_completions.rs` | `commands/completions.rs` | 9 / 0 |
| crates/plur1bus | `tests/coverage_login.rs` | `commands/login.rs`, `commands/secret.rs` | 13 / 1 |
| crates/plur1bus | `tests/coverage_channel.rs` | `commands/channel.rs` | 8 / 0 |
| crates/plur1bus | `tests/coverage_uninstall.rs` | `commands/uninstall.rs` | 10 / 0 |
| crates/plur1bus | `tests/coverage_update.rs` | `commands/update*.rs`, `update/` (bundle, guard, plan) | 13 / 0 |

## Coverage vorher → nachher je Datei

Zeilen und Zweige in Prozent. „vorher“ ist `origin/main`, „nachher“ der Stand dieses Branches. Quelle: lcov (`node --experimental-test-coverage`) für media, remote-access, api und embedding-adapters; v8 mit vitest für hostctl.

| Paket | Datei | Zeilen vorher | Zeilen nachher | Zweige vorher | Zweige nachher |
|---|---|---|---|---|---|
| hostctl | `pool.ts` | 85.71 | 100.00 | 50.00 | 100.00 |
| hostctl | `search.ts` | 100.00 | 100.00 | 50.00 | 83.33 |
| hostctl | `index.ts` | 84.78 | 100.00 | 73.91 | 98.91 |
| hostctl | `native.ts` | 93.75 | 100.00 | 68.18 | 95.45 |
| hostctl | `processes.ts` | 96.00 | 100.00 | 73.98 | 94.30 |
| hostctl | `errors.ts` | 100.00 | 100.00 | 81.48 | 100.00 |
| hostctl | `atomic.ts` | 100.00 | 100.00 | 80.55 | 91.66 |
| hostctl | `files.ts` | 98.52 | 100.00 | 82.02 | 91.01 |
| media | `adapters/coreml-jsonl.ts` | 98.04 | 100.00 | 85.39 | 98.11 |
| media | `http.ts` | 98.72 | 100.00 | 86.46 | 98.50 |
| media | `cost.ts` | 100.00 | 100.00 | 85.71 | 100.00 |
| media | `coreml.ts` | 99.37 | 100.00 | 87.27 | 97.49 |
| media | `adapters/_shared/images.ts` | 100.00 | 100.00 | 86.67 | 99.43 |
| media | `store.ts` | 96.30 | 100.00 | 92.59 | 100.00 |
| remote-access | `x509.ts` | 96.52 | 100.00 | 84.85 | 97.56 |
| remote-access | `tailscale.ts` | 100.00 | 100.00 | 81.82 | 100.00 |
| remote-access | `company-ca.ts` | 98.78 | 100.00 | 87.06 | 98.86 |
| remote-access | `pinning.ts` | 100.00 | 100.00 | 87.50 | 100.00 |
| remote-access | `pair-proof.ts` | 100.00 | 100.00 | 89.41 | 100.00 |
| api | `notices.ts` | 100.00 | 100.00 | 88.89 | 100.00 |
| api | `owner-token.ts` | 92.50 | 100.00 | 96.67 | 100.00 |
| embedding-adapters | `deps.ts` | 100.00 | 100.00 | 50.00 | 100.00 |
| embedding-adapters | `embedding/ollama.ts` | 100.00 | 100.00 | 83.33 | 100.00 |
| embedding-adapters | `rerank/base.ts` | 94.20 | 100.00 | 94.12 | 100.00 |
| embedding-adapters | `retry.ts` | 100.00 | 100.00 | 90.00 | 96.77 |

Alle Zweigwerte sind gestiegen. Die verbleibenden Lücken sind defensiv oder nicht deterministisch auslösbar, siehe „Bewusst ausgelassen“. Den niedrigsten Wert hat `search.ts` (83.33 %): Der eine ungedeckte Zweig ist der Fall „rg-Exit-Code 2“, der als UNKLAR offen ist.

## Paketsummen

| Paket | Zeilen vorher → nachher | Zweige vorher → nachher | Funktionen vorher → nachher |
|---|---|---|---|
| hostctl (v8) | 94.80 → 100.00 | 76.71 → 94.85 | 78.65 → 92.13 |
| media | 99.48 → 100.00 | 92.31 → 96.96 | 96.67 → n. m. |
| remote-access | 99.51 → 99.78 | 92.42 → 96.44 | 99.00 → n. m. |
| api | 99.86 → 100.00 | 97.26 → 97.43 | 98.15 → n. m. |
| embedding-adapters | 99.15 → 99.39 | 95.08 → 96.52 | 97.08 → n. m. |

„n. m.“ = Funktionsabdeckung nach der Arbeit nicht erneut gemessen (lcov-Summe nur für Zeilen und Zweige). Die Paketwerte sind über alle Quelldateien, nicht nur die 25 Zieldateien.

## Rust: `crates/plur1bus`

Das Repo hat kein Coverage-Werkzeug für Rust. Deshalb gibt es hier keine Prozentzahlen. Die Dateien decken diese Pfade ab:

- **completions:** `completions::script()` für bash, zsh, fish, powershell und elvish, die Flag- und Subcommand-Namen im Output, Fehler für unbekannte oder fehlende Shell, `manpages()` (Erfolg und IO-Fehler).
- **login:** Plan-Ablehnungen (Schlüssel im Argument, unbekannter Provider, Provider fehlt, nicht unterstützte Route, ungültiger Name), Eingabe per stdin (leer, übergroß, nur Leerraum), `E_CORE_UNAVAILABLE` für alle zehn API-Key-Provider, Status, Liste und Logout ohne Core, clap-Konflikte und Timeout-Bereich. Ein eingegebener Schlüssel wird nie ausgegeben, und es wird nichts unter `HOME` geschrieben.
- **channel:** clap-Parsing jedes Blattes, Hilfe pro Blatt, Werte mit führendem Bindestrich, `E_CORE_UNAVAILABLE` für jedes Blatt, keine Konfiguration ohne Core.
- **uninstall:** Flag-Konflikte, `-y`, Dry-Run-Text, `check_purge_home` (unsafe-home für `/` und für ein Home, das das Benutzerhome enthält, Home ist Symlink), Determinismus des Plans, expliziter `--backup-out`, Dry-Run ohne Home.
- **update:** clap-Modus-Konflikte, `status` (idle, Zustand nicht lesbar), Rollback ohne Ziel, `bundle::open` (unlesbar, Archiv nicht unterstützt, ungültig, unsigniert), `ca-bundle-invalid`, `guard::load` (für Plan und Apply), Ablehnung ohne Bestätigung mit Bereinigung des Bundles, Plan-Ausgabe, „up to date“, Locale-Auflösung. Alle Läufe nutzen lokale Bundles und einen Test-Release-Schlüssel, keiner berührt das Netz.

Die Befehle werden über `assert_cmd` mit eigenem `HOME` (tempfile) ausgeführt. Kein Test liest das echte `~/.plur1bus` oder `~/.openclaw`.

## Befunde am Testaufbau (keine Produktbugs)

- **F-1 (P3): Coverage-Gate von `media` misst nichts.** `packages/media/package.json` übergibt `--test-coverage-include=src/**/*.ts` ungequotet an die Shell. Der Lauf von `pnpm --filter @plur1bus/media test` gibt nur `start of coverage report` und `end of coverage report` aus, ohne eine einzige Datei. Die Schwellen 85/85/85 gelten damit für eine leere Menge und bestehen immer. Reproduktion: `pnpm --filter @plur1bus/media test` und die Ausgabe ansehen. Mit quotiertem Glob erscheint die Tabelle. Nicht geändert, weil `package.json` tabu ist.
- **F-2 (P3): `hostctl` hat kein Coverage-Werkzeug.** `@vitest/coverage-v8` fehlt in den devDependencies, daher gibt es kein Coverage-Gate. Der Lauf mit `NODE_V8_COVERAGE` liefert für `src/**` keine Daten, weil vitest die transformierten Dateien nicht als Datei-URL ausführt. Die Messung erfolgte mit einem temporären Hinzufügen, das wieder zurückgesetzt wurde.
- **F-3 (Testaufbau, behoben): Race in `coverage_login.rs`.** Die Hilfsfunktion `piped` hat den Schreibfehler auf stdin mit `unwrap` behandelt. Eine Routen-Ablehnung beendet den Prozess vor dem Lesen, dann liefert `write_all` `BrokenPipe`. Unter Linux schlug einer von 5 Läufen fehl. Der Schreibfehler wird jetzt bewusst ignoriert. Exit-Code und Ausgabe werden weiter geprüft. Danach 10/10 Läufe unter Linux grün.

## Bugs

Jeder Bug steht als übersprungener Test mit der **korrekten** Erwartung. Der Quelltext ist unverändert.

<a id="x509-pem-empty"></a>
### x509-pem-empty

- **Datei/Zeile:** `packages/remote-access/src/x509.ts` (`pemEncode`, Regex-Match auf leeren Base64-String mit Non-Null-Assertion)
- **Erwartung:** `pemEncode("X", new Uint8Array(0))` liefert einen PEM-Block mit leerem Körper.
- **Ist:** `TypeError: Cannot read properties of null (reading 'join')`.
- **Reproduktion:** Test `packages/remote-access/test/x509.coverage.test.ts` ohne `skip` ausführen (Marker `BUG: pemEncode("X", empty DER)`).
- **Schweregrad:** P3. Heute ruft niemand `pemEncode` mit leerem DER auf.

<a id="bugs-app-open-nonexistent-target"></a>
### bugs-app-open-nonexistent-target

- **Datei/Zeile:** `packages/hostctl/src/index.ts:85` (`app.open`)
- **Erwartung:** Ein nicht existierendes Ziel, `javascript:...` oder `file:...` wird abgelehnt, bevor der OS-Opener läuft.
- **Ist:** `canonicalise` prüft mit `access 'read'`, verlangt aber keine Existenz. Nicht-URL-Strings gehen direkt an den OS-Opener. Der Opener wird mit `<root>/javascript:alert(1)`, `<root>/file:/etc/hosts` oder `<root>/missing.txt` aufgerufen, und die Antwort ist `ok: true`.
- **Reproduktion:** `host.invoke('hostctl.app.open', { target: 'javascript:alert(1)' }, ctx)` mit fake Opener.
- **Schweregrad:** P3.

## Unklar

Die Fragen 1–9 sind als übersprungene Tests (`UNKLAR:`) markiert, es wird dort nichts erwartet. Die Fragen 10 und 11 halten das aktuelle Verhalten fest (der Test läuft und ist grün), sind aber als offene Frage notiert.

1. **hostctl `errors.ts`:** Sollen `FsFailure` mit `exists`, `changed` und `invalid-arguments` auf `EXISTS`, `CHANGED` und `INVALID_ARGUMENT` abgebildet werden, oder ist `IO_ERROR` gewollt? (3 Tests)
2. **hostctl `index.ts` (invoke):** Ein fehlgeschlagenes End-Audit nach einem erfolgreichen Schreiben liefert `ok: false` mit `IO_ERROR`, obwohl geschrieben wurde. Ist das beabsichtigt?
3. **hostctl `search.ts`:** Ein `rg`-Exit-Code 2 gilt als „kein Treffer“ (`code === 0`). Soll stattdessen auf `text.includes` zurückgefallen werden?
4. **remote-access `x509.ts`:** Ein nicht-ASCII-DNS-Name im SAN wird als Latin-1-Bytes in das `dNSName`-Feld geschrieben. Soll er abgelehnt, als Punycode kodiert oder unverändert übernommen werden?
5. **remote-access `tailscale.ts` (`detectTailscale`):** Die CLI verschwindet zwischen `version` und `status --json` (ENOENT). Der Fehler wird heute weitergereicht. Ist Werfen der gewollte Vertrag, oder soll „nicht installiert“ zurückkommen?
6. **remote-access `pinning.ts` (`presentedFromSocket`):** Ein `raw` mit Länge 0 wird als SHA-256 des leeren Strings gepinnt. Soll es wie ein fehlendes Zertifikat abgelehnt werden?
7. **api `notices.ts`:** Ein negatives `maxUsers` (z. B. `-1`) wird nicht validiert. Soll es abgelehnt oder auf 0 geklemmt werden?
8. **embedding-adapters `rerank/base.ts`:** `rerank(query, docs, null)` landet bei `opts.topN` und kommt als `bad_response` zurück. `embedding/base.ts` meldet ein ähnliches Argumentproblem als `invalid_request`. Welcher Fehlertyp gilt für `null`-Optionen?
9. **crates `login`/`secret`:** Ein API-Schlüssel aus nur Leerzeichen oder Tabs wird akzeptiert (`secret::parse_value` prüft nur auf leer und NUL). Soll er abgelehnt werden? Das betrifft auch `secret set`. Der Test ist mit `#[ignore = "UNKLAR: ..."]` markiert.
10. **media `coreml`/Ausgabedatei:** Eine Ausgabedatei, die ein Symlink ist, wird als `too_large` abgelehnt, das bestehende Verhalten ist so festgeschrieben. Ist `invalid_response` korrekt? Der Test prüft das aktuelle Verhalten und ist kein Bug.
11. **media `coreml`-Helfer:** Ein Helfer, der eine Datei auflistet, die er nie geschrieben hat, liefert `backend_unavailable`. Auch hier ist das aktuelle Verhalten festgeschrieben, nicht als Bug markiert.

## Bewusst ausgelassen

- **hostctl:** Die Trash- und Opener-Argumente für darwin, linux und win32 sind schon in `native.test.ts` abgedeckt, daher nicht doppelt. Ein echter Papierkorb unter darwin würde Finder ansteuern. Die Gesamtobergrenze von 128 Prozessen in `processes.ts` wird nicht getestet, um den Lauf billig zu halten. Windows-spezifische Pfade (Junction-Escape, reservierte Namen, `taskkill`) brauchen einen Windows-Host und sind mit `skipIf` für POSIX-Läufe markiert. Die nicht erreichbaren `'ok' in handle`-Zweige in `atomic.ts` und `files.ts` brauchen ein Rennen, das sich nicht deterministisch auslösen lässt.
- **remote-access:** `x509.ts:61` (Guard für fehlerhafte SPKI) ist mit Schlüsseln aus `node:crypto` nicht erreichbar. `x509.ts:99` (Fix-up der Seriennummer `|| 0x01`) bräuchte kontrollierte `randomBytes`, also ein Mock. `company-ca.ts:68` (catch in `issuedBy`) hat keinen deterministischen Auslöser gefunden.
- **media:** Gestreamte Antworten über 64 MiB werden nicht getestet (zu langsam). Nur der Pfad über `content-length` ist abgedeckt. Die Zweige in `http.ts` (L41 Origin-Prüfung, unerreichbar), `coreml.ts` (L90/102/106/117/156) und `images.ts` (L99) sind defensiv und nicht erzwungen.
- **embedding-adapters:** Keine.
- **Rust:** Keine Coverage-Zahl (kein Werkzeug im Repo). `cargo test` für den ganzen Workspace wurde nicht ausgeführt, nur die fünf neuen Dateien.
- **Vorbefund auf `main`:** Welle 1 hat in `packages/api/test/api-server.coverage.test.ts` einen übersprungenen `BUG:`-Test, der nicht zu diesem Auftrag gehört und unverändert blieb.
