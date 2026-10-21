# Träume

Träumen ist das Aufräumen des Gedächtnisses im Hintergrund. Zu festen Zeiten und sobald genug neues Material erfasst wurde, lässt die Harness die Gedächtnis-Engine die jüngsten Erfassungen eines Agenten durchgehen. Was gelaufen ist, wann und mit welchem Ergebnis, siehst du im Tab Träume der Seite Erinnerungen (`#/memories/dreams`). Die englische Version dieser Seite ist [../en/dreams.md](../en/dreams.md).

Die Harness plant und überwacht die Läufe nur und führt ein Protokoll. Die eigentliche Arbeit macht die Gedächtnis-Engine. Jeder Lauf kostet Modell-Token, die das Protokoll pro Lauf festhält. Token werden gemessen, nicht begrenzt.

## Die drei Phasen

Jeder Agent hat drei Phasen. Jede hat einen eigenen Zeitplan, einen eigenen Schalter, einen eigenen Status und ein eigenes Log.

| Phase | Standard-Zeitplan | Engine-Jobs, die sie ausführt |
|---|---|---|
| **Leicht** | alle 4 Stunden (`0 */4 * * *`) | `light-dream`, `embedding-drain` |
| **REM** | täglich um 01:15 (`15 1 * * *`) | `rem-dream`, `discover-semantic-links` |
| **Tief** | täglich um 04:00 (`0 4 * * *`) | `consolidate-daily`, `auto-accept-stale`, `gc-run` |

Der Zeitplan ist ein Cron-Ausdruck mit fünf Feldern und einer ausdrücklichen Zeitzone; sie ist beim Anlegen des Zeitplans die Zeitzone des Rechners. Die Startzeiten werden pro Agent ein wenig gestreut, damit viele Agenten nicht im selben Moment starten, und höchstens drei Phasen laufen gleichzeitig.

## Was einen Lauf auslöst

- **Wichtigkeit:** Jede gespeicherte Erfassung erhöht pro Phase einen Zähler. Erreicht der Zähler die Schwelle der Phase (Leicht 150, REM 300, Tief 450), läuft die Phase, höchstens einmal pro Mindestabstand (1, 6 und 12 Stunden).
- **Zeitplan:** Die Phase läuft zu ihrer geplanten Zeit. Wurde seit ihrem letzten Lauf zu wenig erfasst (Leicht 1, REM 3, Tief 3 Erfassungen), wird der Lauf übersprungen.
- **Nachholen:** Nach einer Ausfallzeit läuft eine Phase, deren Zeit verpasst wurde, einmal, nicht einmal pro verpasster Zeit.
- **Manuell:** Du startest eine Phase selbst mit **Jetzt ausführen**. Sie nimmt alle Schutzprüfungen mit, außer dem Zeitplan.

## Was einen Lauf stoppt

Schutzprüfungen können einen Lauf überspringen oder beenden. Jedes Überspringen steht mit seinem Grund im Protokoll:

| Grund | Bedeutung |
|---|---|
| `idempotent` | Dasselbe Material im selben Fenster wurde schon verarbeitet. |
| `min_corpus` | Seit dem letzten Lauf gibt es zu wenig neues Material. |
| `already_running` | Dieselbe Phase dieses Agenten läuft schon. |
| `no_candidates` | Nichts hat die Prüfung für Kandidaten bestanden. |
| `no_llm_route` | Die Engine hat für diese Phase kein Modell zur Verfügung. |
| `breaker_sessions`, `breaker_open` | Die Sicherung: Ein Agent darf pro UTC-Tag drei Modellsitzungen über REM und Tief starten. Die vierte startet nicht, der Lauf gilt als abgebrochen, und die Sicherung bleibt bis zur nächsten UTC-Mitternacht offen. |

Ein Lauf, dessen Engine-Job fehlschlägt, wird als fehlgeschlagen verzeichnet, nie als abgeschlossen. Ein Lauf, den ein Absturz unterbrochen hat, wird beim nächsten Start als abgebrochen markiert, und sein Material bleibt weiter zulässig.

## Der Tab Träume

Der Tab beginnt mit **Hat das Träumen je gelaufen?**. Er zeigt den letzten Lauf und wie viele Phasen überhaupt schon gelaufen sind. Ist keine gelaufen, steht dort **Nie gelaufen**: Prüfe, ob die Phasen aktiviert sind und genug Material haben, oder starte eine jetzt.

Darunter hat jeder Agent einen Bereich mit seiner **Tagebuchdatei** (als geschrieben oder fehlend gekennzeichnet) und je eine Karte pro Phase:

- **Zeitplan** mit Cron-Ausdruck und Zeitzone sowie dem **Nächsten Lauf**. Eine deaktivierte Phase hat keinen.
- **Letzter Lauf** mit seinem Ergebnis (**Abgeschlossen**, **Übersprungen**, **Fehlgeschlagen**, **Abgebrochen** oder **Offen**), Startzeit und Auslöser (geplant, Wichtigkeit, manuell oder Nachholen) sowie Grund oder Fehler.
- **Wichtigkeit**: der Zähler gegenüber der Schwelle und die Erfassungen seit dem letzten Lauf.
- **Sicherung**: geschlossen mit den heute genutzten Sitzungen, oder offen bis zu einer Zeit mit dem Grund.
- **Jetzt ausführen** und **Aktivieren** oder **Deaktivieren**.

Ganz unten fassen die **Zähler des Schedulers** Läufe, Übersprungenes nach Grund, Auslöser, Auslösungen der Sicherung und aufgeräumte abgestürzte Läufe zusammen.

Das **Laufprotokoll** listet bis zu 50 Läufe und lässt sich mit **Nach Phase filtern** eingrenzen. Ein Lauf öffnet sich in einer Detailansicht mit **Lauf-Kennung**, Job, Auslöser, Grund, Start, Ende, Dauer, Zahlen, Token hinein und heraus und seinem Logtext. Logs bleiben 30 Tage erhalten, und ein übersprungener Lauf schreibt keins; Protokollzeilen bleiben 365 Tage erhalten. Ein leeres Laufprotokoll heißt, dass nie etwas versucht wurde, denn auch ein übersprungener Lauf hinterlässt eine Zeile.

## Jetzt ausführen, aktivieren und deaktivieren

**Jetzt ausführen** fragt zuerst in einem Probelauf die Schutzprüfungen und zeigt, ob der Lauf stattfände oder übersprungen würde, und warum. Erst dann bestätigst du. Ein bestätigter Lauf startet sofort, kann das Modell aufrufen und das Gedächtnis verändern. Die Seite meldet dann den Lauf und verlinkt ihn.

**Deaktivieren** stoppt Zeitplan und Wichtigkeits-Auslöser einer Phase. **Jetzt ausführen** funktioniert weiter. **Aktivieren** schaltet sie wieder ein.

Wer was darf: Owner, Admins und Operatoren können eine Phase ausführen. Nur Owner und Admins können aktivieren, deaktivieren oder einen Zeitplan ändern. Für andere Rollen sind die Schaltflächen als nicht verfügbar markiert. Lehnt der Server eine Aktion trotzdem ab, lässt die Seite sie bis zum Neuladen deaktiviert. Lesen von Status, Zeitplan und Log steht jeder Rolle offen; wird ein Teil abgelehnt, sagt der Tab das.

## Auf der Kommandozeile

```sh
plur1bus dreams status --agent main
plur1bus dreams run light --agent main --dry-run
plur1bus dreams run rem --agent main
plur1bus dreams log --agent main --phase deep --limit 10
plur1bus dreams log --run <run-id>
plur1bus dreams schedule get --agent main
plur1bus dreams schedule set deep --agent main --cron "30 3 * * *" --timezone Europe/Berlin
plur1bus dreams disable light --agent main
plur1bus dreams enable light --agent main
plur1bus dreams diary --agent main
```

- `dreams status` zeigt Phasen, letzten und nächsten Lauf, Sicherung, Wichtigkeit und Zähler; ohne `--agent` umfasst es alle Agenten.
- `dreams run` nimmt `light`, `rem` oder `deep`. `--dry-run` wertet die Schutzprüfungen aus und gibt aus, was passieren würde, ohne Protokollzeile und ohne die Engine aufzurufen. Auch ein Engine-Jobname wie `gc-run` funktioniert und führt diesen Job aus.
- `dreams log` zeigt mit `--phase` das Phasenprotokoll oder mit `--run` einen Lauf samt Log. Ohne `--phase` zeigt es die Job-Historie der Engine.
- `dreams schedule set` ändert `--cron` (fünf Felder), `--timezone` (ein IANA-Name wie `Europe/Berlin`) oder `--enabled` (`true` oder `false`) einer Phase.
- `dreams diary` gibt das private Tagebuch des Agenten aus. Owner, Admins oder eine Person mit dem Recht **manage** am Agenten können es lesen. Die Webseite öffnet das Tagebuch nicht, sie zeigt nur, ob die Datei existiert.

Alle Befehle von `dreams` sind in der Befehlsreferenz als experimentell markiert.

## Weiter

- Erinnerungen und ihr Zustand: [erinnerungen.md](erinnerungen.md)
- Eigene wiederkehrende Aufgaben: [wiederkehrende-aufgaben.md](wiederkehrende-aufgaben.md)
- Nutzung und Limits: [budgets.md](budgets.md)
- Rollen und Rechte: [benutzer-rollen.md](benutzer-rollen.md)
