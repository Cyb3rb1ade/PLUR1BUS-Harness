# Lange Gespräche (Kompaktierung)

Ein Modell kann nur einen begrenzten Text auf einmal verarbeiten, sein Kontextfenster. Eine lange Sitzung wächst darüber
hinaus. Die Harness verkleinert deshalb, was das Modell bei jeder Antwort sieht, ohne den Verlauf zu verlieren. Diese
Seite beschreibt, was dabei passiert, was ausgeblendet und was gelöscht wird, und welche Einstellungen es gibt. Jeder
Befehl hier existiert in diesem Build (`docs/cli.md` ist die vollständige Referenz). Die englische Fassung ist
[../en/long-conversations.md](../en/long-conversations.md).

## Ausblenden, nicht löschen

Das ist das Grundprinzip: Die Harness blendet Material im Kontext aus, das das Modell gerade nicht braucht. Gelöscht
wird nichts. Der vollständige Verlauf einer Sitzung bleibt in ihrem Speicher. Ausgeblendet ist nur, was das Modell beim
nächsten Schritt sieht. Verweist ein späterer Zug auf ein ausgeblendetes Ergebnis, kommt es wieder in den Kontext.

Dafür gibt es zwei Mechanismen.

## 1. Zusammenfassungen

Wächst eine Sitzung, bereitet die Harness nach einem Zug eine Zusammenfassung des älteren Teils vor, sobald er einen Anteil
des Kontextfensters erreicht (Standard 65 Prozent). Ist die Zusammenfassung bereit und wird der Kontext zu voll (Standard
88 Prozent), tauscht die Harness den älteren Teil gegen die Zusammenfassung aus.

Ein paar Regeln dabei:

- **Vor jedem Tausch sichert die Harness die Fakten des ausgetauschten Teils in das Gedächtnis.** Das geschieht über
  einen Checkpoint. Damit gehen Informationen aus dem alten Teil nicht verloren, auch wenn sie nicht mehr im Kontext
  stehen.
- **Inkognito-Sitzungen sind davon ausgenommen.** Wer mit `plur1bus chat --no-memory` schreibt, erzeugt keinen
  Gedächtnis-Checkpoint.
- Die Zusammenfassung hat eine feste Obergrenze (Standard: 15 Prozent des Fensters). Sind Zusammenfassungen selbst zu
  lang, werden sie in mehreren Stufen zu einer neuen verdichtet, wobei die vorige einfließt.
- Eine einzelne sehr große Nachricht, etwa eine lange Tool-Ausgabe, wird im Kontext gekürzt und mit einem Verweis
  versehen. Das Original bleibt im Verlauf.

Die Zusammenfassung schreibt ein eigenes Modell, die Rolle `summarize`. Ist es nicht verfügbar oder überschreitet der
Aufruf das Budget, nimmt die Harness stattdessen eine einfache, deterministische Zusammenfassung ohne Modell. Dieser
Weg braucht kein Modell.

## 2. Ausgeblendete Tool-Ausgaben

Nach jedem Zug prüft die Harness, ob alte Tool-Aufrufe und ihre Ergebnisse noch im Kontext gebraucht werden. Ist ein
Paar nicht mehr relevant, blendet die Harness es aus. Es bleibt im Verlauf erhalten.

- Die letzten drei Züge (Standard) werden nie ausgeblendet.
- Der Entscheider ist standardmäßig Laya, ein lokaler Prüfer auf dem Prozessor. Ist er nicht verfügbar oder dauert er zu
  lange, greift eine konservative Heuristik. Mit `off` schaltest du das Ausblenden ab.
- Die Entscheidung hat ein Zeitbudget (Standard 100 Millisekunden). Überschreitet sie es, bleibt der Kontext unverändert.
- Verweist ein neuer Zug auf ein ausgeblendetes Ergebnis, wird es wieder sichtbar.

## Sitzungen ansehen

Eine Sitzung zeigst du mit ihrer Kennung. Der Befehl gibt die letzten Nachrichten aus:

```sh
plur1bus session list
plur1bus session show <id>
```

Sitzung weiterführen:

```sh
plur1bus chat --session <id> "Wo waren wir stehen geblieben?"
```

Eine Sitzung archivierst du, ohne sie zu löschen:

```sh
plur1bus session archive <id>
```

Eine Ansicht, die dir zeigt, welche Tool-Ausgaben gerade ausgeblendet sind oder welche Zusammenfassungen gelten, gibt es in
diesem Build nicht. Der Befehl `session show` zeigt nur die letzten Nachrichten.

## Einstellungen

Alle Einstellungen liegen unter `session.compaction` in `config.json`. Die Standardwerte stehen daneben.

| Schlüssel | Standard | Wirkung |
|---|---|---|
| `session.compaction.softRatio` | `0.65` | Ab diesem Anteil des Fensters wird eine Zusammenfassung vorbereitet |
| `session.compaction.hardRatio` | `0.88` | Ab diesem Anteil wird die fertige Zusammenfassung eingesetzt. Muss größer als `softRatio` sein |
| `session.compaction.summaryMaxTokens` | `1228` | Obergrenze einer Zusammenfassung in Tokens, höchstens 15 Prozent des Fensters |
| `session.compaction.maxMessageTokens` | `819` | Obergrenze einer einzelnen Nachricht im Kontext, das Original bleibt im Verlauf |
| `session.compaction.summarizer` | `llm` | `llm` nutzt die Rolle `summarize`, `digest` nimmt immer die einfache Zusammenfassung |
| `session.compaction.prune.enabled` | `true` | Ausblenden von Tool-Ausgaben nach jedem Zug ein- oder ausschalten |
| `session.compaction.prune.keepLastTurns` | `3` | Die letzten N Züge werden nie ausgeblendet |
| `session.compaction.prune.decider` | `laya` | `laya`, `heuristic` oder `off` |
| `session.compaction.prune.maxMs` | `100` | Zeitbudget der Entscheidung in Millisekunden |
| `session.compaction.prune.batchSize` | `16` | Höchstens so viele Tool-Paare in einer Entscheidung |

Ein Beispiel für eine vorsichtigere Einstellung, die früher zusammenfasst:

```json
{
  "session": {
    "compaction": {
      "softRatio": 0.5,
      "hardRatio": 0.8,
      "summarizer": "llm",
      "prune": { "enabled": true, "keepLastTurns": 5, "decider": "heuristic" }
    }
  }
}
```

### Das Modell für Zusammenfassungen

Die Rolle `summarize` bestimmt, welches Modell Zusammenfassungen schreibt. Die Harness nimmt dafür ein Modellprofil namens
`summarize` aus `modelProfiles`. Ein Profil mit diesem Namen legst du in `config.json` an, mit den Kandidaten, die du
verwenden willst. Fehlt es, oder ist keiner seiner Kandidaten nutzbar, greift der deterministische Weg. Wie du Profile
anlegst und anbindest, steht in [providers.md](providers.md).

Die Zusammenfassung darf keine Werkzeuge aufrufen und bekommt keine Gedächtnisinhalte mit. Sie sieht nur den Teil des
Verlaufs, den sie zusammenfasst.

## Weiter

- [quickstart.md](quickstart.md): Erste Schritte, Chat und Gedächtnis.
- [providers.md](providers.md): Anbieter, Modellprofile und Fallback.
- [operations.md](operations.md): Konfiguration ändern und Fehlersuche.
