# Vorhandene Installation importieren

Owner und Admin öffnen **Import** unter `#/import` oder nutzen den optionalen Import-Schritt der Einrichtung.
Beide verwenden dieselbe Quellprüfung, Vorschau und Vorprüfung. Die englische Fassung steht unter
[../en/import.md](../en/import.md).

**Aktuelle Prüfgrenze:** Die Übernahme über echtes HTTP mit nativem Supervisor sowie Core-Stopp und -Neustart
wurde erfolgreich geprüft. Abbruch und automatische Wiederherstellung nach einem Teilimport bestanden den exakten
Vergleich aller veränderlichen Daten. Das MFA-freigegebene native Import-Cookie bestand ebenfalls die Offline-Fortschritts- und Isolationstests.
Der manuelle Rollback bestand ebenfalls die exakte Wiederherstellung aller veränderlichen Daten einschließlich
Entfernen des importierten Skills und erneutem Core-Neustart. Spätere Änderungen am Ziel verhindern weiterhin einen
unsicheren Rollback. Die erforderlichen Browser- und Barrierefreiheitstests warten auf die festgelegte Browserressource.
Der reine Skill-Import lässt den Core laufen.

Beide unterstützten Quellfamilien haben außerdem den echten HTTP- → schreibgeschützten SSH/SFTP- → versiegelten Snapshot- → nativen Wartungsablauf bestanden, einschließlich Memory-Recall und deaktivierter Skill-/MCP-Zustände.

## Quelle auswählen und prüfen

Wähle eines der vom Harness angebotenen Quellformate und anschließend den Ort:

- **Auf diesem Computer erkannt:** prüft den bekannten Quellort auf dem Harness-Host.
- **Ordner auf dem Harness-Host:** verwendet einen eingegebenen Quellpfad. Der Owner darf dies auch entfernt tun;
  Admin benötigt eine lokale Verbindung.
- **WSL-Installation:** wählt eine Distribution. Das Auflisten startet keine gestoppte Distribution. Deren Prüfung
  benötigt eine gesonderte ausdrückliche Zustimmung.
- **SSH-Verbindung:** verwendet eine konfigurierte Verbindung mit bestätigtem Hostschlüssel und erlaubtem Quellpfad.
  Der Owner kann in einer normalen Kontositzung **SSH-Zugriff konfigurieren** wählen, einen Schlüssel erzeugen und
  die angezeigten Anweisungen für schreibgeschütztes SFTP befolgen. Beim Speichern müssen der genaue Host und Port
  ausdrücklich in der zentralen Egress-Richtlinie freigegeben werden; bestehende Listen und ihre kombinierte Wirkung
  werden angezeigt. Prüfe den Hostschlüssel-Fingerabdruck unabhängig, bevor du ihm vertraust. Admin kann vorhandene
  Verbindungen wählen, sie jedoch nicht einrichten. Im Containerbetrieb kann der authentifizierte Katalog
  `host.docker.internal` als Docker-Host vorschlagen. Prüfe das Ziel und gegebenenfalls die Linux-Host-Gateway-Zuordnung;
  der Vorschlag erlaubt weder Egress noch private Adressen oder einen Hostschlüssel.
  Betriebssystemhinweise stehen in der [SSH-Importreferenz](../../import.md).
- **Hochgeladener Snapshot:** nimmt ein `.tar.gz`-Archiv entgegen. In der Desktop-App nutzt **Quelle auf diesem Computer
  auswählen** den nativen Dialog und Snapshot-Erzeuger. JavaScript erhält eine undurchsichtige Kennung, keinen lokalen Pfad.

Snapshot-Uploads gehören der angemeldeten Person, laufen nach zehn Minuten ab und sind von Erweiterungspaketen
getrennt. Die komprimierte Eingabe ist auf 1 GiB begrenzt. Auch entpackte Bytes, Dateianzahl und Verschachtelung werden
begrenzt; unsichere Archive werden abgelehnt.

### Schreibgeschütztes SSH auf der Quelle einrichten

Verwende ein eigenes Quellkonto, das nur die vorgesehenen Importdateien lesen kann. Der Harness erzeugt seinen
Ed25519-Schlüssel im Secret Store. Installiere ausschließlich die vollständige eingeschränkte Zeile, die **SSH-Zugriff
konfigurieren** oder der CLI-Schlüsselstatus ausgibt. Auf der Quelle muss ein OpenSSH-Server mit SFTP vorhanden sein.
Der Harness installiert diesen Server nicht und verändert dessen SSH-Konfiguration nicht.

Die ausgegebene Zeile hat diese Form; ersetze beim manuellen Erstellen beide Platzhalter:

```text
restrict,command="<SFTP_SERVER> -R" <PUBLIC_KEY> plur1bus-import
```

`<PUBLIC_KEY>` ist der vollständige erzeugte öffentliche Schlüssel `ssh-ed25519 …`. Behalte `restrict`, den erzwungenen
Befehl und `-R` bei: Der feste Befehl ersetzt eine Shellsitzung, `-R` verweigert SFTP-Schreibzugriffe und Dateisystemänderungen,
und `restrict` sperrt Weiterleitungen, PTY-Zuweisung und benutzereigene SSH-Startskripte ([1](#ssh-quellen)).
Installiere keinen uneingeschränkten öffentlichen Schlüssel. Prüfe den ausführbaren Pfad auf der Quelle, bevor du eine
dieser Vorlagen verwendest:

| Quellbetriebssystem | Vorlage für `<SFTP_SERVER>` | Prüfung und Einrichtung |
| --- | --- | --- |
| Debian | `/usr/lib/openssh/sftp-server` | Am 29.10.2026 in der installierten Debian-13-Version `1:10.0p1-7+deb13u4` von `openssh-sftp-server` bestätigt. Prüfe die Dateiliste des Quellpakets. |
| Ubuntu | `/usr/lib/openssh/sftp-server` | Für das aktuelle Ubuntu-Paket in dieser Prüfung **ungeprüft**; bestätige vor der Verwendung dessen installierte Dateiliste. |
| Fedora / RHEL | `/usr/libexec/openssh/sftp-server` | Vorlage aus OpenSSHs Red-Hat-Paketierung; bestätige den installierten Pfad ([2](#ssh-quellen)). |
| Arch | `/usr/lib/ssh/sftp-server` | Vorlage aus dem offiziellen archivierten Arch-Paketrezept; das aktuell installierte Paket wurde nicht geprüft ([2](#ssh-quellen)). |
| macOS | `/usr/libexec/sftp-server` | Pfad durch Apples OpenSSH-Buildeinstellungen belegt. Aktiviere die entfernte Anmeldung für das eigene Quellkonto. **Ungeprüft:** der aktuelle Einstellungsort, üblicherweise Systemeinstellungen → Allgemein → Teilen → Entfernte Anmeldung ([3](#ssh-quellen)). |
| Windows OpenSSH | `C:/Windows/System32/OpenSSH/sftp-server.exe` | Vorlage für die Windows-Standardinstallation; ersetze sie bei einem anderen Installationsort ([4](#ssh-quellen)). |

Hänge unter Unix die vollständige eingeschränkte Zeile an `~/.ssh/authorized_keys` des Quellkontos an. Dieses Konto
muss Verzeichnis und Datei besitzen; verwende die Rechte `700` für `.ssh` und `600` für `authorized_keys`. Begrenze den
Dateisystemzugriff des Kontos separat: Schreibgeschütztes SFTP beschränkt allein nicht die lesbaren Verzeichnisse.

Unter Windows verwendet ein Standardkonto `%USERPROFILE%\.ssh\authorized_keys`. Ein Administratorkonto verwendet
stattdessen `%ProgramData%\ssh\administrators_authorized_keys`. Deaktiviere dort vererbte ACLs und erlaube ausschließlich
Administrators und SYSTEM, wie von Microsoft beschrieben ([4](#ssh-quellen)). Füge auch hier die vollständige eingeschränkte
Zeile ein, nicht nur den öffentlichen Schlüssel.

Erlaube im Harness nur den vorgesehenen genauen Host und TCP-Port. Die Zustimmung zu privaten Adressen ist von der
zentralen Egress-Liste getrennt. Prüfe den Hostschlüssel, vergleiche den angezeigten SHA256-Fingerabdruck mit einem
vertrauenswürdigen Administrator oder der Konsole der Quelle und bestätige erst dann genau diese Prüfung. Ein
geänderter Hostschlüssel sperrt den Zugriff. Die Angaben sind Einrichtungsvorlagen und Quellprüfungen; sie belegen
keinen getesteten Serverbetrieb auf jedem genannten Betriebssystem. Ohne geeigneten SSH-Zugriff kannst du den oben
beschriebenen lokalen Desktop-Snapshot verwenden.

Wähle für eine bestimmte Installation **Quelle prüfen**. Bei einem übergeordneten Host-, WSL- oder SSH-Ordner sucht
**Installationen suchen** begrenzt in bekannten Orten. Wähle anschließend eine erkannte Installation zur Prüfung. Die Erkennung allein
erzeugt noch keinen Importplan. Prüfe Agenten, Skills, Stores, Plugins, MCP-Server, nicht unterstützte Inhalte und Warnungen.
Plugin-Einstufungen beschreiben die Übertragbarkeit; sie erlauben nicht das Ausführen des Quellcodes. Importierte
MCP-Konfiguration bleibt deaktiviert und benötigt gegebenenfalls eine Secret-Einrichtung. Zugangsdaten erscheinen
nie in der Vorschau.

Erkannte eigenständige Speicher werden separat angezeigt. Sie benötigen eine Quelle beziehungsweise einen Agenten
und eine ursprüngliche Pfadzuordnung. Ordne in den Importoptionen den externen Pfad aus der Quellkonfiguration der
erkannten Speicherauswahl zu. Der angezeigte Fundpfad ist Metadateninformation; der Server behält die ursprüngliche
lokale, WSL- oder SSH-Leseberechtigung und versiegelt den gewählten Speicher für die Vorschau. Die Zuordnung ersetzt
einen Leseort der Quelle und legt kein Importziel fest.

## Auswahl und Vorschau

Wähle die Agenten. Zu den Optionen gehören Konfliktlösungen, Profil- und Pfadzuordnungen, Quellspeicher-Übernahme
und neues Einbetten. Die Speicherauswahl verwendet echte geprüfte Metadaten und zeigt die gemeldete Agent- oder
Gemeinschaftszuordnung sowie, falls vorhanden, die Zeilenzahl. Gemeldete externe Quellpfade lassen sich für
Leseort-Zuordnungen auswählen. Nur der Owner kann Zugangsdaten der Quelle übernehmen; vorhandene Ziel-Secrets bleiben erhalten.

Prüfe beim gewählten Speicher den gemeldeten **Modellkandidaten der Quelle**, Dimensionen, Revision und Lizenz.
Das sind Metadaten; die Vorprüfung muss die kopierten Vektoren weiterhin gegen das tatsächlich festgelegte
Quellmodell prüfen. Beim neuen Einbetten erscheint außerdem das aktuelle Zielmodell des Hosts, wenn kein Ziel
eingetragen wurde. Ein eigenes oder nicht unterstütztes aktuelles Modell benötigt ein ausdrücklich gewähltes unterstütztes lokales Ziel.

Jedes nichtkommerzielle Quell- oder Zielmodell benötigt die gespeicherte Lizenzannahme genau dieser Person für
Modell und festgelegte Revision sowie eine erlaubte Nutzungsklasse. Die Oberfläche speichert die Annahme jedes
unterstützten Modells gesondert. Die hostweite nichtkommerzielle Bestätigung bleibt eine eigene Entscheidung in
den Einstellungen; die Modellprüfung verlinkt sie, ohne sie zu ändern. Startet diese Änderung den Core neu, prüfe
danach die Quelle erneut und erstelle eine neue Vorschau. Importsitzungen mit begrenzten Geräte-Rechten benötigen
für Modell- und Einstellungsbestätigungen die normale Owner-/Admin-Kontositzung derselben Person; ihre Rechte
werden nicht erweitert. Eine erfundene Annahmekennung oder ein ungeprüftes Häkchen ersetzt die Vorprüfung nicht.

Wähle **Vorschau erstellen**. Löse verbleibende Konflikte und aktualisiere die Vorschau. Änderungen erzeugen einen
neuen unveränderlichen Plan. Die Übernahme akzeptiert keine nachträglichen Konfliktantworten und keinen Force-Schalter.

## Vorprüfung und Wartung

Wähle **Vorprüfung ausführen**. Eine fehlgeschlagene Prüfung lässt den Core laufen. Ein erfolgreicher Check zeigt
Ausfallzeit und Plattenbedarf. Stimme dem Anhalten des Cores ausdrücklich zu, bevor du **Import übernehmen** wählst.

Der Fortschritt zeigt den vom nativen Host gemeldeten Zustand. **Abbrechen und Snapshot wiederherstellen** fordert
den Abbruch an. Warte weiter, bis Wiederherstellung und Neustart gemeldet werden. Das Schließen des Browsers bricht
den Auftrag nicht ab. Der Verlauf öffnet gespeicherte Läufe. Fortsetzen und Zurückrollen benötigen eine neue Vorprüfung;
spätere Änderungen am Ziel können den Rollback verhindern.

Bei angehaltenem Core behält das startende Browser-Cookie einen eng begrenzten Zugriff auf Fortschritt und Abbruch.
Eine angemeldete native Importsitzung benötigt zusätzlich den intern geprüften Nachweis einer MFA-Freigabe derselben
Person für den Importzweck; ein gewöhnliches Geräte-Cookie genügt nicht. Eine zweite Sitzung derselben Person erbt
keinen Zugriff. Der Kontext endet mit der Sitzung oder seiner festen Wartungsfrist; Neuladen verlängert sie nicht.
Persönliche API-Tokens ersetzen diese Freigabe nicht. Das MFA-freigegebene Cookie bestand den echten Offline-Ablauf; die Browser- und eingebetteten Oberflächentests
warten weiterhin auf die erforderliche Browserressource.

## Nur Skills und CLI

**Nur Skills in der Vorschau** zeigt Skill-Aktionen, ohne den Core anzuhalten. Prüfe und bestätige die Vorschau, dann
wähle **Nur Skills importieren**. Die Aktivierung für alle Agenten ist eine eigene Auswahl.

Für Quellprüfung und Wartung gibt es weiterhin die CLI:

```sh
plur1bus import --help
```

Der vorhandene CLI-Rollback und seine Grenzen bei Erinnerungskarten stehen unter [Import zurückrollen](import-rollback.md).

### SSH-Quellen

[1] OpenSSHs [`sshd(8)`-Optionen für autorisierte Schlüssel](https://github.com/openssh/openssh-portable/blob/master/sshd.8)
    und der [schreibgeschützte Modus von `sftp-server(8)`](https://github.com/openssh/openssh-portable/blob/master/sftp-server.8).

[2] OpenSSHs [Red-Hat-Paketrezept](https://github.com/openssh/openssh-portable/blob/master/contrib/redhat/openssh.spec)
    und das [offizielle archivierte Arch-Rezept](https://github.com/archlinux/svntogit-packages/blob/packages/openssh/trunk/PKGBUILD).

[3] Apples [OpenSSH-Buildeinstellungen](https://github.com/apple-oss-distributions/OpenSSH/blob/main/xcconfigs/openssh.xcconfig)
    und [Installationspfade](https://github.com/apple-oss-distributions/OpenSSH/blob/main/xcconfigs/base.xcconfig).
    Der aktuelle Einstellungsort für die entfernte Anmeldung ließ sich hier nicht unabhängig bestätigen.

[4] Microsofts [OpenSSH-Schlüsselverwaltung](https://github.com/MicrosoftDocs/windowsserverdocs/blob/main/WindowsServerDocs/administration/OpenSSH/OpenSSH_KeyManagement.md)
    und [Serverkonfiguration](https://github.com/MicrosoftDocs/windowsserverdocs/blob/main/WindowsServerDocs/administration/OpenSSH/openssh-server-configuration.md).
