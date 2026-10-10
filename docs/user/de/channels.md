# Kanäle

Kanäle verbinden Chat-Plattformen mit Plur1bus. Du schreibst dem Assistenten in Telegram, Discord, Slack, Matrix, Signal
oder per E-Mail, und die Antwort kommt dort zurück. Diese Seite zeigt, wie du einen Kanal einrichtest, ein Konto mit dem
Assistenten verknüpfst und ihn verwaltest. Die Einrichtung jedes Kanals steht ausführlich auf seiner eigenen Seite unter
[../../channels/](../../channels/). Die englische Fassung dieser Seite ist [../en/channels.md](../en/channels.md).

## Vorab: läuft der Kanal in deinem Build?

Kanäle laufen nur, wenn der Switchboard-Host in deinem Build enthalten ist. Prüfe das zuerst:

```sh
plur1bus channel status
```

Der Befehl braucht einen laufenden Core (`plur1bus daemon start`). Zeigt die Liste für einen Kanal den Zustand
`not-registered` und darunter den Hinweis „no switchboard host“, startet dieser Build den Kanal nicht. Die Einrichtung
unten ist dann vorbereitet, wirkt aber erst mit einem Build, der den Host enthält. Fehlt dieser Hinweis, hat der Build
einen Host. `plur1bus channel show <kanal>` zeigt dann Zustand und letzten Fehler des Kanals.

## Die Kanäle im Überblick

| Kanal | Chats | Hinweis |
|---|---|---|
| Telegram | Direktnachrichten, Gruppen | ausgereift |
| Discord | Direktnachrichten, Serverkanal, Thread | neu |
| Slack | Direktnachrichten, Kanal, Gruppe | neu |
| Matrix | Direktnachrichten, Raum, Thread | neu; nur unverschlüsselte Räume |
| Signal | Direktnachrichten, Gruppe | neu; braucht signal-cli |
| E-Mail | Direkt, im Mail-Thread | neu |

WhatsApp ist noch nicht umgesetzt.

Alle Kanäle sind standardmäßig aus. Eine Erlaubnisliste (`allowlist`, `dmAllowlist`) lässt zunächst niemanden zu: Was dort
nicht steht, wird weder angenommen noch beantwortet. Zugangsdaten gibst du nie direkt an, sondern nur den Namen des
Geheimnisses.

## Einrichtung in fünf Schritten

Die Schritte gelten für alle Kanäle. Die Details zu Anbieter-Konsole, Berechtigungen und Ids stehen auf der Seite des
Kanals.

1. Lege beim Anbieter einen Bot oder ein Konto an und hole dir den Zugangsschlüssel.
2. Speichere den Schlüssel als Geheimnis. Der Befehl liest den Wert von der Standardeingabe:

   ```sh
   printf %s "$DISCORD_BOT_TOKEN" | plur1bus secret set channels.discord.token
   ```

3. Verweise in der Konfiguration auf den Namen. Die Schlüssel stehen in [../../config.md](../../config.md):

   ```sh
   plur1bus channel set discord tokenSecret channels.discord.token
   plur1bus channel set discord allowlist '["123456789012345678"]'
   ```

4. Schalte den Kanal ein. Das startet sein Modul neu:

   ```sh
   plur1bus channel enable discord
   ```

5. Prüfe die Verbindung:

   ```sh
   plur1bus channel test discord
   ```

### Je Kanal in Kürze

- **Telegram:** Lege den Bot bei BotFather an. Für Gruppen trägst du die Gruppen-ID auf die Erlaubnisliste ein. Liest der
  Bot alle Nachrichten einer Gruppe, schaltest du bei BotFather den Privacy Mode mit `/setprivacy` aus. Die Konfiguration
  steht auf [../../channels/telegram.md](../../channels/telegram.md); der Kanal ist in der Konfigurationsreferenz nicht
  eingetragen.
- **Discord:** Lege Anwendung und Bot im Developer Portal an. Aktiviere den privilegierten Intent MESSAGE_CONTENT dort
  ebenfalls. Lade den Bot auf deinen Server ein. Details: [../../channels/discord.md](../../channels/discord.md).
- **Slack:** Lege eine App an. Du brauchst einen Bot-Token (`xoxb-…`) und einen App-Token (`xapp-…`) mit dem Recht
  `connections:write` für Socket Mode. Lade den Bot in jeden Kanal ein, in dem er antworten soll. Details:
  [../../channels/slack.md](../../channels/slack.md).
- **Matrix:** Lege ein eigenes Bot-Konto an und hol dir das Zugriffstoken, ohne es in die Konfiguration zu schreiben.
  Verschlüsselte Räume werden noch nicht unterstützt. Details: [../../channels/matrix.md](../../channels/matrix.md).
- **Signal:** Installiere signal-cli, registriere oder verknüpfe das Konto und lass den signal-cli-Daemon laufen. Details:
  [../../channels/signal.md](../../channels/signal.md).
- **E-Mail:** Richte ein eigenes Postfach ein. Für die Absenderprüfung brauchst du die `authServId` deines
  Mailservers. Details: [../../channels/email.md](../../channels/email.md).

## Konten verknüpfen mit /link

Damit der Assistent weiß, wer du bist, verknüpfst du dein Konto auf dem Kanal mit deinem Benutzer:

1. Erzeuge auf deinem Rechner einen einmaligen Code:

   ```sh
   plur1bus identity link --channel <kanal>
   ```

2. Schick dem Bot im Direktchat `/link <code>`. Bei Slack heißt der Befehl `/plur1bus link <code>`; bei Discord ist es
   ein Slash-Befehl; bei Matrix, Signal und E-Mail schreibst du den Befehl als Text. Welche Form dein Kanal genau nutzt,
   zeigt `plur1bus channel link-help <kanal>`.
3. Die Verknüpfung wird erst aktiv, wenn du sie bestätigst. Bestätige sie mit `plur1bus identity approve <id>`, oder lehne
   sie mit `plur1bus identity decline <id>` ab. Mit `plur1bus identity links` siehst du deine bestehenden Verknüpfungen.

Der Code gilt nur kurz und ist nur einmal verwendbar. Hast du keinen Code mehr, erzeuge einen neuen.

## Kanäle verwalten

| Befehl | Was er tut |
|---|---|
| `plur1bus channel list` | Alle Kanäle mit Status, Konfiguration und Gesundheit. |
| `plur1bus channel show <kanal>` | Die wirksame Konfiguration; Geheimnisse erscheinen nur als Name. |
| `plur1bus channel enable <kanal>` und `disable <kanal>` | Schaltet den Kanal ein oder aus. |
| `plur1bus channel set <kanal> <schlüssel> <wert>` | Setzt einen Schlüssel, der vorher gegen das Schema geprüft wird. |
| `plur1bus channel test <kanal>` | Prüft die Gesundheit des Kanals. Mit `--send-owner` schickt er eine Testnachricht an deine eigene verknüpfte Identität. |
| `plur1bus channel status` | Alle Kanäle in einer kompakten Liste. |
| `plur1bus channel link-help <kanal>` | Erklärt die `/link`-Verknüpfung dieses Kanals. |

Ein Wert, der wie ein Zugangsschlüssel aussieht, wird für Schlüssel mit dem Suffix `Secret` abgelehnt. Er wird nicht
gespeichert und nicht ausgegeben. Speichere Schlüssel immer mit `plur1bus secret set <name>` und gib dann nur den Namen an.

## Wenn etwas nicht klappt

| Fehler | Bedeutung | Was tun |
|---|---|---|
| `E_CORE_UNAVAILABLE` | Der Core läuft nicht. | `plur1bus daemon start`. |
| `E_NOT_AVAILABLE`, `config-not-writable` | Kein Supervisor besitzt die Konfiguration. | `plur1bus daemon start`, dann den Befehl wiederholen. |
| `E_NOT_AVAILABLE`, `channel-not-running` | `channel test --send-owner` braucht einen laufenden Kanal. | Kanal mit `channel enable` einschalten und den Daemon neu starten. |
| `E_NOT_FOUND`, `owner-not-linked` | Dein Konto ist auf diesem Kanal nicht verknüpft. | Die Schritte unter „Konten verknüpfen“ ausführen. |
| `E_INVALID_PARAMS`, `secret-value` (Exit 2) | Du hast einen Zugangsschlüssel als Wert angegeben. | Schlüssel als Geheimnis speichern und erneuern, dann nur den Namen angeben. |
| `E_INVALID_PARAMS`, `invalid-value` | Der Wert passt nicht zum Schema. | Die Angabe `detail` im Fehler lesen; nichts wurde geschrieben. |
| Status `not-registered` | Der Build enthält keinen Switchboard-Host. | Siehe „Vorab“ oben. |

Die vollständige Liste steht in [../../errors.md](../../errors.md).
