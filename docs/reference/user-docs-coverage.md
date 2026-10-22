# Abdeckung der Nutzer-Doku (docs/user)

Stand: 20.10.2026, Basis `origin/main` 31f8dd62c plus der Zweig `fix/user-docs-coverage`. Die Tabelle zeigt, welche Funktionen der Weboberfläche und der Kommandozeile eine Seite oder einen Abschnitt in `docs/user/de/` und `docs/user/en/` haben. Sie ist die Arbeitsgrundlage für die nächsten Doku-Runden.

Nachtrag U1 (21.10.2026, Basis `origin/main` `1dae60f2ae`): Die sechs neuen Themen sind unten verlinkt. Kennzahlen, Web-Urteile, CLI-Zählung und Rangfolge bleiben die historische Bestandsaufnahme vom 20.10.; ihre Neuberechnung ist U2. Die Bibliotheksseite nennt ausdrücklich die noch unvollständige Web-Anbindung. #657 ist integriert; die project-/voice-Ergänzungen und der Befehlschecker aus #661 sind auf dieser Basis noch offen.

## Methode

- **Web:** Routen aus `packages/web/src/nav.ts` (Seitenleiste und versteckte Routen), `settings-sections.ts` (Einstellungsbereiche), `pages/registry.ts` und `docs/web-ui.md`. Eine Zeile ist eine Route oder ein Einstellungsbereich.
- **CLI:** der Befehlsbaum aus `docs/cli.md`, das aus dem clap-Baum in `crates/plur1bus/src/cli*.rs` erzeugt wird. Eine Referenzdatei `docs/reference/cli.md` gibt es nicht; die Referenz ist `docs/cli.md`. Gezählt werden Blattbefehle (Befehle ohne Unterbefehle): 214.
- **CLI-Abdeckung** heißt: Der Befehl steht wörtlich als `plur1bus …` in mindestens einer Seite je Sprache. Die Zahl kommt aus den Parsern von `scripts/check-docs-commands.mjs`, also aus derselben Quelle, die `docs:check` prüft. Ein zitierter Befehl sagt nicht, dass alles Drumherum erklärt ist; die Spalten für Web zeigen deshalb das Urteil aus dem Lesen der Seiten.
- **Web-Urteil:** *ja* = eigene Seite oder eigener Abschnitt, der die Hauptabläufe der Route beschreibt. *teilw.* = nur am Rand oder nur ein Teil erwähnt. *fehlt* = keine Seite, kein Abschnitt.
- Die deutschen und englischen Seiten sind je Funktion gleich weit; es gibt keine Funktion, die nur in einer Sprache beschrieben ist.

## Kennzahlen

| | vorher | nachher |
|---|---|---|
| Web-Funktionen (36): ja | 17 | 24 |
| Web-Funktionen: teilw. | 9 | 6 |
| Web-Funktionen: fehlt | 10 | 6 |
| CLI-Blattbefehle (214), je Sprache zitiert | 85 | 127 |
| Nutzer-Seiten je Sprache | 28 (de) / 28 (en) | 34 (de) / 34 (en) |

Neu in dieser Runde sind sechs Seiten, je in de und en: Chat, Agenten, Erinnerungen, Träume, Benutzer und Rollen, Status und Protokolle (in der Tabelle mit *neu* markiert).

## Web-Funktionen

| Funktion | Web-Route | CLI | de-Seite | en-Seite | Web |
|---|---|---|---|---|---|
| Chat: starten, schreiben, Verlauf, zu Projekt befördern | `/chat` | `chat`, `session list`, `session show`, `session archive` | [chat.md](../user/de/chat.md) *neu* | [chat.md](../user/en/chat.md) *neu* | ja (vorher teilw.) |
| Agenten: Liste, Anlegen, Pausieren, Archivieren, Export, Löschen, Rechte | `/agents` | `agent …` | [agenten.md](../user/de/agenten.md) *neu*, [agent-provisioning.md](../user/de/agent-provisioning.md) | [agents.md](../user/en/agents.md) *neu*, [agent-provisioning.md](../user/en/agent-provisioning.md) | ja (vorher teilw.) |
| Erinnerungen: Zustand, Suche, Karten, Prüfungen | `/memories` | `memory …` | [erinnerungen.md](../user/de/erinnerungen.md) *neu* | [memories.md](../user/en/memories.md) *neu* | ja (vorher fehlt) |
| Träume: Phasen, Zeitplan, Lauf-Protokoll | `/memories/dreams` | `dreams …` | [traeume.md](../user/de/traeume.md) *neu* | [dreams.md](../user/en/dreams.md) *neu* | ja (vorher fehlt) |
| Medienindex-Tab | `/memories/media` | `media index …` | [mediensuche.md](../user/de/mediensuche.md), [erinnerungen.md](../user/de/erinnerungen.md) *neu* | [media-search.md](../user/en/media-search.md), [memories.md](../user/en/memories.md) *neu* | ja |
| Mediensuche | `/media` | `media search` | [mediensuche.md](../user/de/mediensuche.md) | [media-search.md](../user/en/media-search.md) | ja |
| Bibliothek (Galerie, Vorschau, Löschen, Beschriftung) | `/library` | – | [bibliothek.md](../user/de/bibliothek.md) (U1) | [library.md](../user/en/library.md) (U1) | fehlt |
| Bilder erzeugen | `/library` (Dialoge) | `media generate`, `media edit` | [media.md](../user/de/media.md) | [media.md](../user/en/media.md) | teilw. (nur CLI beschrieben) |
| Projekte und Board | `/projects` | `project …` | [projekte.md](../user/de/projekte.md) | [projects.md](../user/en/projects.md) | ja |
| Posteingang | `/inbox` | `inbox …` | [posteingang.md](../user/de/posteingang.md) | [inbox.md](../user/en/inbox.md) | ja |
| Skills und Plugins | `/skills`, `/plugins` | `skill …`, `plugin …`, `ext …` | [extensions.md](../user/de/extensions.md) | [extensions.md](../user/en/extensions.md) | ja |
| Modelle (Katalog, Scan, Überschreibung) | `/models` | `model …` | [providers.md](../user/de/providers.md) (nur Profile) | [providers.md](../user/en/providers.md) (nur Profile) | teilw. |
| Switchboard (Kanäle) | `/switchboard` | `channel …` | [channels.md](../user/de/channels.md) | [channels.md](../user/en/channels.md) | ja |
| Wiederkehrende Aufgaben | `/recurring` | `jobs …` | [wiederkehrende-aufgaben.md](../user/de/wiederkehrende-aufgaben.md) | [recurring-tasks.md](../user/en/recurring-tasks.md) | ja |
| Freigaben und Grants | `/approvals` | `approval …`, `grant …` | [freigaben.md](../user/de/freigaben.md) | [approvals.md](../user/en/approvals.md) | ja |
| Break-glass | `/breakglass` | `breakglass …` | [breakglass.md](../user/de/breakglass.md) | [breakglass.md](../user/en/breakglass.md) | ja |
| Nutzung und Limits | `/usage` | `budget …` | [budgets.md](../user/de/budgets.md) | [budgets.md](../user/en/budgets.md) | ja |
| Status (Doctor) | `/doctor` | `1staid check`, `daemon status` | [diagnose.md](../user/de/diagnose.md) *neu*, [operations.md](../user/de/operations.md) | [diagnostics.md](../user/en/diagnostics.md) *neu*, [operations.md](../user/en/operations.md) | ja (vorher fehlt) |
| Protokolle: Logs, Aktivität, Sitzungen, Audit-Prüfung | `/logs` | `logs query`, `logs tail`, `audit verify` | [diagnose.md](../user/de/diagnose.md) *neu* | [diagnostics.md](../user/en/diagnostics.md) *neu* | ja (vorher fehlt) |
| Einstellungen: Allgemein | `/settings/general` | `config get`, `config set` | [einstellungen-allgemein.md](../user/de/einstellungen-allgemein.md) (U1) | [general-settings.md](../user/en/general-settings.md) (U1) | fehlt |
| Einstellungen: Modelle | `/settings/models` | `config …`, `model …` | [providers.md](../user/de/providers.md), [chat-modelle.md](../user/de/chat-modelle.md) | [providers.md](../user/en/providers.md), [chat-models.md](../user/en/chat-models.md) | teilw. |
| Einstellungen: Memory (Embeddings, Medienindex) | `/settings/memory` | `memory reembed` | [reembed.md](../user/de/reembed.md), [cloud-embeddings.md](../user/de/cloud-embeddings.md), [mediensuche.md](../user/de/mediensuche.md) | [reembed.md](../user/en/reembed.md), [cloud-embeddings.md](../user/en/cloud-embeddings.md), [media-search.md](../user/en/media-search.md) | ja |
| Einstellungen: Erweiterungen | `/settings/extensions` | `ext …` | [extensions.md](../user/de/extensions.md) | [extensions.md](../user/en/extensions.md) | ja |
| Einstellungen: Netzwerk (Egress) | `/settings/network` | – | [einstellungen-netzwerk.md](../user/de/einstellungen-netzwerk.md) (U1) | [network-settings.md](../user/en/network-settings.md) (U1) | fehlt |
| Einstellungen: Sicherheit und Berechtigungen | `/settings/security` | – | [passkeys.md](../user/de/passkeys.md) (nur Passkeys) | [passkeys.md](../user/en/passkeys.md) (nur Passkeys) | teilw. |
| Einstellungen: Datenschutz („Nur lokal“) | `/settings/privacy` | `config set` | [datenschutz.md](../user/de/datenschutz.md) | [privacy.md](../user/en/privacy.md) | ja |
| Einstellungen: Benutzer und Rollen, Identitäten | `/settings/users` | `user …`, `identity …` | [benutzer-rollen.md](../user/de/benutzer-rollen.md) *neu*, [einladungen.md](../user/de/einladungen.md) | [users-and-roles.md](../user/en/users-and-roles.md) *neu*, [invitations.md](../user/en/invitations.md) | ja (vorher teilw.) |
| Einstellungen: Anbieter-Anmeldung | `/settings/providers` | `login …` | [providers.md](../user/de/providers.md) | [providers.md](../user/en/providers.md) | ja |
| Einstellungen: Geheimnisse | `/settings/secrets` | `secret …` | [secrets.md](../user/de/secrets.md) | [secrets.md](../user/en/secrets.md) | ja |
| Einstellungen: Sprache | `/settings/voice` | `voice …` | [sprachfunktionen.md](../user/de/sprachfunktionen.md) | [voice.md](../user/en/voice.md) | ja |
| Einstellungen: Geräte und Fernzugriff | `/settings/devices` | `device …`, `pairing qr` | [remote-access.md](../user/de/remote-access.md) | [remote-access.md](../user/en/remote-access.md) | ja |
| Einstellungen: Module und Updates | `/settings/modules` | `module …`, `update …` | [extensions.md](../user/de/extensions.md), [operations.md](../user/de/operations.md) | [extensions.md](../user/en/extensions.md), [operations.md](../user/en/operations.md) | teilw. |
| Erster Start (Wizard) | `/setup` | `setup` | [quickstart.md](../user/de/quickstart.md) (CLI) | [quickstart.md](../user/en/quickstart.md) (CLI) | teilw. |
| Anmeldung und Konto | `/login`, `/join` | `login …` | [passkeys.md](../user/de/passkeys.md), [einladungen.md](../user/de/einladungen.md) | [passkeys.md](../user/en/passkeys.md), [invitations.md](../user/en/invitations.md) | teilw. |
| Start (Home) | `/home` | – | [start.md](../user/de/start.md) (U1) | [home.md](../user/en/home.md) (U1) | fehlt |
| Hilfe (gebündelte Doku) | `/help` | – | [hilfe.md](../user/de/hilfe.md) (U1) | [help.md](../user/en/help.md) (U1) | fehlt |
| Befehlspalette (Strg+K) | Overlay | – | [befehlspalette.md](../user/de/befehlspalette.md) (U1) | [command-palette.md](../user/en/command-palette.md) (U1) | fehlt |

## CLI-Befehlsgruppen

Spalten: Blattbefehle in der Gruppe, davon je Sprache zitiert vorher und nachher. Die Zahlen für de und en sind in jeder Gruppe gleich, weil `check-docs-commands` es verlangt.

| Gruppe | Blätter | vorher | nachher | Bemerkung |
|---|---|---|---|---|
| `setup`, `install`, `uninstall`, `update`, `import`, `completions` | 6 | 6 | 6 | |
| `container` | 4 | 1 | 1 | `up`, `down` und `status` sind in [containers.md](../user/en/containers.md) beschrieben, aber mit `--json` vor dem Befehl zitiert; das Zählskript erkennt diese Form nicht, die echte Abdeckung ist also höher |
| `1staid`, `daemon`, `service`, `backup`, `login`, `secret`, `session`, `chat`, `skill`, `plugin` | 39 | 39 | 39 | |
| `agent` | 14 | 4 | 14 | neu: [agents.md](../user/en/agents.md) |
| `memory` | 13 | 3 | 13 | neu: [memories.md](../user/en/memories.md) |
| `dreams` | 8 | 0 | 8 | neu: [dreams.md](../user/en/dreams.md) |
| `user` | 12 | 0 | 11 | neu: [users-and-roles.md](../user/en/users-and-roles.md); `user pair claim` ist für Kanal-Adapter gedacht und wird nicht zitiert |
| `logs`, `audit` | 3 | 0 | 3 | neu: [diagnostics.md](../user/en/diagnostics.md) |
| `channel` | 8 | 7 | 7 | `channel disable` fehlt |
| `identity` | 6 | 4 | 4 | `identity unlink`, `identity whoami` fehlen |
| `media` | 15 | 9 | 9 | `media search`, `media index …`, `media caption set` fehlen |
| `approval`, `grant` | 11 | 6 | 6 | `approval show`, `approval verify`, `approval audit`, `grant show`, `grant add` fehlen |
| `config`, `module`, `model`, `ext` | 16 | 6 | 6 | `config schema`, `module graph|install|uninstall|start|stop`, `model scan|override`, `ext pack|verify` fehlen |
| `project` | 21 | 0 | 0 | größte Lücke; die Weboberfläche ist in [projects.md](../user/en/projects.md) beschrieben |
| `voice` | 11 | 0 | 0 | die Weboberfläche ist in [voice.md](../user/en/voice.md) beschrieben |
| `admin` | 6 | 0 | 0 | |
| `inbox` | 4 | 0 | 0 | |
| `device`, `breakglass` | 8 | 0 | 0 | |
| `jobs`, `budget`, `trace`, `pairing`, `acp`, `core` | 9 | 0 | 0 | |
| Summe | 214 | 85 | 127 | |

## Offene Lücken nach Wichtigkeit

1. `project …` (21 Befehle) und `voice …` (11): die Weboberfläche ist beschrieben, die Befehle nicht.
2. Weboberfläche ohne Seite: Bibliothek (`/library`), Einstellungen Allgemein und Netzwerk, Start (`/home`), Hilfe, Befehlspalette.
3. Teilweise abgedeckt: Modelle-Seite und Einstellungen Modelle, Sicherheit und Berechtigungen (nur Passkeys beschrieben), Module, Erster-Start-Wizard (nur das CLI-Gegenstück), Anmeldung.
4. Kleinere CLI-Gruppen: `inbox`, `device`, `breakglass`, `jobs`, `budget`, `media` (Suche, Index, Beschriftung), `approval`/`grant` (Rest), `admin`, `trace`.

## Hinweise

- Die Vorschau-Texte der Rollenvorlagen in der Weboberfläche (Einstellungen → Benutzer & Rollen) sagen, Operator und Viewer könnten Logs lesen. Der Tab Protokolle und die Audit-Prüfung sind aber Owner und Admin vorbehalten (`logs.query`, `audit.read` in [../rbac.md](../rbac.md)). [benutzer-rollen.md](../user/de/benutzer-rollen.md) und [diagnose.md](../user/de/diagnose.md) folgen der Rechtetabelle. Dasselbe Feld trägt den Hinweis, Rollen zuzuweisen sei noch nicht möglich, obwohl die Rollenänderung in der Personenliste angebunden ist.
- Die Seiten werden von `packages/web/scripts/bundle-user-docs.ts` in die Hilfe der Weboberfläche gebündelt. Jede neue Seite ändert deshalb auch `packages/web/src/pages/help/docs-bundle/`.
- Der Teil von `docs:check`, der Rust baut, wurde in dieser Runde nicht ausgeführt; die Skripte `check-docs-commands`, `check-doc-links` und `lint-hygiene` wurden einzeln ausgeführt.
