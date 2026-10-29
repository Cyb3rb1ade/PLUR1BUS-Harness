# Skills und Erweiterungen

Owner und Admin verwalten Erweiterungen unter **Skills** (`#/skills`) und **Plugins** (`#/plugins`). Andere Rollen
können die Erweiterungsliste weder lesen noch ändern. Die Filter umfassen Skills, Module, Kanäle, MCP-Server und
Bundles. Einstellungen → **Module & Updates** zeigt außerdem installierte Erweiterungen außer Skills mit Typ,
Vertrauen und Status. Die englische Fassung steht unter [../en/extensions.md](../en/extensions.md).

## Aus Datei oder Ordner installieren

1. Wähle **Aus Datei installieren**. Wähle ein Paket (`.p1x`, `.zip`, `.skill`, `.mcpb` oder `.dxt`) oder schalte auf
   **Ordner** um. Der Browser überträgt Dateiinhalte. Einen Ordner verpackt er selbst; sein lokaler Pfad wird nicht
   an den Harness gesendet.
2. Prüfe die Bestätigungsseite. Sie zeigt Vertrauensstufe, Signierer und Signaturschlüssel-ID, Herausgeber, Lizenz,
   ausführbare Skripte mit Shebangs, Berechtigungen und Laufzeitanforderungen. Ein ungeprüfter Herausgeber wird
   ausdrücklich so gekennzeichnet.
3. Bestätige die angeforderten Berechtigungen. Unsignierte Pakete und unbekannte Signierer haben jeweils eine
   eigene Bestätigung. Auch der Ersatz einer installierten Version muss gesondert bestätigt werden.
4. Mit **Installieren** bleibt ein Drittanbieter-Paket inaktiv. Mit **Installieren und aktivieren** wählst du seine
   Agenten. First-Party-Pakete zeigen vorab, dass die Installation sie für alle Agenten aktiviert; hier gibt es
   ausschließlich **Installieren**.

Upload und Prüfung gehören deiner angemeldeten Person und laufen nach zehn Minuten ab. Ein Neuladen der
Bestätigungsseite lädt dieselbe eigene Prüfung erneut. Ist sie abgelaufen, lade das Paket noch einmal hoch.
Unmittelbar vor der Installation wird die Prüfung erneut gelesen; geänderte Angaben müssen erneut geprüft und
bestätigt werden.

Prüfe bei Bundles für jedes Kind dessen eigenen Signierer, Vertrauensstufe, Berechtigungen und Skripte.
Erforderliche Kinder bleiben ausgewählt; optionale Kinder sind anfangs nicht ausgewählt. Nur die ausgewählten
Kinder werden installiert und fließen in die Bestätigungen ein. Die Bundle-Signatur ändert die Vertrauensstufe
eines Kindes nicht. Auch ein First-Party-Bundle verlangt die Bestätigung ausgewählter unsignierter Kinder oder
Kinder mit unbekanntem Signierer vor ihrer Aktivierung.

Die Paketgrenze kommt aus der Harness-Konfiguration (standardmäßig 256 MiB). Ein zu großer oder unterbrochener
Upload hinterlässt kein verwendbares Paket. Die direkte Installation aus dem Katalog `plur1bus.app` ist noch nicht
verfügbar. **Aus einer vorhandenen Installation** öffnet den [Import](import.md).

## Für Agenten aktivieren

Die Detailseite zeigt die angeforderten Berechtigungen. Vor dem Aktivieren öffnet sich deren Bestätigung. Ändern
sich die Rechte währenddessen, wird nichts aktiviert, bis du sie erneut geprüft hast. Skills, MCP-Server und
Bundles haben Schalter je Agent. Module und Kanäle nutzen die installationsweite Aktion.

Die Bundle-Details zeigen jedes installierte Kind und seine wirksamen Agenten. **Teilweise aktiv** bedeutet, dass
nur einige ausgewählte Kinder aktiv sind. Die gemeinsame Aktivierung zeigt die Berechtigungen der installierten
Kinder erneut. Fehlende oder geänderte Kinderangaben blockieren sie, bis diese geprüft werden können.

Autorisierte Änderungsereignisse laden Liste und Details neu. Bei Fehlern bleibt der dargestellte Zustand erhalten;
die Oberfläche zeigt einen Fehler oder eine Möglichkeit zum erneuten Versuch.

## MCP einrichten und anmelden

Ein Paket mit fehlender Konfiguration zeigt seinen Einrichtungsstatus. Erforderliche Secret-Slots zeigen nur ihren
Namen und ob ein Wert hinterlegt ist. Ausschließlich der Owner kann einen Wert eingeben oder ersetzen; Admin sieht
dessen Verfügbarkeit. Nach dem Absenden wird das Eingabefeld geleert. Die Einrichtungs-API gibt keinen Wert zurück.

OAuth beginnt erst mit **Anmeldung starten**. Verwende die für diesen Host registrierte Client-ID und Loopback-
Weiterleitungsadresse oder seine vorhandene Registrierung. Folge dem Anmeldelink oder den Gerätecode-Anweisungen.
Falls angefordert, füge die vollständige Callback-URL in das geschützte Feld ein. Ein Versuch kann abgebrochen werden
und gehört immer der startenden Person sowie genau diesem MCP-Server. Das Auflisten von Tools startet keine Anmeldung.

Native Gerätezugänge benötigen eine ausdrückliche Freigabe für Erweiterungen. Verlangt das Konto TOTP oder einen
Passkey, nutzt die native Fortsetzung einen kurzlebigen Freigabecode: Öffne dessen Freigabeseite in einer
Browser-Kontositzung derselben Person, erfülle den verlangten zweiten Faktor und bestätige den angezeigten
Erweiterungszweck. Die native App erhält Einmalnachweise intern; auf der Seite wird kein Gerätezugang eingefügt.
Persönliche API-Tokens ersetzen die Freigabe nicht. Der echte API-MFA-Ablauf ist geprüft; die vollständige native
Oberflächen- und Browserabnahme steht noch aus.

## Entfernen oder wiederherstellen

Beim Deinstallieren wandert das Paket in den Papierkorb. Prüfe die gesonderten Optionen zum Löschen seiner Daten
und zum Deaktivieren abhängiger Module. Eine aufbewahrte Version kann über die Detailseite wiederhergestellt werden
und bleibt dabei inaktiv.

Für die lokale Verwaltung gibt es weiterhin die CLI:

```sh
plur1bus skill list
plur1bus plugin list
plur1bus ext inspect <path>
plur1bus skill enable <name>
plur1bus skill disable <name>
plur1bus plugin uninstall <name>
```

Siehe auch [Secrets](secrets.md), [Import](import.md) und [Import zurückrollen](import-rollback.md).
