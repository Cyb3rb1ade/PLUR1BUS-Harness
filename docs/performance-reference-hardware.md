# O6 — Referenzgeräte / reference hardware

## Deutsch

Der Owner benennt die Geräte und liefert die Zahlen. Aktuell: **wartet auf Owner-Messung**. Der Collector installiert nichts, ändert keine Dienste und verwendet frische temporäre Harness-Homes mit synthetischen Daten. Er speichert CPU-Modell, logische Kerne, RAM, OS-Version, Architektur und nach Möglichkeit den Speichertyp. Keine Hostnamen, Benutzernamen, Seriennummern, IP-Adressen oder Umgebungsvariablen. Ein unbekannter Speichertyp bleibt `null`.

Voraussetzung: vorhandener Checkout mit Node **24.21.0**, pnpm **10.28.0**, Rust **1.95**, installierten gepinnten Workspace-Abhängigkeiten sowie `pnpm prep` und `cargo build --release -p plur1bus`. Der Collector selbst baut/installiert nichts. Terminalausgaben können lokale Pfade enthalten; für die Weitergabe sind nur die erzeugten JSON/Markdown-Berichte vorgesehen.

### macOS arm64

```sh
node scripts/bench/reference-hardware.mjs --out /tmp/o6-macos
# Mit bereits vorhandenem Default-Modellcache, keine Download-Zeit als Startzeit ausgeben:
node scripts/bench/reference-hardware.mjs --real-models --models-cache /absoluter/pfad/zum/modellcache --out /tmp/o6-macos-models
```

### Linux x64 / arm64

```sh
node scripts/bench/reference-hardware.mjs --out /tmp/o6-linux
node scripts/bench/reference-hardware.mjs --real-models --models-cache /absoluter/pfad/zum/modellcache --out /tmp/o6-linux-models
```

### Windows x64 / arm64 (PowerShell)

```powershell
node scripts/bench/reference-hardware.mjs --out "$env:TEMP/o6-windows"
node scripts/bench/reference-hardware.mjs --real-models --models-cache 'C:/absoluter/pfad/modellcache' --out "$env:TEMP/o6-windows-models"
```

Der echte Modelllauf initialisiert den Default-Embedder und Reranker je Prozess. Der erste Lauf ist ausdrücklich ein ungewerteter Warmup (kann fehlende Dateien herunterladen); danach mindestens **30** gewertete Starts. Flat- und Modelllauf getrennt aufbewahren. Keine privilegierte Cache-Leerung; „kalt“ bedeutet neuer Prozess/Home bei unkontrolliertem OS-Dateicache. Kein Ausreißer wird verworfen. B4 enthält 500 feste Abfragen und 10 Warmups; B2/B3 30 Messungen und 3 Warmups; B11 200 Messungen und 20 Warmups.

JSON und Markdown entstehen unter `<out>.json`/`<out>.md`. Für den B7-Vergleich `--baseline /pfad/zum/vorherigen.json` ergänzen (gleicher Corpus). **Exit 2 bedeutet unvollständige Abdeckung**, insbesondere B10; das ist kein erfolgreicher Abnahmenachweis. B5 kann das Ziel verfehlen. Das Skript ersetzt keine LRU-Soak-Messung, echten Provider-Tokenzähler oder nativen Syscall-Trace. B2 beginnt beim RPC-Submit und schließt den CLI-Prozessstart aus. Mock-Cache-/Tokenwerte sind als synthetisch markiert.

Geräte während der Messung nicht anderweitig belasten; Last/VM/Antivirus-Umstände im Begleittext dokumentieren. Owner/Controller prüft die Reports und legt sie später mit Gerätebezeichnung (ohne Seriennummer) unter `docs/reports/` ab. Windows-ARM-Policy und Gate-Promotion erfolgen separat nach drei grünen Läufen.

## English

The owner selects reference devices and supplies the measurements: **awaiting owner measurement**. The collector uses fresh temporary Harness homes and synthetic data, installs nothing, changes no services, and stores only an allowlist of hardware fields (CPU model, logical cores, RAM, OS version, architecture, best-effort storage type). Unknown media stay `null`; no usernames, hostnames, serials, addresses or environment dumps are retained.

Use an already prepared checkout: Node **24.21.0**, pnpm **10.28.0**, Rust **1.95**, pinned dependencies installed, `pnpm prep`, `cargo build --release -p plur1bus`. The collector does not perform setup. Terminal errors may show local paths; share the generated JSON/Markdown files.

### macOS arm64

Run `node scripts/bench/reference-hardware.mjs --out /tmp/o6-macos`. Add `--real-models --models-cache /absolute/model/cache` for the model run and use a separate output prefix.

### Linux x64 / arm64

Run `node scripts/bench/reference-hardware.mjs --out /tmp/o6-linux`. Repeat with `--real-models --models-cache /absolute/model/cache` and a separate output prefix.

### Windows x64 / arm64

In PowerShell: `node scripts/bench/reference-hardware.mjs --out "$env:TEMP/o6-windows"`. Repeat with `--real-models --models-cache 'C:/absolute/model/cache'` and a separate output prefix.

Startup uses 30 samples minimum. Cold means fresh process/home, not flushed OS caches. Warm B1 has 3 warmups; B8 has 1 untimed warmup, including any initial model download. Every model process loads from the shared disk cache afresh. No outliers are discarded. B4 uses a fixed 500-query corpus and 10 warmups; B2/B3 use 30 samples/3 warmups; B11 uses 200/20.

Outputs are `<out>.json` and `<out>.md`. Supply `--baseline previous.json` for the B7 >10% regression alert with the same corpus. **Exit 2 means incomplete coverage**, particularly the missing B10 LRU soak; it is not acceptance. A B5 target miss is retained. Mock token/cache counts are synthetic; B2 starts at RPC submit, excluding CLI launch. B9 uses the existing JS proxy and does not claim native syscall coverage.

Keep other load quiet and describe VM/antivirus/load conditions alongside the report. The owner/controller later commits reviewed reports under `docs/reports/` with a non-identifying device label. Windows ARM advisory policy and three-run gate promotion remain separate owner/controller tasks.
