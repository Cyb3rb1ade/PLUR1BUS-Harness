# Audit-Betrieb: Verweigerung, Pending und neue Ära

Dieser Ablauf verwendet die vorhandene Audit-Kette und ihre CLI. Die [Nutzeranleitung](../user/de/audit.md) beschreibt die Web-Ansicht; [audit-chain.md](../audit-chain.md) dokumentiert Dateien, Formate und Grenzen. Owner und Admin dürfen die Kette über den Core prüfen. Der lokale Reanchor folgt zusätzlich dem Betriebssystem-Zugriff auf das Installations-Home; eine Web-Rolle allein ersetzt ihn nicht.

## 1. Beobachtung sichern

Verwende bei allen Befehlen dasselbe Home, bei Bedarf mit `--home <PATH>`. Notiere Zeitpunkt, installierten Build, Akteur und die aktuelle Warnung. Die JSON-Statusantwort des laufenden Supervisors enthält die bis zu 30 Sekunden zwischengespeicherten Audit-Metadaten:

```sh
plur1bus daemon status --json
plur1bus audit verify --json
```

Die Prüfung braucht einen erreichbaren Core und die Audit-Berechtigung. Ein Befund (`ok: false`, CLI-Exit 1), `E_STORAGE` oder ein nicht erreichbarer Core ist keine erfolgreiche Integritätsprüfung. `state: "ok"` bedeutet nur, dass die beobachtete Tail-/Ankerlage akzeptabel oder in der eng begrenzten heilbaren Absturzlage ist. Auch eine frühere `lastVerifiedAt`-Angabe gilt nicht automatisch für die danach geschriebenen Zeilen.

Bewahre Prüfantwort und gegebenenfalls `lastSeq`/`lastHash` außerhalb der Schreibrechte dieses Hosts auf. Wer Kette und Anker umschreiben kann, kann beide gemeinsam fälschen; ein lokaler Zeitstempel ist kein unabhängiger Pin.

## 2. Beweismaterial vor weiteren Schreibversuchen erhalten

Koordiniere die Writer und erstelle, falls erforderlich, eine konsistente private Kopie des gesamten `<home>/logs/`-Bereichs. Die zusammengehörenden Dateien sind insbesondere:

- `audit.log`, aktive und rotierte `audit-chain*.jsonl` und `audit-chain.anchor`;
- `audit-chain.pending.jsonl` sowie `audit-chain.verified.json`, falls vorhanden;
- `.torn-*`-Fragmente und `.pre-reanchor-*`-Dateigruppen, einschließlich ihrer alten Anker.

Kette und Anker müssen zur selben Aufnahme gehören. Der Audit-Lock ist Koordinationszustand, kein unabhängiger Integritätsbeweis. Behandele die Kopie geschützt wie die Originale. Ändere oder lösche keine Beweise, um einen Writer oder Verifier zum Weiterlaufen zu bringen.

`backup create` schließt `logs/` aus. `backup verify`, Update-Health-Gate, Rollback und `1staid repair` sind keine Audit-Verifikation. Ein vom Writer beiseitegelegtes Schreibfragment bleibt ein Fragment; eine erfolgreiche spätere Prüfung rekonstruiert dessen ursprünglichen vollständigen Inhalt nicht.

## 3. Ursache und Betriebsfolge unterscheiden

| Beobachtung | Bedeutung / nächster Schritt |
|---|---|
| `anchor-missing`, `anchor-invalid`, `chain-shorter-than-anchor`, `tail-anchor-mismatch`, `tail-malformed` | Ende und Anker erlauben keine normale Fortsetzung. Speicherfehler, Absturz und absichtliche Veränderung sind durch den Code allein nicht unterschieden. Beweiskopie und Prüfantwort untersuchen. |
| genau eine vollständige, korrekt verkettete Zeile nach dem alten Anker, zuvor verankerte Zeile weiterhin passend | der nächste Writer kann den Anker nachziehen und schreibt `audit.chain.anchor-advanced`; dafür ist kein Reanchor vorgesehen |
| `lock-timeout` / `audit-chain-locked` | Schreib-/Prüflock wurde nicht rechtzeitig frei; Writer-Lage untersuchen und später erneut versuchen, nicht automatisch eine neue Ära beginnen |
| `audit-unreadable` | Dateien/Metadaten konnten nicht gelesen werden; Rechte und Speicherzustand untersuchen, kein Integritätsurteil |
| `sequence-exhausted` oder `rotation-target-exists` | Append verweigert aus einem Betriebsgrund. `reanchor` ist kein allgemeines Reset-Werkzeug: Wenn Tail und Anker vom Reanchor als fortsetzbar bewertet werden, meldet er `nothing-to-repair`. Ursache gezielt untersuchen. |
| `audit-chain-unavailable` nach Konfigurationsspeichern | nur die Kette hat die vorbereiteten Config-Audit-Zeilen verweigert; das Speichern kann trotzdem erfolgreich sein. `audit.log`, Pending-Zustand und tatsächliche Config-Antwort getrennt prüfen. |
| Pending-Anzahl oder `pendingDropped` größer null | noch nicht verkettete Zeilen beziehungsweise Journalüberlauf; keine Zusicherung vollständiger Audit-Abdeckung |

Die Config-Ausnahme gilt nur bei einer klassifizierten Kettenverweigerung. Ein Fehler beim Schreiben von `audit.log` oder ein anderer Ketten-Speicherfehler lässt die Konfigurationsänderung weiterhin scheitern. Umgekehrt kann das Pending-Vormerken scheitern, nachdem `audit.log` geschrieben wurde; die Warnung allein garantiert kein erfolgreiches Queuing. `phase: "prepare"` ist ein Vorbereitungseintrag, kein alleiniger Nachweis einer bestätigten Config-Transaktion.

## 4. Reanchor erst prüfen, dann ausdrücklich ausführen

Ein Reanchor beginnt eine neue Ära und legt die bisherigen Dateien unverändert beiseite. Er löst keine allgemeine Speicherstörung und bestätigt keine beschädigte Vergangenheit. Er läuft ausschließlich lokal per CLI, ohne Web-Schaltfläche und ohne Reanchor-RPC.

Probelauf für denselben, untersuchten Befund:

```sh
plur1bus audit reanchor --reason "Anker nach untersuchtem Speicherfehler verloren" --dry-run
```

Prüfe die Abweichung, den alten Anker, das alte Ende, den bis zur ersten Abweichung gültigen Präfix und die beiseitezulegenden Dateien. `nothing-to-repair` bedeutet, dass dieser Eingriff nicht vorgesehen ist. Im Dry-run ist eine Begründung optional; hier ist sie als bewusster Teil des Ablaufs angegeben.

Erst nach der Entscheidung für die neue Ära ausführen:

```sh
plur1bus audit reanchor --reason "Anker nach untersuchtem Speicherfehler verloren"
```

Die Begründung wird redigiert und gekürzt; gib trotzdem keine Geheimnisse ein. Der Befehl benötigt keinen Core und nimmt denselben Lock wie die Writer. Unter Unix muss `logs/` ein privates echtes Verzeichnis des aufrufenden OS-Nutzers sein; unter Windows gilt der Zugriffsschutz der Dateien. Die Server-RBAC-Abfrage einer Web-Sitzung ist kein Ersatz dafür.

Bewahre die `*.pre-reanchor-<Zeit>`-Dateien. Die erste Zeile der neuen Ära enthält `audit.chain.reanchored`, Akteur, Begründung, alte Lage und Dateiverweise; die neue Sequenz beginnt bei 1. Eine gemeldete Warnung über eine fehlgeschlagene Kopie nach `audit.log` macht den bereits erfolgten Kettenwechsel nicht rückgängig. Bei fehlgeschlagenem Umbenennen/Start oder einem Absturz die tatsächlich vorhandenen Dateien und Meldungen untersuchen, nicht blind wiederholen oder von Hand löschen.

## 5. Ergebnis und Nachträge prüfen

Sobald der Core erreichbar ist:

```sh
plur1bus audit verify --json
plur1bus daemon status --json
```

Prüfe aktuelle Ära, Reanchor-Ereignisse und frühere Ketten getrennt. Frühere Ketten werden nur bis zu ihrer ersten Abweichung ausgewertet; ein intakter aktueller Teil hebt einen alten Befund nicht auf. `announced: false` verlangt Untersuchung: Es fehlt der zugehörige Reanchor-Verweis in der aktuellen Ära, etwa nach einem Absturz zwischen Beiseitelegen und neuer erster Zeile.

Reanchor und Verify leeren das Pending-Journal nicht selbst. Ein späterer erfolgreicher Rust-Audit-Append versucht, es abzuarbeiten. Zeilen behalten ihre alten Ereigniszeiten, werden aber später verkettet. Überlauf, unlesbare Zeilen und nach einem Absturz mögliche doppelte Nachträge bleiben als Grenzen sichtbar. Vergleiche Pending-Metadaten nach Ablauf des Status-Caches und das Ereignis `audit.chain.pending_drained`, statt aus einer leeren Liste allein Vollständigkeit abzuleiten.

Bewahre das Ergebnis gemeinsam mit dem Ausgangsbefund und den alten Beweisen. Der Abschluss lautet gegebenenfalls „neue Ära funktionsfähig, alte Abweichung dokumentiert“, nicht „Vergangenheit lückenlos repariert“.
