# Abdeckung der Nutzer-Doku (docs/user)

Stand: 22.10.2026, GP5 U2 nach normalem Merge von `origin/main` `52ef14c2e1574914903e4322b65fc7031bf8b5bc`. U1 aus [#693](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/693), letzter Head `6a6031dd80e29fc998a8d62976c6b4b542149558`, ist dort integriert. [#657](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/657) ist integriert. [#661](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/661), Head `819085993a1b06c13bd9c5d37e68fca79535c7bc`, ist bei der Prüfung noch offen; seine zusätzlichen Befehlsseiten zählen hier nicht als integriert.

## Methode und Grenzen

- **Web:** manuelle Zuordnung aus `packages/web/src/nav.ts`, `router.ts`, `settings-sections.ts` und `pages/registry.ts` zu den tatsächlich vorhandenen Seiten in `docs/user/de/` und `docs/user/en/`. Die Einheit ist ein **Thema**, keine einzelne Route: Skills/Plugins und Anmeldung/Konto sind jeweils zusammengefasst; Bibliothek und Erzeugungsdialoge getrennt. Unterrouten wie Chatdetails und Kapitel der Hilfe sind Bestandteil ihres Themas. `/identities` zieht laut Router nach `/settings/users?tab=identities` um und wird dort gezählt. Die Entwicklungsgalerie zählt nicht.
- **Web-Urteil:** *ja* = Seite oder Abschnitt erklärt die Hauptabläufe; *teilw.* = nur Teilabläufe, ein CLI-Gegenstück oder veraltete Aussagen; *fehlt* = kein einschlägiger Abschnitt. Das ist **Dokumentationsabdeckung, keine Funktionsabnahme**. Die Bibliotheksseite beschreibt ausdrücklich, dass die Web-API in dieser Basis schon `media.output.list` ablehnt. Ihre dokumentierten Bedienelemente sind damit nicht als funktionierender Produktweg bestätigt.
- **CLI:** Blattbefehle aus der vorhandenen generierten Referenz [cli.md](../cli.md), abgeglichen mit `crates/plur1bus/src/cli.rs`. Ein Blatt hat keinen Unterbefehl. Root-Flags wie `--version`, Platzhalter wie `<command> --help` und reine Gruppen zählen nicht. Die Referenz hat jetzt **217** Blätter: gegenüber der alten 214er-Aufstellung zusätzlich `audit reanchor`, `session model get` und `session model set`.
- **CLI-Abdeckung:** mindestens ein gültiges wörtliches Beispiel je Sprache, erkannt durch `extractCommands`, `parseCliMd` und `checkCommand` aus dem Befehlschecker. Wiederholungen zählen einmal. Ein Beispiel allein belegt keine vollständige Erklärung seiner Optionen oder Wirkung. Die vollständigen Listen der abgedeckten und fehlenden Befehle liefert das Berichtsskript unten.
- **Parserstand:** Zum Zählen wird der tatsächlich korrigierte Checker aus #661 benutzt, ohne ihn oder dessen Produktseiten in diesen Zweig zu übernehmen. Er erkennt globale Flags vor und zwischen Unterbefehlen. So zählen `plur1bus --json container status`, `up` und `down` korrekt. Der Checker in dieser Basis erkennt diese Platzierung noch nicht; das Berichtsskript bricht bei nicht aufgelösten Beispielen mit Status 1 ab, statt unbemerkt zu niedrig zu zählen.
- Beide Sprachen wurden getrennt gelesen und gezählt. Ihre CLI-Mengen stimmen überein; auch die Web-Urteile sind je Thema gleich.

## Kennzahlen

| Kennzahl | U2-Basis mit U1 |
|---|---|
| Web-Themen | 38 |
| Web-Doku: ja | 29 |
| Web-Doku: teilweise | 9 |
| Web-Doku: fehlt | 0 |
| CLI-Blattbefehle | 217 |
| Je Sprache wörtlich abgedeckt | 131 (60,4 %) |
| Je Sprache ohne wörtliches Beispiel | 86 |
| Nutzerseiten | 40 de / 40 en |

Die alte Bestandsaufnahme nannte 36 Web-Funktionen, enthielt aber 37 Zeilen (24 ja, 7 teilweise, 6 fehlend). Hier kommt der bisher ausgelassene Bereich `/settings/media` hinzu. Die sechs U1-Themen schließen die fehlenden Seiten; die Erzeugungsdialoge sind nun ebenfalls beschrieben. Anbieter-Anmeldung und Erweiterungs-Einstellungen werden nach erneuter Quellprüfung nur teilweise gewertet. So sind die aktuellen Summen direkt aus der folgenden Tabelle nachvollziehbar.

Seit der ursprünglichen U2-Zählung ist `budget set` in beiden Budget-Seiten hinzugekommen. Daher steigt die CLI-Abdeckung von 130 auf 131, ohne den Nenner oder die Web-Themen zu ändern.

## Web-Funktionen

| Funktion | Web-Route | CLI | de-Seite | en-Seite | Web |
|---|---|---|---|---|---|
| Chat: starten, schreiben, Verlauf, zu Projekt befördern | `/chat` | `chat`, `session list`, `session show`, `session archive` | [chat.md](../user/de/chat.md) | [chat.md](../user/en/chat.md) | ja |
| Agenten: Liste, Anlegen, Pausieren, Archivieren, Export, Löschen, Rechte | `/agents` | `agent …` | [agenten.md](../user/de/agenten.md), [agent-provisioning.md](../user/de/agent-provisioning.md) | [agents.md](../user/en/agents.md), [agent-provisioning.md](../user/en/agent-provisioning.md) | ja |
| Erinnerungen: Zustand, Suche, Karten, Prüfungen | `/memories` | `memory …` | [erinnerungen.md](../user/de/erinnerungen.md) | [memories.md](../user/en/memories.md) | ja |
| Träume: Phasen, Zeitplan, Lauf-Protokoll | `/memories/dreams` | `dreams …` | [traeume.md](../user/de/traeume.md) | [dreams.md](../user/en/dreams.md) | ja |
| Medienindex-Tab | `/memories/media` | `media index …` | [mediensuche.md](../user/de/mediensuche.md), [erinnerungen.md](../user/de/erinnerungen.md) | [media-search.md](../user/en/media-search.md), [memories.md](../user/en/memories.md) | ja |
| Mediensuche | `/media` | `media search` | [mediensuche.md](../user/de/mediensuche.md) | [media-search.md](../user/en/media-search.md) | ja |
| Bibliothek (Galerie, Vorschau, Löschen, Beschriftung) | `/library` | – | [bibliothek.md](../user/de/bibliothek.md) | [library.md](../user/en/library.md) | ja |
| Bilder erzeugen | `/library` (Dialoge) | `media generate`, `media edit` | [bibliothek.md](../user/de/bibliothek.md), [media.md](../user/de/media.md) | [library.md](../user/en/library.md), [media.md](../user/en/media.md) | ja |
| Projekte und Board | `/projects` | `project …` | [projekte.md](../user/de/projekte.md) | [projects.md](../user/en/projects.md) | ja |
| Posteingang | `/inbox` | `inbox …` | [posteingang.md](../user/de/posteingang.md) | [inbox.md](../user/en/inbox.md) | ja |
| Skills und Plugins | `/skills`, `/plugins` | `skill …`, `plugin …`, `ext …` | [extensions.md](../user/de/extensions.md) | [extensions.md](../user/en/extensions.md) | ja |
| Modelle (Katalog, Scan, Überschreibung) | `/models` | `model …` | [providers.md](../user/de/providers.md) (nur Profile) | [providers.md](../user/en/providers.md) (nur Profile) | teilw. |
| Switchboard (Kanäle) | `/switchboard` | `channel …` | [channels.md](../user/de/channels.md) | [channels.md](../user/en/channels.md) | ja |
| Wiederkehrende Aufgaben | `/recurring` | `jobs …` | [wiederkehrende-aufgaben.md](../user/de/wiederkehrende-aufgaben.md) | [recurring-tasks.md](../user/en/recurring-tasks.md) | ja |
| Freigaben und Grants | `/approvals` | `approval …`, `grant …` | [freigaben.md](../user/de/freigaben.md) | [approvals.md](../user/en/approvals.md) | ja |
| Break-glass | `/breakglass` | `breakglass …` | [breakglass.md](../user/de/breakglass.md) | [breakglass.md](../user/en/breakglass.md) | ja |
| Nutzung und Limits | `/usage` | `budget …` | [budgets.md](../user/de/budgets.md) | [budgets.md](../user/en/budgets.md) | ja |
| Status (Doctor) | `/doctor` | `1staid check`, `daemon status` | [diagnose.md](../user/de/diagnose.md), [operations.md](../user/de/operations.md) | [diagnostics.md](../user/en/diagnostics.md), [operations.md](../user/en/operations.md) | ja |
| Protokolle: Logs, Aktivität, Sitzungen, Audit-Prüfung | `/logs` | `logs query`, `logs tail`, `audit verify` | [diagnose.md](../user/de/diagnose.md) | [diagnostics.md](../user/en/diagnostics.md) | ja |
| Einstellungen: Allgemein | `/settings/general` | `config get`, `config set` | [einstellungen-allgemein.md](../user/de/einstellungen-allgemein.md) | [general-settings.md](../user/en/general-settings.md) | ja |
| Einstellungen: Modelle | `/settings/models` | `config …`, `model …` | [providers.md](../user/de/providers.md), [chat-modelle.md](../user/de/chat-modelle.md) | [providers.md](../user/en/providers.md), [chat-models.md](../user/en/chat-models.md) | teilw. |
| Einstellungen: Memory (Embeddings, Medienindex) | `/settings/memory` | `memory reembed` | [reembed.md](../user/de/reembed.md), [cloud-embeddings.md](../user/de/cloud-embeddings.md), [mediensuche.md](../user/de/mediensuche.md) | [reembed.md](../user/en/reembed.md), [cloud-embeddings.md](../user/en/cloud-embeddings.md), [media-search.md](../user/en/media-search.md) | ja |
| Einstellungen: Erweiterungen | `/settings/extensions` | `ext …` | [extensions.md](../user/de/extensions.md) | [extensions.md](../user/en/extensions.md) | teilw. (Manager beschrieben, Konfigurationsformular fehlt) |
| Einstellungen: Netzwerk (Egress) | `/settings/network` | – | [einstellungen-netzwerk.md](../user/de/einstellungen-netzwerk.md) | [network-settings.md](../user/en/network-settings.md) | ja |
| Einstellungen: Medien-Metadaten | `/settings/media` | `media metadata` | [media.md](../user/de/media.md), [bibliothek.md](../user/de/bibliothek.md) (CLI bzw. globaler Bibliotheks-Schalter) | [media.md](../user/en/media.md), [library.md](../user/en/library.md) (CLI bzw. globaler Bibliotheks-Schalter) | teilw. (eigenes Formular und Agentenwahl fehlen) |
| Einstellungen: Sicherheit und Berechtigungen | `/settings/security` | – | [passkeys.md](../user/de/passkeys.md) (Konto, Passkeys, TOTP) | [passkeys.md](../user/en/passkeys.md) (account, passkeys, TOTP) | teilw. |
| Einstellungen: Datenschutz („Nur lokal“) | `/settings/privacy` | `config set` | [datenschutz.md](../user/de/datenschutz.md) | [privacy.md](../user/en/privacy.md) | ja |
| Einstellungen: Benutzer und Rollen, Identitäten | `/settings/users` | `user …`, `identity …` | [benutzer-rollen.md](../user/de/benutzer-rollen.md), [einladungen.md](../user/de/einladungen.md) | [users-and-roles.md](../user/en/users-and-roles.md), [invitations.md](../user/en/invitations.md) | ja |
| Einstellungen: Anbieter-Anmeldung | `/settings/providers` | `login …` | [providers.md](../user/de/providers.md) | [providers.md](../user/en/providers.md) | teilw. (CLI beschrieben; Web-Anmeldung fälschlich als nicht verfügbar bezeichnet) |
| Einstellungen: Geheimnisse | `/settings/secrets` | `secret …` | [secrets.md](../user/de/secrets.md) | [secrets.md](../user/en/secrets.md) | ja |
| Einstellungen: Sprache | `/settings/voice` | `voice …` | [sprachfunktionen.md](../user/de/sprachfunktionen.md) | [voice.md](../user/en/voice.md) | ja |
| Einstellungen: Geräte und Fernzugriff | `/settings/devices` | `device …`, `pairing qr` | [remote-access.md](../user/de/remote-access.md) | [remote-access.md](../user/en/remote-access.md) | ja |
| Einstellungen: Module und Updates | `/settings/modules` | `module …`, `update …` | [extensions.md](../user/de/extensions.md), [operations.md](../user/de/operations.md) | [extensions.md](../user/en/extensions.md), [operations.md](../user/en/operations.md) | teilw. |
| Erster Start (Wizard) | `/setup` | `setup` | [quickstart.md](../user/de/quickstart.md), [passkeys.md](../user/de/passkeys.md), [mediensuche.md](../user/de/mediensuche.md) | [quickstart.md](../user/en/quickstart.md), [passkeys.md](../user/en/passkeys.md), [media-search.md](../user/en/media-search.md) | teilw. |
| Anmeldung und Konto | `/login`, `/join` | `login …` | [passkeys.md](../user/de/passkeys.md), [einladungen.md](../user/de/einladungen.md) | [passkeys.md](../user/en/passkeys.md), [invitations.md](../user/en/invitations.md) | teilw. |
| Start (Home) | `/home` | – | [start.md](../user/de/start.md) | [home.md](../user/en/home.md) | ja |
| Hilfe (gebündelte Doku) | `/help` | – | [hilfe.md](../user/de/hilfe.md) | [help.md](../user/en/help.md) | ja |
| Befehlspalette (Strg+K) | Overlay | – | [befehlspalette.md](../user/de/befehlspalette.md) | [command-palette.md](../user/en/command-palette.md) | ja |

## CLI-Befehlsgruppen

Die Spalten de und en zählen nur die vorhandenen 40 Seiten je Sprache auf dieser U2-Basis. Noch offene PRs erhöhen diese Zahlen nicht.

| Gruppe | Blätter | de | en | Ohne wörtliches Beispiel |
|---|---|---|---|---|
| `setup`, `install`, `uninstall`, `update`, `import`, `completions` | 6 | 6 | 6 | – |
| `container` | 4 | 4 | 4 | –; `up`, `down`, `status` stehen mit vorangestelltem `--json` in [container.md](../user/de/container.md) und [containers.md](../user/en/containers.md) |
| `1staid`, `daemon`, `service`, `backup`, `login`, `secret`, `chat`, `skill`, `plugin` | 36 | 36 | 36 | – |
| `session` | 5 | 3 | 3 | `model get`, `model set` |
| `agent` | 14 | 14 | 14 | – |
| `memory` | 13 | 13 | 13 | – |
| `dreams` | 8 | 8 | 8 | – |
| `user` | 12 | 11 | 11 | `pair claim` (Kanal-Adapter) |
| `logs`, `audit` | 4 | 3 | 3 | `audit reanchor` |
| `channel` | 8 | 7 | 7 | `disable` |
| `identity` | 6 | 4 | 4 | `unlink`, `whoami` |
| `media` | 15 | 9 | 9 | `search`, `index pause`, `index reindex`, `index resume`, `index status`, `caption set` |
| `approval`, `grant` | 11 | 6 | 6 | `approval show`, `approval verify`, `approval audit`, `grant show`, `grant add` |
| `config`, `module`, `model`, `ext` | 16 | 6 | 6 | `config schema`; `module graph`, `install`, `uninstall`, `start`, `stop`; `model scan`, `override`; `ext pack`, `verify` |
| `project` | 21 | 0 | 0 | alle 21; zusätzliche Anleitung in #661 noch offen |
| `voice` | 11 | 0 | 0 | alle 11; zusätzliche Anleitung in #661 noch offen |
| `admin` | 6 | 0 | 0 | alle 6 |
| `inbox` | 4 | 0 | 0 | alle 4 |
| `device`, `breakglass` | 8 | 0 | 0 | alle 8 |
| `jobs`, `budget`, `trace`, `pairing`, `acp`, `core` | 9 | 1 | 1 | acht; `budget set` ist in beiden Budget-Seiten dokumentiert |
| Summe | 217 | 131 | 131 | 86 |

### Noch offene Ergänzungen aus #661

Die Dokumente am geprüften PR-Head enthalten alle 21 `project`- und alle 11 `voice`-Blätter, gemessen mit demselben korrigierten Parser gegen die aktuelle CLI-Referenz. Die Befehlsmengen sind in beiden Sprachen identisch. Es fehlen dort weiterhin 55 der 217 aktuellen CLI-Blätter; #661 behauptet also keine vollständige Abdeckung. Seine zwei zusätzlichen Seiten je Sprache würden zusammen mit U1 **42 Seiten je Sprache** ergeben. Die Vereinigung mit dem heutigen U2-Stand einschließlich `budget set` ergäbe nach einer Integration **163/217 CLI-Blätter (75,1 %)** je Sprache; 54 fehlten noch. Bis dahin bleiben **131/217** die Zahl dieses Zweigs. Die 36 Seiten je Sprache im isolierten #661-Snapshot enthalten die sechs U1-Seiten noch nicht; das verändert die CLI-Menge nicht, weil U1 keine CLI-Beispiele hinzufügt.

## Restlücken nach Wichtigkeit

1. **Konto, Einrichtung und Sicherheitsübersicht:** Der Wizard ist nur in Teilen beschrieben (CLI-Einrichtung, Konto und Memory-Schritt); die durchgehende Web-Schrittfolge fehlt. Anmeldung und Beitritt sind beschrieben, aber kein vollständiger Ablauf für alle Anmeldevarianten. Bei Sicherheit fehlen die Übersicht der Richtlinien und die angezeigten Limits; die Passkey-Seite deckt bereits Konto, Passkeys und TOTP ab.
2. **Modelle und Anbieter:** Für `/models` fehlen Katalogfilter, Scan und Überschreibungen. Für `/settings/models` fehlen Rollenfelder, Modelltest und das konkrete Konfigurationsformular. `providers.md` behauptet noch, es gebe keine Web-Anmeldung, während `pages/settings/sections/providers.ts` bereits Anmelde-, Callback-, API-Key- und Abmeldeabläufe enthält. Das ist eine Korrekturlücke und bleibt teilweise abgedeckt.
3. **Betrieb über Web und CLI:** Für `/settings/modules` fehlen Modulgraph, Bestätigungen und Rollen bei Installation/Deinstallation; die Betriebsseite erklärt überwiegend CLI-Updates. Bei `/settings/extensions` fehlen die Felder für unsignierte Pakete, Papierkorbfrist und Größenlimits, obwohl der Erweiterungsmanager selbst beschrieben ist. Bei `/settings/media` fehlen der eigene Metadaten-Schalter und die Agentenwahl; die Bibliotheksseite beschreibt nur ihren globalen Schalter. `audit reanchor` und `session model get/set` haben ebenfalls noch keine wörtlichen Nutzerbeispiele; Audit-Inhalte bleiben dem GP5-Audit-Dokupaket vorbehalten.
4. **Noch unintegrierte CLI-Anleitungen:** `project` (21) und `voice` (11) sind auf dieser Basis die größten Zahlenlücken, werden aber bereits von #661 bearbeitet. Nicht doppelt schreiben; nach Controller-Integration erneut zählen.
5. **Weitere CLI-Lücken:** `inbox` (4), `device`/`breakglass` (8), `jobs`/`budget` (3), `media` (6), `approval`/`grant` (5), `config`/`module`/`model`/`ext` (10), dazu `channel disable` und zwei `identity`-Blätter. `admin` (6), `trace` (2), `pairing qr`, `acp serve`, `core run` und `user pair claim` folgen nach den üblichen Nutzerwegen; interne und Adapter-Befehle bleiben im Nenner sichtbar.

Die Web-Anbindung der Bibliothek ist ein **separater Produktbefund**, keine fehlende Hilfeseite: `packages/api/src/rpc-route.ts` lässt den von `pages/library/page.ts` angeforderten Listenaufruf nicht durch. Auch die Metadaten-Seite verwendet einen dort noch nicht freigegebenen Medienaufruf. Die Inventarzahlen bestätigen weder diese Abläufe noch Anbieter- oder Modellqualität.

## Reproduzieren

Mit Node 24.21 aus dem Repository-Root. Das Berichtsskript verändert weder Dateien noch Git-Zweige. Der alternative Parser wird nur als Modul in einem temporären Verzeichnis gelesen; nach dem Merge von #661 genügt der normale Aufruf ohne `--checker`.

```sh
git fetch origin fix/users-preset-texts
gp5_u2_tmp=$(mktemp -d)
git show 819085993a1b06c13bd9c5d37e68fca79535c7bc:scripts/check-docs-commands.mjs > "$gp5_u2_tmp/checker.mjs"
node scripts/user-docs-coverage.mjs --checker "$gp5_u2_tmp/checker.mjs"
node scripts/user-docs-coverage.mjs --checker "$gp5_u2_tmp/checker.mjs" --docs-ref 819085993a1b06c13bd9c5d37e68fca79535c7bc
rm "$gp5_u2_tmp/checker.mjs"
rmdir "$gp5_u2_tmp"
```

Der erste Bericht zählt die aktuelle Nutzer-Doku, der zweite nur die Dateien des geprüften #661-Commits. Beide benutzen die aktuelle `docs/cli.md` und liefern Gruppen, Seitenzahlen, Befehlsmengen je Sprache und Probleme als JSON. Gültige Beispiele sind Voraussetzung für das Zählen; Fehler führen zu Status 1. Der Bericht ist kein Ersatz für `check-docs-commands` und führt keinen der zitierten Produktbefehle aus.

Web-Urteile werden durch Lesen geprüft. Ihre Summe lässt sich aus der Tabelle mit diesem Befehl nachzählen:

```sh
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
const table = readFileSync("docs/reference/user-docs-coverage.md", "utf8")
  .split("## Web-Funktionen")[1].split("## CLI-Befehlsgruppen")[0];
const rows = table.split("\n").filter(line => line.startsWith("| ") && !line.startsWith("| Funktion"));
const counts = { ja: 0, "teilw.": 0, fehlt: 0 };
for (const row of rows) counts[row.split("|").at(-2).trim().split(" ")[0]]++;
console.log({ themen: rows.length, ...counts });
JS
```

## Prüfstand und Hinweise

- Berichtsskript und Tests prüfen Blatt-Erkennung, Deduplizierung, Sprachtrennung, ungültige Beispiele und das Verhalten bei einem alten beziehungsweise korrigierten Parser. Die wirklichen Container-Beispiele wurden zusätzlich mit dem unveränderten #661-Parser gezählt.
- Dokumentations-Links, Befehlschecker und Hygiene werden separat geprüft. Es wird kein Rust-Build, keine Live-Engine und kein vollständiges Produkt-E2E als Abnahme dieser Inventur behauptet.
- Die falschen Rollenvorlagen-Texte und der veraltete Hinweis zur Rollenänderung auf dieser Basis werden ebenfalls in #661 korrigiert. Nutzerseiten folgen der [RBAC-Tabelle](../rbac.md), nicht diesen Vorschautexten.
- Nutzerseiten und Hilfebundle bleiben in U2 unverändert. Eine spätere Produkt-Dokukorrektur muss `packages/web/scripts/bundle-user-docs.ts` erneut ausführen; dieses Inventar gehört selbst nicht zum Hilfebundle.
