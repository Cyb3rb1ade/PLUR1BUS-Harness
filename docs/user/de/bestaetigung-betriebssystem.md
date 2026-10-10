# Bestätigung per Betriebssystem

Manche Aktionen eines Agenten brauchen deine Freigabe. Bei den riskanteren verlangt die Harness zusätzlich eine
Bestätigung durch das Betriebssystem selbst: Touch ID, Windows Hello, die UAC-Abfrage oder bei Linux polkit. Diese Seite
erklärt, wann das passiert, was eine einzelne Bestätigung bewirkt und was es bedeutet, wenn sie „nicht verfügbar"
ist. Jeder Befehl hier existiert in diesem Build (`docs/cli.md` ist die vollständige Referenz). Die englische Fassung ist
[../en/os-confirmation.md](../en/os-confirmation.md).

**Wichtig vorab:** In den Release-Builds, wie sie heute ausgeliefert werden, ist das Hilfsprogramm für die
Bestätigung noch nicht enthalten. Dort erscheint deshalb bei jeder Freigabe, die eine Bestätigung braucht, der Hinweis
„nicht verfügbar". Die Dialoge von Touch ID, Windows Hello und polkit sind nur in einem Build zu sehen, der das
Hilfsprogramm mitbringt, etwa einem Quell-Build (siehe unten).

## Freigaben und Risikostufen

Ein Agent, der etwas tun will, für das er keine Erlaubnis hat, legt eine Freigabe-Anfrage an. Sie enthält, was
passieren soll, welche Ziele betroffen sind und wie riskant es ist. Die Risikostufe bestimmt, wer entscheiden darf:

- **niedrig** (zum Beispiel Lesen von Dateien, Schreiben innerhalb der erlaubten Ordner, Lesen der Zwischenablage):
  Du entscheidest direkt, ohne Dialog des Betriebssystems.
- **mittel** und **hoch** (zum Beispiel Shell-Befehle, Paketänderungen, Löschen von Dateien außerhalb der erlaubten
  Ordner): Dafür braucht die Entscheidung von einem lokalen Anschluss aus eine Bestätigung des Betriebssystems.
- **kritisch** (zum Beispiel Ausgaben von Geld, Systemrechte, Fernsteuerung): Diese Freigaben kannst du über die
  Kommandozeile noch nicht erteilen. Die Harness lehnt sie ohne Dialog ab.

Die Option „einmal" gilt für genau eine Aktion. Dauerhafte Freigaben (für eine Sitzung oder für einen Agenten) kannst du
über eine lokale Verbindung ohne Bestätigung nicht anlegen. Mit einer Bestätigung entsteht eine Freigabe der Stufe 2
wie jede andere.

## Die Freigabe über die Kommandozeile

Offene Anfragen zeigst du so:

```sh
plur1bus approval pending
```

Eine Anfrage bestätigst du mit ihrer Nummer, die mit `apr_` beginnt:

```sh
plur1bus approval approve <id>
```

Der Befehl zeigt zuerst die Anfrage: Befehl oder Änderung, Ziele und Risiko. In einem Terminal fragt er mit `[j/N]`
nach. Ohne Terminal, oder mit `--json`, bricht er ab, außer du gibst `--yes` an. Mit `--scope` wählst du die Dauer.
Ohne Angabe nimmt er die engste Option, die die Anfrage anbietet.

Eine Anfrage lehnst du so ab:

```sh
plur1bus approval deny <id>
```

## Was passiert, wenn eine Bestätigung nötig ist

Brauchst du für eine Anfrage eine Bestätigung durch das Betriebssystem, läuft das so:

1. Die Harness sagt dir zuerst, welche Bestätigung sie verlangt: Touch ID, Windows Hello, UAC oder polkit. Es passiert
   noch nichts.
2. Du bestätigst. Dann erscheint der Dialog des Betriebssystems auf diesem Rechner. Er nennt den Agenten, die Fähigkeit
   und den Umfang der Freigabe. Bei macOS kannst du statt Touch ID dein Konto-Passwort nutzen.
3. Die Harness entscheidet genau diese eine Anfrage. In der Protokollzeile steht, dass die Bestätigung durch das
   Betriebssystem erfolgte und welche Methode genutzt wurde.

Eine Bestätigung ist eng begrenzt:

- Sie gilt nur für genau diese Anfrage, mit ihrer Aktion, ihrem Umfang, ihrer Dauer und dem Agenten.
- Sie ist einmalig. Jede Freigabe öffnet einen neuen Dialog. Es gibt kein Zwischenspeichern wie bei `sudo`.
- Sie läuft nach höchstens 60 Sekunden ab. Wer danach zögert, bestätigt neu.
- Wird der Dialog abgebrochen, abgelaufen oder schlägt er fehl, bleibt die Anfrage offen. Du kannst es erneut versuchen.

Während ein Dialog offen ist, nimmt die Harness keine zweite Entscheidung zur selben Anfrage an.

## „Nicht verfügbar"

Die Meldung heißt `attestation-unavailable`. Der Befehl endet dann mit Code 2, die Anfrage bleibt offen, und andere
Teile der Harness laufen weiter. Die Meldung kommt in diesen Fällen:

- Das Hilfsprogramm `plur1bus-attest` ist nicht neben `plur1bus` installiert. Das ist bei den heutigen Release-Builds
  der Normalfall.
- Die Installation läuft im Container. Dort gibt es keinen Dialog, den man bedienen könnte.
- Es gibt keine grafische Sitzung, zum Beispiel bei einer reinen SSH-Verbindung.
- Unter Linux läuft kein polkit-Agent.

Was du dann tun kannst:

- **Niedrige Risiken** entscheidest du weiter direkt. Dafür braucht es keine Bestätigung.
- **Die Anfrage ablehnen** mit `plur1bus approval deny <id>`. Der Agent macht dann ohne die Aktion weiter.
- **Warten.** Eine offene Anfrage bleibt 24 Stunden bestehen. Danach läuft sie ab, und eine abgelaufene Anfrage gilt als
  abgelehnt. Nichts wird durch Zeitablauf stillschweigend freigegeben.
- **Einen Quell-Build nutzen.** Dort findet die Harness das Hilfsprogramm, wenn es neben `plur1bus` liegt. Du brauchst dann
  eine grafische Sitzung und unter Linux einen polkit-Agenten.

Der Befehl `plur1bus approval approve` endet in diesem Fall mit Code 2 und dem Grund `attestation-unavailable`.

## Freigaben über einen Chat-Kanal

Eine Freigabe, die über einen Chat-Kanal (zum Beispiel Telegram) eingeht, öffnet nie einen Dialog auf dem Host. Für die
Stufen, die eine Bestätigung brauchen, wird sie deshalb nicht angenommen. Entscheidungen über den Kanal sind gedacht
für niedrige Risiken. Mehr zu Kanälen steht in [channels.md](channels.md).

## Protokoll

Jede Bestätigung hinterlässt zwei Einträge im Audit-Protokoll: einen vor dem Dialog (`attestation.requested`) und
einen mit dem Ergebnis (`attestation.result`). Das Ergebnis ist eines von `confirmed`, `cancelled`, `timeout`,
`unavailable`, `failed`, `replay` oder `mismatch`. Die Einträge nennen die Anfrage und einen Hash der Aktion, nie das
Geheimnis der Bestätigung.

## Weiter

- [quickstart.md](quickstart.md): Erste Schritte und Anmeldung bei Anbietern.
- [channels.md](channels.md): Freigaben über Chat-Kanäle.
- [container.md](container.md): Die Harness im Container. Dort ist keine Bestätigung über den Dialog möglich.
- [operations.md](operations.md): Fehlersuche und Exit-Codes.
