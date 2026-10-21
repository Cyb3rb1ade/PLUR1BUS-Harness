# Audit-Kette prüfen und wieder in Betrieb nehmen

Die Audit-Kette macht nachträgliche Änderungen an aufgezeichneten privilegierten Aktionen erkennbar: Jede Zeile enthält den Hash der vorherigen Zeile, eine fortlaufende Nummer und den Audit-Eintrag. Eine getrennte Ankerdatei hält Nummer und Hash des zuletzt verankerten Endes fest. Die englische Fassung steht unter [audit.md](../en/audit.md).

Sie ergänzt `logs/audit.log`. Eine bestandene Prüfung bestätigt die geprüften Dateien gegen ihren vorhandenen Anker. Wer beides passend umschreiben kann, kann eine konsistente andere Geschichte erzeugen. Bewahre deshalb bei Bedarf `lastSeq` und `lastHash` aus einer Prüfung getrennt vom Host auf. Die Kette beweist auch nicht, dass jede Aktion überhaupt protokolliert wurde.

## Status und Rechte

Owner und Admin dürfen die Audit-Metadaten lesen und die Kette prüfen. Operator, Member, Viewer und Agenten erhalten diese Audit-Ansicht nicht. Ein eingeschränkter Zugangsschlüssel braucht zusätzlich die passende Audit-Berechtigung.

Öffne **Protokolle → Audit** (`#/logs/audit`). Der Tab lädt den Betriebsstatus beim Öffnen, führt dabei aber keine Kettenprüfung aus. Nach einer erfolgreich beantworteten Prüfung lädt er den Status erneut; auch dann gilt der serverseitige Cache.

- **Zustand des Writers** zeigt unter anderem **Audit-Einträge werden angenommen** oder **Audit-Einträge werden verweigert**, den Erfassungszeitpunkt, letzte Sequenz, Verweigerungscode und bekannte Wiederherstellungsereignisse. **Zustand aktualisieren** fragt erneut an; der serverseitige Cache bleibt dabei wirksam.
- **Vorgemerkte Audit-Zeilen** zeigt Anzahl und verworfene Zeilen sowie ausschließlich Zeit, Akteur, Aktion und Verweigerungscode. Ziele und Details werden nicht angezeigt.
- Unter **Kettenprüfung** startet erst **Kette prüfen** die ausdrückliche Prüfung. Du siehst Ergebnis der aktuellen Kette, Eintrags- und Dateizahl, letzte Sequenz, Anker und Prüfzeitpunkt. Angezeigt werden höchstens 20 aktuelle Befunde; weitere werden gezählt.
- **Audit-Ären** zeigt gemeldete Reanchor-Grenzen und frühere Ketten, mit **Gültig bis seq N**, Anker und erster Abweichung. Fehlende Ären-Metadaten werden als nicht verfügbar bezeichnet, nicht als bestätigte leere Geschichte.
- **Lokale Wiederherstellung** erklärt den CLI-Probelauf. Der angezeigte Befehl ist eine Anleitung; die Ansicht führt keinen Reanchor aus.

Status und ausdrückliche Prüfung können unabhängig scheitern. Ein Fehler beim Laden des Status sperrt den Prüfknopf nicht automatisch. Beim Verlassen des Tabs bleibt ein dort angezeigtes Prüfergebnis nicht als neue Prüfung einer anderen Ansicht erhalten.

Der Betriebsstatus wird bis zu 30 Sekunden zwischengespeichert. Er enthält unter anderem den beobachteten Zustand, die letzte Sequenznummer, den Zeitpunkt der letzten erfolgreichen ausdrücklichen Prüfung, vorgemerkte Zeilen und zuletzt beobachtete Anker-Heilung beziehungsweise Reanchor mit Zeitpunkt und Akteur. Bei unbekannten Werten steht keine erfundene Erfolgsmeldung.

**`ok` ist keine vollständige Integritätsprüfung.** Der Status betrachtet vor allem Kettenende und Anker; er prüft nicht die komplette Historie. Auch ein abgerissenes Schreibfragment kann dabei noch als gesondert zu untersuchender Befund vorhanden sein. Der Zeitpunkt einer früheren erfolgreichen Prüfung gilt nicht automatisch für spätere Einträge.

Auf der Kommandozeile zeigt die JSON-Ausgabe des laufenden Supervisors die Audit-Metadaten:

```sh
plur1bus daemon status --json
plur1bus audit verify
```

`audit verify` fragt den laufenden Core. Bei Befunden endet es mit Status 1. Fehler beim Lesen oder bei der Prüfung sind kein Beleg für eine intakte Kette. Eine erfolgreiche ausdrückliche Prüfung speichert ihren Zeitpunkt in einer privaten Metadatendatei; die Kettenbeweise werden dabei nicht repariert.

## Was „Kette verweigert“ bedeutet

`refusing` mit einem Grund wie `anchor-missing`, `anchor-invalid` oder `tail-anchor-mismatch` heißt, dass das beobachtete Ende keine normale Fortsetzung erlaubt. Eine fehlende oder beschädigte Datei kann auf einen Absturz, einen Speicherfehler oder eine Veränderung zurückgehen. Der Grund allein entscheidet das nicht.

Eine besondere Ausnahme ist eine vollständige, korrekt verkettete Zeile genau einen Schritt vor dem alten Anker. Wenn auch die zuvor verankerte Zeile noch passt, kann der nächste Writer den Anker nachziehen und hält das als `audit.chain.anchor-advanced` fest. Andere Abweichungen werden dadurch nicht für gültig erklärt. Die Statusanzeige selbst heilt nichts.

### Konfiguration kann trotzdem gespeichert werden

Wenn nur die Kette einen Audit-Eintrag der Konfigurationsänderung verweigert, kann der Supervisor die Konfiguration trotzdem speichern. Der Eintrag geht mit `chain: "refused"` und `chainReason` in `audit.log`; zusätzlich wird versucht, ihn im Pending-Journal vorzumerken. Die Antwort trägt die Warnung `audit-chain-unavailable`. Diese Warnung sagt weder „Speichern fehlgeschlagen“ noch „Audit vollständig“.

Kann `audit.log` nicht geschrieben werden oder tritt ein anderer Speicherfehler der Kette auf, scheitert das Speichern weiterhin. Die Ausnahme gilt für diesen Konfigurationspfad; sie ist keine allgemeine Freigabe, privilegierte Aktionen ohne Audit auszuführen. Ein Audit-Eintrag mit Phase `prepare` beschreibt die Vorbereitung der Änderung, nicht allein deren erfolgreichen Abschluss.

Vorgemerkte Zeilen sind noch nicht durch die Kette gegen Änderungen abgesichert. Das Journal ist auf 10.000 Zeilen und 8 MiB begrenzt; bei Überlauf entfallen die ältesten Zeilen, gezählt als `pendingDropped`. Auch das Vormerken kann scheitern, obwohl die Zeile bereits in `audit.log` steht. Eine leere Pending-Liste bestätigt deshalb keine lückenlose Vergangenheit.

Sobald die Kette wieder Einträge annimmt, versucht der Rust-Audit-Writer bei einem erfolgreichen Append, die wartenden Zeilen in ihrer Reihenfolge nachzutragen. Sie behalten ihren ursprünglichen Ereigniszeitpunkt, stehen aber später in der Kette. Ein Absturz kann dabei einen doppelten Nachtrag erzeugen. Reanchor allein ist kein Nachweis, dass das Journal schon abgearbeitet wurde.

## Reanchor bleibt ein lokaler CLI-Schritt

Sichere vor weiteren Schreibversuchen die vorhandenen Beweise geschützt und konsistent: Kettendateien, Anker, `audit.log`, Pending-Journal und vorhandene `.torn-*`- sowie `.pre-reanchor-*`-Dateien. Ein normales Installationsbackup enthält `logs/` nicht. Schreibe Dateien und Anker nicht von Hand um und lösche die alten Beweise nicht, um eine Prüfung grün zu bekommen.

Führe zuerst einen Probelauf für dasselbe Home aus:

```sh
plur1bus audit reanchor --reason "Anker nach untersuchtem Speicherfehler verloren" --dry-run
```

Er zeigt Befund und beiseitezulegende Dateien, ohne die Kette zu ändern. Ist der Zustand regulär fortsetzbar oder vom nächsten Writer heilbar, meldet der Befehl `nothing-to-repair`. Ein vorübergehendes Lock-Problem ist kein Grund, vorsorglich eine neue Ära zu beginnen.

Erst nach Prüfung des Befunds beginnst du mit demselben begründeten Aufruf ohne `--dry-run` eine neue Ära:

```sh
plur1bus audit reanchor --reason "Anker nach untersuchtem Speicherfehler verloren"
plur1bus audit verify
```

Reanchor arbeitet direkt auf den lokalen Dateien und braucht keinen laufenden Core. Du führst es als Betriebssystem-Besitzer der Installation aus; das ist nicht allein die Web-Rolle Admin. Unter Unix prüft es das private Log-Verzeichnis, unter Windows schützen die Datei-ACLs. Der Befehl koordiniert sich über den Audit-Lock auch mit einem laufenden Core. Für die anschließende `audit verify`-Abfrage muss der Core wieder erreichbar sein.

Die bisherigen Kettendateien und der Anker werden unverändert mit `.pre-reanchor-<Zeit>` beiseitegelegt. Die neue Kette beginnt bei Sequenz 1 mit `audit.chain.reanchored`: Akteur, gekürzte und redigierte Begründung, alter Anker, altes Ende, erste Abweichung und Verweise auf die alten Dateien. Schreib keine Geheimnisse in die Begründung. Es gibt keinen Web-Knopf zum Reanchor.

## Ären und Reparatur richtig lesen

Die Prüfung trennt die aktuelle Ära von den früheren Ketten. Für jede beiseitegelegte Kette zählt sie nur den Präfix bis zur ersten Abweichung. Eine neue intakte Ära macht diese alte Abweichung nicht ungeschehen. `announced: false` heißt, dass kein passender Reanchor-Eintrag in der aktuellen Kette die Dateigruppe nennt; das kann etwa nach einem Absturz zwischen Umbenennen und Start der neuen Kette vorkommen und muss untersucht werden.

Ein abgerissenes Schreibende wird vom nächsten Writer als `.torn-*` gesichert. Das ist erhaltenes Beweismaterial, keine rekonstruierte vollständige Audit-Zeile. Eine danach intakte Kette, `1staid repair` oder ein Reanchor bestätigt weder den Inhalt dieses Fragments noch die Vollständigkeit der alten Aufzeichnungen.

Weiter: [Status und Protokolle](diagnose.md), [Betrieb](operations.md).
