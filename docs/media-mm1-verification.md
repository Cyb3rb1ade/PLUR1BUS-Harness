# MM-1: Verifikation und Abnahmegrenzen

Stand: 2026-11-01. Der finale Mac-Modelltest für `f2bddf31` besteht. Im vollständigen
Engine-Crate bestehen alle 111 Bibliotheks- und 23 Transport-Integrationstests,
darunter 56 Medientests. Clippy für alle Engine-Targets einschließlich `real-models`
besteht mit `-D warnings`. Dieser Bericht ist ein Prüfstand
für den PR, keine pauschale Freigabe aller Plattformen und Betriebsfälle.

MM-1 ergänzt die Rust-Bibliothek um lokale Bild-, Audio- und Video-Embeddings mit
nativen, normalisierten 768-dimensionalen Segmentvektoren. Standardbudgets sind
140 Bild- und 70 Video-Soft-Tokens, Audiofenster höchstens 30 Sekunden und Video
höchstens 32 gleichmäßig gewählte Frames in Gruppen von 2–4. Textvertrag, RPC und
Store-v1 erhalten durch diesen Schritt keine neue Schnittstelle.

## Nachweisumfang

Der finale Mac-Lauf verwendet alle tatsächlichen Media-, K-Transport-, gemeinsamen
ORT-Session- und vendorten Decoderquellen. Die 71 Quelldatei-Hashes stimmen mit
`f2bddf31` überein. Der Repository-Testkörper
[`media_model_parity.rs`](../crates/plur1bus-engine/tests/media_model_parity.rs)
bleibt bytegleich; der minimale Harness ergänzt nur einen Crate-Alias und Adapter
für die umgebenden generierten Vertrags-/Embedding-Typen. Er kompiliert weder Lance
noch den vollständigen Engine-Crate und ist kein vollständiger Engine-Prozesstest.
Die separate Cloud-Prüfung kompiliert das tatsächliche Engine-Crate und führt seine
Bibliotheks- und Transporttests aus.

Modellrevision ist `daa72c51243991dfcaf9f9137d2c573d8f7790c0`, ORT ist 1.30.0,
Referenzen sind Transformers.js 4.3.1 und Pillow 12.3.0. Größen und SHA-256 der
Modellartefakte und der vorhandenen ORT-Bibliothek werden vor dem Laden geprüft.
Der Mac-Modelllauf nutzt den vorbereiteten Cache offline. Die Profilwahl setzt auf
Linux x86_64/arm64, macOS arm64 und Windows x86_64/arm64 Q8 ein; native Modellnachweise
liegen hier für macOS arm64 vor. Testmedien sind selbst erzeugt; Modellgewichte,
Modellvektoren und fremde Bilder werden nicht eingecheckt.

## Prüfmatrix

| Bereich | Ergebnis | Aussagegrenze |
|---|---|---|
| Vollständiges Engine-Crate | **111/111 Bibliotheks- und 23/23 Transporttests bestanden**, 0 Fehler/ignoriert; darin 56 Medientests | Produktkompilierung und tatsächliche Crate-Grenzen geprüft; nativer Modelltest bleibt der separate Mac-Harness-Lauf. |
| Finaler Mac-Repository-Modelltest | **1/1 bestanden**, 0 Fehler/ignoriert, 22,63 s; Stand `f2bddf31` | Tatsächlicher Testkörper und Produktquellen im beschriebenen Harness mit Vertragsadaptern. |
| Bildvorverarbeitung | Exakte Pillow-RGB-Resize-Parität über 48 erzeugte Fälle; Apache-Patchlayout, Skalierung und Positionen exakt | Diese Fälle prüfen den Resampler; JPEG-Decoderabweichungen werden separat bewertet. |
| Audio-Vorverarbeitung | Python-Log-Mel-Toleranz `1e-5`, Masken-/Patchlayout geprüft; eigene 512-Punkt-FFT | Mono, 16 kHz; Dekodierung/Resampling angelieferter Audiodateien ist nicht Teil dieses Bibliotheksschritts. |
| Gleiche Modell-Eingabetensoren | Bild-/Audio-Features und finale Vektoren jeweils Kosinus `>=0.9999` | Kein Ersatz für den JPEG-End-to-End-Vergleich. |
| Gleiche Pillow-dekodierte Pixel | Gesamter Resize-/Skalierungs-/Encoderpfad für alle vier finalen Fälle `>=0.9999999999999984` | Erfüllt die unveränderte Schwelle `0.9999`. |
| Native Eingaben | Dynamische Bildformen `[B,P,768]` / `[B,P,2]`, Audio `float[B,T,128]` und **bool**-Maske im echten ORT geprüft | Native Modellnachweise auf macOS arm64; weitere Zielplattformen sind damit nicht ausgeführt. |
| Native Audio-Parität | Feature-Kosinus `0.999999999996068`, final `0.999999999999084` | Finaler Mac-Test mit echter bool-Maske; Schwelle jeweils `0.9999`. |
| Abbruch | 25-ms-Deadline beendet echten Vision-Lauf nach 33,96 ms; anschließender Lauf erfolgreich | Messstand `7674627e`; natives Modellladen ist nur vor/nach dem Aufruf abbrechbar. |
| Text während nativer Vision | Starke Überlappungsprüfung: p95 **63,05 ms**, Maximum 64,45 ms, 30 Aufrufe | Kurze echte 13-Token-Abfrage, warme Sessions; kein allgemeiner Worst-Case- oder Recall-Nachweis. |
| Ressourcen | Audio-Mehrverbrauch **969,64 MB**, Video kumulativ **1,614 GB**, jeweils unter 2 GiB | Frühere native Messstände und identische Video-Testframes; Details unten. |
| E3-Budgets | 280/140/70: jeweils 20/20 Treffer auf Rang 1, MRR 1 | 20 einfache eigene synthetische Szenen; Deckeneffekt, keine fotografische Qualitätsabnahme. |
| Bildgrenzen und P1-Regressionen | 64 MiB kodierte/native Decoder-Ausgabe, 40 Mio. Pixel, Container-/Metadaten-/innere WebP-Dimensionen vor Decoder geprüft | Decoderinterne Bibliotheksgrenzen sind teilweise Best-Effort; zusätzliche explizite Prüfungen bleiben aktiv. |
| Laufzeit-Review | FIFO-/Symlink-Verweigerung, Initialisierung vor Prioritätsabsenkung und budgetabhängige Identität korrigiert; Review geschlossen | Windows-Datei-/Schedulingpfade quellengeprüft, nicht nativ ausgeführt. |
| Explizite Modellvorbereitung über K | 12 Vorbereitungstests, 2 Grenzwerttests und 23 bestehende Transporttests bestanden; unabhängiges Review ohne bestätigten Befund | Quellcode-Harness/Loopback, kein echter HF-Download; automatischer Core-Aufruf bleibt MM-3b. |
| MM-1-Lint und Dokumentation | Lint: 163 bestanden, 0 Fehler, 3 bestehende LAYA-TODOs; `pnpm docs:check` bestanden | Lauf im MM-1-Arbeitsbaum; fehlende Cloud-Modellartefakte werden nicht als bestanden gewertet. |
| Engine-Clippy | **Bestanden:** `--all-targets --features real-models -- -D warnings` | Alle Engine-Testtargets kompiliert; echte Modelle werden dadurch nicht in der Cloud ausgeführt. |
| Abhängigkeiten / Attribution | Lizenzprüfung 0 Verstöße; Release-Audit 0 blockierende Befunde und 0 Erfassungs-/Policyfehler | Bestehende Owner-Ausnahmen und Warnungen bleiben sichtbar; keine Policyänderung. |
| Produktions-Binary / Bauzeit | **Gemessen:** Baseline `df525459`, Kandidat `7993b634`: jeweils 877168 B; kalt 1283,54/1153,44 s, warm 0,52/0,60 s | Gleiche Basis/Toolchain, jeweils ein Messpaar mit `RUSTC_WRAPPER=""`; aktueller Einstiegspunkt vor RE-08, kein Maß für geladenen Encoder-Code. |
| Recall / übrige native Ziele | **Offen** | Echter Recall `<600 ms` und native Modellausführung auf den übrigen Release-Zielen sind nicht nachgewiesen. |

## Finale eingefrorene JPEG-/PNG-Fälle

Alle vier eigenen 320×240-Fälle wurden vor der Messung eingefroren: derselbe
RGB-Verlauf, JPEG-Qualität 85 mit 4:2:0, 4:4:4 und progressivem 4:2:0 sowie PNG.
Der finale Lauf verwendet dieselben ursprünglichen Bytes über `--reuse`; vorhandene
Pillow-Decode-/Resize-Referenzen müssen bytegleich bleiben. Die unabhängige
Pixelprüfung erfolgt **vor** jedem Kosinusvergleich. Kein Mittelwert ersetzt einen
fehlgeschlagenen Einzelfall.

| Fall | Max. RGB-Kanalabweichung | Mittlere absolute Abweichung | Finaler End-to-End-Kosinus | Vorgabe |
|---|---:|---:|---:|---|
| JPEG 4:2:0 | 2 LSB | 0.006532118056 LSB | 0.999865899927659 | `max<=2`, Kosinus `>=0.9997` |
| JPEG 4:4:4 | 2 LSB | 0.010373263889 LSB | 0.999890726595500 | `max<=2`, Kosinus `>=0.9997` |
| JPEG progressiv 4:2:0 | 2 LSB | 0.006532118056 LSB | 0.999865899927659 | `max<=2`, Kosinus `>=0.9997` |
| PNG verlustfrei | 0 LSB | 0 | 1.000000000000002 | `max=0`, Kosinus `>=0.9999` |

Der PNG-Wert knapp über 1 entsteht durch Gleitkomma-Rundung. Kodierte SHA-256:

| Fall | SHA-256 |
|---|---|
| JPEG 4:2:0 | `275600883a904440cb349a22492ed0801b4c8eced541928a0ca9aa07e124e2f9` |
| JPEG 4:4:4 | `94982dba5134512b938ac274cddf6b8a8fe10319ac8f4ae4e65ad4290be6a843` |
| JPEG progressiv 4:2:0 | `ba122821ce273585dc73c84edbf6acad1dcf77343cb3aa2450b4bef2202c4901` |
| PNG verlustfrei | `b770835aabb13db72fb346d1d4cc6f467952acb93c5894becaf3f9568693ccaf` |

Der Controller hat `0.9997` pro JPEG ausdrücklich als End-to-End-Schwelle festgelegt:
Pillow/libjpeg-turbo und Rust können beim Dekodieren anders runden. Der erste eigene
JPEG-Nachweis lag bei 2 LSB und `0.9998677548178285`. Für gleiche dekodierte Pixel,
gleiche Modell-Eingaben und PNG bleibt die strengere Schwelle `0.9999` bestehen.
Die später eingefrorenen 4:2:0-Fälle scheiterten mit dem ursprünglichen Decoder bei
4 LSB und `0.9996163998778644`; sie wurden unverändert zur Regression übernommen.

Ursache war zweimaliges Runden der vertikalen/horizontalen Chroma-Interpolation.
Der freigegebene lokale `zune-jpeg`-Patch kombiniert die Gewichte und rundet einmal
mit alternierenden Biaswerten 8/7. Nur vier HV-Samplerdateien unterscheiden sich vom
verifizierten veröffentlichten Paket; IDCT und Farbumrechnung bleiben gleich.
Die Bildidentität erfasst dies als `mm1-image-v2` mit `zune0.5.15-fused-hv-v1`.
[Provenienz und lokale Quellprüfung](../vendor/zune-jpeg/PLUR1BUS-PATCH.md) sind enthalten.

Die 2-LSB-Aussage gilt für die angegebenen Referenzfälle. Zusätzliche kleine,
hochfrequente 32×24-Bilder hatten bereits vorher höhere Randabweichungen:
RGB maximal 9 LSB, YCCK maximal 5 LSB. Der Patch senkt dort den mittleren Fehler,
belegt aber keine universelle JPEG-Äquivalenz. Grayscale, CMYK/YCCK und
EXIF-Ausrichtung bleiben unterstützt. Der geprüfte alternative Decoder wurde nach
einem fehlgeschlagenen Einzelfall-Kosinus nicht übernommen.

## Latenz, Speicher und Budgetvergleich

Die starke Überlappungsprüfung startet echte native Vision-Arbeit 50 ms vor der
Textmessung und erfasst den aktiven Zustand vor/nach jedem Textaufruf. Zwei native
Vision-Läufe dauern 1289,99/1099,09 ms. Text-p95 beträgt 63,05 ms; zusätzlicher
RSS 504102912 B. Die frühere breitere Provider-Messung bleibt getrennt sichtbar:
Text-p95 149,73 ms, Maximum 180,26 ms, kaltes Foto 2379 ms, zwei Video-Frames 1104 ms.
Die stärkere warme Messung ersetzt diese knappe breitere Messung nicht.

| Last, Stand `7674627e` | Dauer | Mehr-RSS gegenüber geladenem Text |
|---|---:|---:|
| 30 s Audio, 480000 Samples, ein Segment | 2504,79 ms | 969637888 B, etwa 969,64 MB |
| 32 Video-Frames, nach Audio im selben Prozess | 13818,99 ms | 1613807616 B, etwa 1,614 GB |

Text-Baseline war 262307840 B; die kumulative Spitze lag bei 1876115456 B.
Die 32 Frames wiederholen dasselbe eigene Bild und prüfen den maximalen
Tensor-/Anzahlpfad. Ressourcen-, Abbruch- und Überlappungsmessungen stammen vom
Stand `7674627e`; die Erstaufruf-/Budgetpfade wurden auf `60ba2460` nachgeprüft.
Eine vollständige Wiederholung aller Ressourcenmessungen auf `f2bddf31` liegt nicht vor.

E3 nutzt auf `60ba2460` echte q8-Textabfragen und 20 unabhängig benannte eigene
synthetische Szenen. Alle 20 zugehörigen Abfragen erreichen bei 280, 140 und 70
Soft-Tokens jeweils Rang 1; Top-1 20/20, MRR 1. Gesamtlaufzeiten für je 20 Bilder:
70040,99 / 20591,26 / 9237,37 ms. Mehr-RSS 1026506752 B. Dieser Deckeneffekt
belegt auf diesen einfachen Szenen keinen Rangverlust; für schwierigere oder
fotografische Inhalte fehlt ein entsprechender Qualitätsnachweis.

## Abhängigkeiten, Lizenzen und Attribution

Neu gegenüber der Basis ist die folgende Bilddecoder-Closure. Angegeben sind die
veröffentlichten Versionen, Veröffentlichungstage und Lizenzalternativen. Alle
Versionen sind nicht zurückgezogen und älter als die geforderten 14 Tage.

| Crate | Version | Veröffentlicht | Lizenz (`OR`) |
|---|---|---|---|
| image | 0.25.10 | 2026-03-10 | MIT / Apache-2.0 |
| byteorder-lite | 0.1.0 | 2024-04-07 | Unlicense / MIT |
| fdeflate | 0.3.7 | 2024-12-06 | MIT / Apache-2.0 |
| image-webp | 0.2.4 | 2025-08-27 | MIT / Apache-2.0 |
| miniz_oxide | 0.8.9 | 2025-06-09 | MIT / Zlib / Apache-2.0 |
| moxcms | 0.8.1 | 2026-03-07 | BSD-3-Clause / Apache-2.0 |
| png | 0.18.1 | 2026-02-14 | MIT / Apache-2.0 |
| pxfm | 0.1.30 | 2026-07-06 | BSD-3-Clause / Apache-2.0 |
| quick-error | 2.0.1 | 2021-05-07 | MIT / Apache-2.0 |
| zune-core | 0.5.3 | 2026-08-07 | MIT / Apache-2.0 / Zlib |
| zune-jpeg | 0.5.15 | 2026-03-26 | MIT / Apache-2.0 / Zlib |

`image` bleibt exakt auf 0.25.10 mit deaktivierten Standardfeatures und ausschließlich
JPEG/PNG/WebP festgelegt. Die vollständige 29-Paket-Closure wurde lizenzgeprüft;
alle verfügbaren Lizenzalternativen sind zulässig, die jüngste Version ist 44 Tage
alt. Audio-FFT und Pillow-Resampler liegen im eigenen Quellbaum; Modellvorbereitung
verwendet den bestehenden K-Transport.

Der vendorte `zune-jpeg`-Quellstand ist das bestehende Paket 0.5.15: 39 ursprüngliche
Dateien, davon vier deklarierte Änderungen; ursprüngliche MIT-, Apache- und
Zlib-Lizenztexte sowie Copyrightvermerke bleiben erhalten. Der Pfadpatch ist kein
Workspace-Mitglied. Neun geerbte Leerraumstellen bleiben zur bytegenauen Provenienz
unverändert. Unabhängiges Review und positive/negative Quellbelegprüfung sind erfolgt.

`audit-deps`: 0 Lizenzverstöße, keine unvollständige Erfassung. Der rohe `cargo deny`
meldet weiterhin das bestehende `paste`-Wartungsadvisory `RUSTSEC-2024-0436`.
Die unveränderte Owner-Ausnahme gilt bis 2027-01-30; der maßgebliche
`scripts/release/audit-policy.mjs`-Lauf meldet **0 blockierende Befunde und
0 Erfassungs-/Policyfehler**. `deny.toml` und Allowlist wurden nicht angepasst.

Commit `27e88836` erhält bei der Attribution alle **199 nativen NPM-Inventarzeilen**
und **196 nativen NPM-Notice-Verweise/Hashes** der Basis `df525459`. Dies sind keine
Gesamtzahlen aller Lizenztextblöcke. Die drei vendorten Lizenztexte werden zusätzlich
erfasst; die Regression für vendorte `source:null`-Pakete besteht.

## Reproduktion und offene Restprüfungen

Die [Reproduktionsanleitung](../scripts/media/README.md) nennt Cache-, ORT-, Node-
und Python-Voraussetzungen sowie den unveränderten `real-models`-Test. Fehlende
Voraussetzungen führen zum Fehler. `PLUR1BUS_MEDIA_PARITY_FIXTURES` verwendet die
ursprünglichen eingefrorenen Bytes erneut.

Die vollständige Engine-Kompilierung erreichte zunächst den Testlinker, der am
32-GB-Dateisystemlimit mit einem Linker-Busfehler scheiterte; dabei liefen keine
Tests. Der erneute Lauf reduzierte ausschließlich Debugdaten des Engine-Testpakets
(`debug=0`, `strip=debuginfo`), bei unveränderten Produktabhängigkeiten und
Assertions. Damit bestehen alle 111 Bibliothekstests einschließlich der 56 Medientests sowie
die 23 echten Transport-Integrationstests, jeweils ohne Fehler und ignorierte Tests.
`cargo clippy --locked -p plur1bus-engine --all-targets --features real-models -- -D warnings`
besteht ebenfalls. Der Aufbau der nativen Build-Abhängigkeiten dieses Check-Profils
ist keine Messung einer vollständigen kalten Produktionsbauzeit.

### Controller-Baseline und Gegenmessung auf macOS

**Baseline und Gegenmessung liegen vor.** Der Controller-Bericht
`/Users/cyberblade/worktrees/reviews/mm1-macos-baseline.md` misst Main-Commit
`df5254598fc484870194efb2caa3cedf8f187e09`. Die Gegenmessung verwendet ausschließlich
Kandidat `7993b634108222bb0c39f604eb620645376232a5`: dessen Merge-Base ist exakt
`df525459`, ohne Merge eines späteren Main-Stands im Kandidatenbereich. Beide
sauberen Worktrees und die Toolchain/HW-Angaben wurden geprüft.

| Messung | Main `df525459` | MM-1 `7993b634` | Differenz |
|---|---:|---:|---:|
| Produktions-Binary | 877168 B | 877168 B | 0 B (0 %) |
| Kalt: real | 1283,54 s | 1153,44 s | −130,10 s (−10,136 %) |
| Kalt: user / sys | 2553,99 / 120,20 s | 2275,59 / 113,45 s | |
| Kalt: maximaler Build-RSS | 2290909184 B | 2159837184 B | |
| Warm: real | 0,52 s | 0,60 s | +0,08 s |
| Warm: user / sys | 0,20 / 0,17 s | 0,18 / 0,16 s | |
| Warm: maximaler Build-RSS | 181714944 B | 185008128 B | |

Alle vier Builds haben Exitcode 0; beide warmen Läufe haben keine
`Compiling`-/`Running`-Zeile und denselben Hash wie ihr jeweiliger kalter Lauf.
Baseline-SHA-256: `5e395a4c0dd3561262590a11f1b9b4a3fe114b325792f1688fd3e0568750d0aa`.
Kandidaten-SHA-256: `cc5441a53794872ff7ba7b2254da985010cd8961e3b06058ffbe86c8e1cc5e31`.
Gleiche Bytezahl bedeutet hier keinen gleichen Binary-Hash. Die Bauzeitdifferenz
stammt aus je einem Lauf; sie belegt keinen kausalen Geschwindigkeitsgewinn durch MM-1.

Beide Messungen: Mac17,9, 48 GiB RAM, 18 logische CPUs, macOS 27.2 (26B123),
rustc/cargo 1.95.0, LLVM 22.1.2, Apple Clang 21.0.0, SDK 27.2, CMake 4.4.3.
Der aktuelle `plur1bus-engine`-Einstiegspunkt vor RE-08 bietet nur `--version` und
den noch nicht implementierten `serve`-Pfad. Die unveränderte Binary-Größe misst
diesen Einstiegspunkt; sie ist keine Aussage über den Platzbedarf der noch nicht
angebundenen Medienpipeline oder geladener ORT-/Modelldateien.

**MM-1 wird als Library kompiliert, erreicht die gemessene ausführbare Datei aber
nicht als Medienpipeline.** `crates/plur1bus-engine/src/lib.rs` bindet `pub mod media`
ohne `cfg` ein. Es gibt kein Media-Feature-Flag: `real-models = []` schaltet
Modelltests frei (Integrationstest-Targets und das lokale ORT-Testmodul), keine
Produktionsmodule. Der gemessene Release-Build verwendet es nicht. Die
aufgezeichnete rustc-Ausführung baut die Library ohne
Feature-`cfg`. Ihr Release-Archiv enthält 110 definierte Media-Symbole, darunter
`LocalMediaEmbedder::new`/`embed`, `decode_rgb`/`preprocess` und
`prepare_media_artifacts`.

`src/main.rs` referenziert aus der Library ausschließlich die Konstante
`CRATE_VERSION`; kein ausführbarer Pfad ruft Media-Code auf. Die erhaltenen
Baseline- und Kandidaten-Binaries haben jeweils 1886 Symbole in `nm`, darunter
keine Media-Symbole; beide enthalten weiterhin den `serve`-Stubtext. Die
Kompilierung der Library bedeutet deshalb noch keine Einbindung ihrer
unreferenzierten Medienimplementierung in diese ausführbare Datei. Ein bestimmter
LTO-Modus ist nicht belegt und wird als Erklärung nicht vorausgesetzt.

Die **0 B Größenänderung belegen keinen MM-1-Laufzeit-Footprint**. Eine solche
Messung benötigt den produktiv angebundenen Media-Pfad nach RE-08 und eine dazu
passende neue Baseline; das Aktivieren von `real-models` stellt diese Anbindung
nicht her. Die oben genannten unterschiedlichen SHA-256 wurden erneut an beiden
erhaltenen Binaries geprüft; aus der identischen Länge folgt keine Bytegleichheit.

Der Gegenmessbericht liegt auf dem Mac unter
`/Users/cyberblade/worktrees/reviews/mm1-macos-countermeasurement-7993b634.md`.
Binärdatei und Rohbelege bleiben unter
`/private/tmp/mm1-macos-counter-7993b634.gg81yk85/` erhalten; die gesicherte Binary
liegt in `bin/plur1bus-engine`. Das zugehörige Ergebnis liegt im Cloud-Bericht
`/workspace/reports/mm1-macos-countermeasurement.txt` und in dessen Ergebnis-JSON.

Gemessen wird die tatsächliche Engine-Binary `plur1bus-engine`, Paket
`plur1bus-engine`, Cargo-Profil **release** mit Standardfeatures, Ziel
**aarch64-apple-darwin**, **zwei Build-Jobs**, `CARGO_INCREMENTAL=0`. Es wird weder
der Paritätsharness noch ein Testprogramm gemessen. Die Bytezahl gilt für die
unverpackte, nicht nachträglich gestrippte/signierte Cargo-Ausgabe. Zusätzliche
Compilerflags, Profilüberschreibungen und Compiler-Cache-Wrapper müssen für beide
Vergleichsstände deaktiviert sein; Rust-, Clang-/SDK- und CMake-Version bleiben gleich.
Verbindliche, vom Controller dokumentierte Abweichung zum ursprünglichen Protokoll:
`~/.cargo/config.toml` setzt sccache als `build.rustc-wrapper`. Deshalb deaktivieren
**beide** gemessenen Stände diesen Wrapper ausdrücklich mit `RUSTC_WRAPPER=""`.
Die Kandidaten-Logs enthalten 663 direkte rustc-Aufrufe und keinen sccache-Aufruf;
die globale Cargo-Konfiguration wurde nicht geändert. Die folgenden Befehle bilden
diese Einstellung ab. Ein späterer Main-/RE-08-Stand braucht eine neue Baseline.
Der untenstehende Guard prüft bekannte Umgebungsüberschreibungen. Zusätzlich prüft
der Controller lokale/übergeordnete und benutzerspezifische Cargo-Konfigurationen
auf Rustflags, Compiler-/Wrapperwahl und Release-Profiländerungen. Native
CC/CXX-/CMake-Overrides dürfen den Vergleich ebenfalls nicht verändern. Der
Verbose-Buildlog belegt die tatsächlichen Rust-Compileraufrufe; Zugangsdaten aus
Cargo-Konfigurationen gehören nicht in den Bericht.

**Kalt** bedeutet: neues, zuvor nicht vorhandenes Cargo-Target-Verzeichnis, also
keine kompilierten Rust-/CMake-Artefakte. Cargo-Quellen werden vorher geladen;
Netzzeit gehört nicht zur Bauzeit. Der Betriebssystem-Dateicache wird nicht geleert.
**Warm** ist der unmittelbar folgende identische Build ohne Quelländerung im selben
Target-Verzeichnis; dies ist der Cargo-Cache-/No-op-Lauf, kein kalter Neubau.

Die folgenden Befehle in Bash in einem sauberen, zuvor aktualisierten `main`-Worktree
auf dem Apple-Silicon-Mac ausführen. Sie verändern weder Branch noch globalen
Buildcache. `/usr/bin/time -lp` protokolliert je Lauf `real`, `user`, `sys` und RSS;
Cargo-Fortschritt und Zeitwerte stehen gemeinsam in der jeweiligen `stderr`-Datei.
Nur Läufe mit Exitcode 0 sind Messwerte.

```bash
set -euo pipefail
test "$(uname -sm)" = "Darwin arm64"
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)"
for mm1_name in $(compgen -e); do
  case "$mm1_name" in
    RUSTC_WRAPPER)
      test -z "${RUSTC_WRAPPER:-}" || { echo "Nichtleerer Compiler-Wrapper" >&2; exit 1; } ;;
    RUSTC|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUST*|CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS|CARGO_PROFILE_*|CC|CXX|CFLAGS|CXXFLAGS|CC_*|CXX_*|CFLAGS_*|CXXFLAGS_*|CPPFLAGS|LDFLAGS|CMAKE_ARGS|CMAKE_TOOLCHAIN_FILE*|CMAKE_BUILD_PARALLEL_LEVEL)
      echo "Vor der Messung entfernen: $mm1_name" >&2; exit 1 ;;
  esac
done

mm1_target=aarch64-apple-darwin
mm1_measure_dir="$(mktemp -d "${TMPDIR:-/tmp}/mm1-macos-baseline.XXXXXX")"
mm1_binary="$mm1_measure_dir/target/$mm1_target/release/plur1bus-engine"
git rev-parse HEAD > "$mm1_measure_dir/source-commit.txt"
rustc -Vv > "$mm1_measure_dir/rustc.txt"
cargo -V > "$mm1_measure_dir/cargo.txt"
sw_vers > "$mm1_measure_dir/macos.txt"
xcrun clang --version > "$mm1_measure_dir/clang.txt"
xcrun --show-sdk-version > "$mm1_measure_dir/sdk.txt"
cmake --version > "$mm1_measure_dir/cmake.txt"
sysctl -n hw.model hw.memsize hw.logicalcpu > "$mm1_measure_dir/hardware.txt"
RUSTC_WRAPPER="" cargo fetch --locked --target "$mm1_target"

RUSTC_WRAPPER="" CARGO_TARGET_DIR="$mm1_measure_dir/target" CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never \
  /usr/bin/time -lp cargo build --locked --offline --release --verbose --jobs 2 \
  --target "$mm1_target" -p plur1bus-engine --bin plur1bus-engine \
  > "$mm1_measure_dir/cold.stdout" 2> "$mm1_measure_dir/cold.stderr"
stat -f '%z' "$mm1_binary" > "$mm1_measure_dir/binary-bytes.txt"
shasum -a 256 "$mm1_binary" > "$mm1_measure_dir/binary-sha256.txt"
file "$mm1_binary" > "$mm1_measure_dir/binary-kind.txt"

RUSTC_WRAPPER="" CARGO_TARGET_DIR="$mm1_measure_dir/target" CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never \
  /usr/bin/time -lp cargo build --locked --offline --release --verbose --jobs 2 \
  --target "$mm1_target" -p plur1bus-engine --bin plur1bus-engine \
  > "$mm1_measure_dir/warm.stdout" 2> "$mm1_measure_dir/warm.stderr"
shasum -a 256 "$mm1_binary" > "$mm1_measure_dir/warm-binary-sha256.txt"
cmp "$mm1_measure_dir/binary-sha256.txt" "$mm1_measure_dir/warm-binary-sha256.txt"
if LC_ALL=C grep -Eq 'Compiling[[:space:]]|Running[[:space:]]' "$mm1_measure_dir/warm.stderr"; then
  echo "Warmer Wiederaufbau; nicht als No-op-Messung ausgeben: $mm1_measure_dir" >&2
  exit 1
fi
echo "Messbelege: $mm1_measure_dir"
```

In `mm1-macos-baseline.md` gehören mindestens Main-Commit, obiger Build-Befehl,
Profil/Ziel/Jobs, Toolchain und Hardware, absoluter Binary-Pfad, Bytezahl/SHA-256,
Exitstatus und kalte/warme `real`-Zeit samt Belegverzeichnis. Der warme Hash muss
dem kalten entsprechen. Für die spätere MM-1-Gegenmessung denselben Befehl auf dem
sauberen Kandidaten-Commit mit einem **weiteren neuen** Target-Verzeichnis verwenden;
dabei ersetzt dessen protokollierter Commit die Main-Prüfung am Anfang. Erst danach
werden Byte- und Bauzeitdifferenzen berechnet.

Weiter offen bleiben echter Recall und native Ausführung auf den übrigen
Release-Zielen. Die anfänglichen 11,18 s
Harness-Buildzeit und etwa 1,97 MB Harness-Binary beantworten die
Produktions-Build-/Größenfrage nicht.

Die Rohbelege liegen im Controller-Berichtsverzeichnis `/workspace/reports`:
`mm1-macos-verification.txt`, `mm1-macos-final-harness`,
`mm1-jpeg-decoder-diagnosis.txt`, `mm1-jpeg-vendor-review.txt`,
`mm1-prepare-report.txt`, `mm1-prepare-review.txt`, `mm1-runtime-report.txt`,
`mm1-runtime-review.txt`, `mm1-image-license-closure.log`,
`mm1-jpeg-vendor-audit-deps.json`, `mm1-release-audit-policy.log`,
`mm1-vendor-native-preservation.log` und
`mm1-engine-media-bounded-debug-final.log`, `mm1-engine-all-unit-final.log`,
`mm1-engine-transport-final.log`, `mm1-engine-final-clippy.log` und
`mm1-docs-final.log`. Die offenen Prüfungen sind vom
Controller vor einer vollständigen Abnahme nachzutragen.
