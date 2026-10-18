# O6 — Referenzgeräte / reference hardware

## Deutsch

**Hardwaredaten werden ausschließlich aus dem vom Messwerkzeug erzeugten Report übernommen.** Modell/CPU, Kerne, RAM, OS-Produktversion und Kernel-/Build-Version, Architektur, Speichertyp (soweit ermittelbar), Node-Laufzeit und Gesamtdauer werden auf dem gemessenen Gerät erhoben. Keine manuellen Hardwarezahlen, keine Werte vom Host für einen VM-Gast. Keine Hostnamen, Benutzernamen, Seriennummern, IP-Adressen oder Umgebungsvariablen werden gespeichert. Nicht ermittelbare Werte bleiben `null`.

Die Geräterollen stammen vom Owner; sie sind keine Hardwaremessungen:

| Rolle | Ausführung | Host-Rolle | Verfügbarkeit | Ergebnis |
|---|---|---|---|---|
| `owner-mac` | Owner-Mac, Apple Silicon, macOS arm64 | physisches Gerät | Owner-Gerät | wartet auf Owner-Messung |
| `nas-windows-x64` | Windows 11 x64 VM | NAS | läuft dauerhaft | wartet auf Owner-Messung |
| `parallels-windows-arm64` | Windows 11 arm64 Parallels-VM | Owner-Mac | externe Platte muss angeschlossen sein | wartet auf Owner-Messung |
| `nas-ubuntu-x64` | Ubuntu x64 VM | NAS | Owner-VM | wartet auf Owner-Messung |

VM-Reports sind ausdrücklich als VM gekennzeichnet und nennen die Host-Rolle **NAS** bzw. **Owner-Mac**, keinen persönlichen Hostnamen. Gemessene logische Kerne sind dort **vCPUs**, der RAM ist der dem Gast sichtbare RAM. Host-Hardware wird nicht aus Gastdaten abgeleitet. Budgetgrenzen bleiben unverändert sichtbar, VM-Ergebnisse sind jedoch diagnostisch und **keine Bare-Metal-Abnahme**. Ein Vergleich muss diesen Unterschied ausdrücklich nennen. Die ausgewählte Rolle wird vor dem Start mit dem tatsächlich erkannten OS und der Architektur abgeglichen; eine unpassende Rolle wird abgewiesen.

Voraussetzung: vorbereiteter Checkout mit Node **24.21.0**, pnpm **10.28.0**, Rust **1.95**, den gepinnten Workspace-Abhängigkeiten sowie ausgeführtem `pnpm prep` und `cargo build --release -p plur1bus`. Die folgenden Befehle werden jeweils **im Repository-Verzeichnis auf dem betreffenden Gerät** ausgeführt. Der Collector installiert nichts und ändert keine Dienste.

### 1. Owner-Mac — macOS arm64

```sh
node scripts/bench/reference-hardware.mjs --device-role owner-mac --all-scenarios --out /tmp/o6-owner-mac
```

### 2. NAS-VM — Windows 11 x64 (PowerShell)

```powershell
node scripts/bench/reference-hardware.mjs --device-role nas-windows-x64 --all-scenarios --out "$env:TEMP/o6-nas-windows-x64"
```

### 3. Parallels — Windows 11 arm64 (PowerShell)

Externe Platte anschließen und die VM starten, dann **in der VM**:

```powershell
node scripts/bench/reference-hardware.mjs --device-role parallels-windows-arm64 --all-scenarios --out "$env:TEMP/o6-parallels-windows-arm64"
```

### 4. NAS-VM — Ubuntu x64

```sh
node scripts/bench/reference-hardware.mjs --device-role nas-ubuntu-x64 --all-scenarios --out /tmp/o6-nas-ubuntu-x64
```

Jeder Befehl erzeugt `<out>.json` und `<out>.md`, mit Hardware-/VM-Kontext, Laufzeit, Gesamtdauer, Rohwerten, Warmups und bekannten Lücken. `--all-scenarios` misst B1/B8/B11 ohne lokale Modelle, anschließend mit echten Default-Modellen und die Runtime-Probes mit echten Embeddings. Das Werkzeug legt einen temporären Modellcache an, lädt bei Bedarf die gepinnten Default-Modelldateien und entfernt diesen Cache anschließend mit den temporären Homes. Kein systemweiter Model-Install. Eine Internetverbindung und ausreichend temporärer Speicher sind dafür nötig. Optional kann `--models-cache /absoluter/cache` einen bereits vorhandenen Cache wiederverwenden; die vier Standardbefehle benötigen keinen einzutragenden Cachepfad.

Der erste Modellstart ist ausdrücklich ein ungewerteter Warmup einschließlich eines möglichen Downloads; danach mindestens **30** gewertete Starts. Die Gesamtdauer im Report umfasst auch Vorbereitung/Download und ist nicht die B8-Latenz. Keine privilegierte Cache-Leerung: „kalt“ bedeutet neuer Prozess/Home bei unkontrolliertem OS-Dateicache. Kein Ausreißer wird verworfen. B4: 500 feste Abfragen/10 Warmups; B2/B3: 30 Messungen/3 Warmups; B11: 200 Messungen/20 Warmups. B6/B9 sind Invarianten, keine Zeitperzentile.

Für B7 kann `--baseline /pfad/zum/vorherigen.json` mit gleichem Corpus ergänzt werden. **Exit 2 bedeutet unvollständige Abdeckung**, insbesondere B10; der Report wird trotzdem geschrieben. Exit 1 meldet einen Ausführungsfehler. B5 kann das Ziel verfehlen. B10-LRU-Soak, echte Provider-Tokenzähler und native Syscall-Traces werden nicht durch Ersatzwerte als erfüllt ausgegeben. B2 beginnt beim RPC-Submit und schließt den CLI-Prozessstart aus. Mock-Cache-/Tokenwerte bleiben synthetisch gekennzeichnet.

Während des Laufs andere Last möglichst ruhig halten; zusätzliche VM-/Antivirus-/Lastumstände im Begleittext dokumentieren. Der Owner/Controller übernimmt die Gerätewerte **aus den Reports**, prüft sie und legt sie später unter `docs/reports/` ab. Solange ein Geräte-Report fehlt: **wartet auf Owner-Messung**. Windows-ARM-Policy und Gate-Promotion erfolgen separat nach den geforderten drei grünen Läufen. Terminalfehler können lokale Pfade enthalten; zum Weitergeben sind die erzeugten JSON-/Markdown-Dateien vorgesehen.

## English

**Hardware specifications come only from the generated device report**, never from manually entered numbers. The collector records the device/guest model, CPU, logical cores, RAM, OS product and kernel/build versions, architecture, best-effort storage type, Node runtime and elapsed measurement duration. Unknown values remain `null`. No hostnames, usernames, serials, addresses or environment dumps are retained.

Owner-designated roles: Apple Silicon owner Mac (`owner-mac`); always-running Windows 11 x64 VM on the NAS (`nas-windows-x64`); Windows 11 arm64 Parallels VM on the owner Mac, available only with the external drive connected (`parallels-windows-arm64`); Ubuntu x64 VM on the NAS (`nas-ubuntu-x64`). All device results are **awaiting owner measurement** until their reports exist. These role labels are owner-provided provenance, not measured hardware specifications.

VM reports identify the VM, its host role (**NAS** or **Owner-Mac**) and guest-visible vCPU/RAM. They never infer host hardware from guest values. Unchanged budget limits are diagnostic for VMs; a VM result is **not bare-metal acceptance**. Any comparison must explicitly state that distinction. The supplied role must match the detected OS/architecture.

Use an already prepared checkout: Node **24.21.0**, pnpm **10.28.0**, Rust **1.95**, pinned dependencies installed, `pnpm prep` and `cargo build --release -p plur1bus` completed. Run the single command inside the repository **on the named device/guest**. The collector installs no system software and changes no services.

### 1. Owner Mac — macOS arm64

```sh
node scripts/bench/reference-hardware.mjs --device-role owner-mac --all-scenarios --out /tmp/o6-owner-mac
```

### 2. NAS VM — Windows 11 x64 (PowerShell)

```powershell
node scripts/bench/reference-hardware.mjs --device-role nas-windows-x64 --all-scenarios --out "$env:TEMP/o6-nas-windows-x64"
```

### 3. Parallels VM — Windows 11 arm64 (PowerShell)

Connect the external drive and start the VM first. Inside the guest:

```powershell
node scripts/bench/reference-hardware.mjs --device-role parallels-windows-arm64 --all-scenarios --out "$env:TEMP/o6-parallels-windows-arm64"
```

### 4. NAS VM — Ubuntu x64

```sh
node scripts/bench/reference-hardware.mjs --device-role nas-ubuntu-x64 --all-scenarios --out /tmp/o6-nas-ubuntu-x64
```

Each command writes `<out>.json` and `<out>.md`. `--all-scenarios` runs startup without models, startup with the actual default models, then runtime probes with real embeddings. A temporary model cache is populated if needed and removed afterward with the temporary homes. Internet access and temporary disk space are required; no global installation occurs. Optionally supply `--models-cache /absolute/cache` to reuse a populated cache; the standard commands need no placeholder paths.

There are at least 30 startup samples. Cold means fresh process/home, not flushed OS caches. Warm B1: 3 warmups; B8: 1 excluded warmup, including any initial download. Total measurement duration includes download/preparation and is distinct from B8 latency. No outliers are discarded. B4: 500 fixed queries/10 warmups; B2/B3: 30 samples/3 warmups; B11: 200/20. B6/B9 are invariant checks.

`--baseline previous.json` enables the B7 comparison for the same corpus. **Exit 2 means incomplete coverage**, especially the missing B10 soak; files are still written. Exit 1 denotes execution failure. B5 misses are retained. Mock usage remains synthetic; B2 excludes CLI launch; B9 does not claim full native syscall coverage.

Keep competing load quiet and describe VM/antivirus/load circumstances alongside the reports. The owner/controller copies hardware figures **from those reports** and later commits reviewed files under `docs/reports/`. Until then: **awaiting owner measurement**. Windows ARM policy and three-run gate promotion remain separate decisions. Share generated JSON/Markdown, since terminal errors may contain local paths.
