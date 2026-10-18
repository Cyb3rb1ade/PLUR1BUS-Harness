# Secrets verwalten

Plur1bus speichert sensible API-Schlüssel und Tokens in einem separaten Secret Store. Secrets sind von der Hauptkonfiguration getrennt, werden in allen Protokollen maskiert und sind für Agenten nur namentlich sichtbar. Die englische Version dieser Seite ist [../en/secrets.md](../en/secrets.md).

## So geht's

### Web-UI

1. Öffne die **Einstellungen → Secrets** (`#/settings/secrets`).
2. **Secret anlegen:** Klicke auf **Neues Secret**. Gib einen eindeutigen Namen ein (z. B. `openai/api-key`), trage eine optionale Beschreibung des Einsatzzwecks ein und füge den Wert in das maskierte Kennwortfeld ein. Der Wert wird nach dem Absenden sofort aus dem Speicher gelöscht.
3. **Secret rotieren:** Klicke neben einem bestehenden Secret auf **Rotieren**, gib den neuen Wert ein und bestätige.
4. **Secret löschen:** Klicke auf **Löschen**. Um Fehler zu vermeiden, musst du den genauen Secret-Namen abtippen.

### CLI

Prüfen, welcher Speicher (Schlüsselbund des Betriebssystems oder verschlüsselte Datei) aktiv ist:

```sh
plur1bus secret status
```

Alle Secret-Namen auflisten (gibt niemals Werte aus):

```sh
plur1bus secret ls
```

Secret anlegen oder rotieren, indem der Wert über die Standardeingabe übergeben wird:

```sh
printf %s "$API_KEY" | plur1bus secret set <NAME>
```

Metadaten (Zeitstempel und Beschreibung) abfragen:

```sh
plur1bus secret get <NAME>
```

Secret aus allen Speichern entfernen:

```sh
plur1bus secret rm <NAME>
```

## Gut zu wissen

- **Niemals in Befehlszeilen-Argumenten:** Ein Secret-Wert wird niemals als Befehlszeilenargument akzeptiert. Wird ein Wert als Argument übergeben, bricht Plur1bus sofort mit `value-in-argument` ab, ohne den Wert im Protokoll zu wiederholen. Übergebe Werte immer über die Standardeingabe oder die Web-UI.
- **Was Agenten sehen (`secret_names`):** Agenten dürfen nur die Liste der Namen (`secret_names`) der ihnen zugewiesenen Secrets abfragen. Sie können die eigentlichen Werte weder abrufen noch einsehen oder loggen. Sie übergeben lediglich Referenzen (`apiKeyRef`).
- **Automatische Maskierung überall:** Secret-Werte werden in allen Ausgaben unkenntlich gemacht: in Core-Logs (`core.log`), Audit-Logs, Diagnose-Bundles (`1staid.bundle`), Log-Abfragen (`logs.query`) und Doctor-Berichten.
- **Speicher-Backends:** Plur1bus nutzt standardmäßig den Schlüsselbund des Betriebssystems (macOS Keychain, Linux Secret Service, Windows Credential Manager). Ist kein Dienst erreichbar, wird eine verschlüsselte Datei verwendet.

## Fehlermeldungen

- `E_SECRET_NOT_FOUND`: Das angeforderte Secret existiert nicht. Prüfe vorhandene Namen mit `plur1bus secret ls`.
- `E_VALUE_IN_ARGUMENT`: Ein Secret-Wert wurde als Befehlszeilen-Argument übergeben. Verwende stattdessen: `printf %s "$WERT" | plur1bus secret set <NAME>`.
- `E_SECRET_DENIED`: Die aktuelle Rolle oder der Agent hat keine Berechtigung, auf dieses Secret zuzugreifen.

## Weiter

- Secrets für Anbieter nutzen: [providers.md](providers.md)
- Cloud-Embeddings absichern: [cloud-embeddings.md](cloud-embeddings.md)
- Betrieb und Diagnose-Logs: [Betriebshandbuch](operations.md)
