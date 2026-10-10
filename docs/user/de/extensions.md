# Skills und Plugins

Skills und Plugins erweitern die Fähigkeiten von Agenten und der Harness. Ein Skill stattet einen Agenten mit
spezifischen Werkzeugen und Handlungsanweisungen aus, ein Plugin ergänzt Module oder Plattformanbindungen, und ein
Modul stellt Kernfunktionen bereit. Jeder Befehl hier existiert in diesem Build (`docs/cli.md` ist die vollständige
Referenz). Die englische Version dieser Seite ist [../en/extensions.md](../en/extensions.md).

In der Weboberfläche werden Skills und Plugins unter **Skills** (`#/skills`) und **Plugins** (`#/plugins`) verwaltet.
Beide Routen öffnen die gemeinsame Erweiterungsübersicht mit entsprechend vorgefilterter Ansicht.

## Erweiterungen auflisten

Installierte Skills anzeigen:

```sh
plur1bus skill list
```

Installierte Plugins anzeigen:

```sh
plur1bus plugin list
```

In der Weboberfläche zeigt die Liste Name, Typ (Skill, Plugin oder Modul), Version, Quelle, Aktivierungsstatus sowie
Kompatibilität und Zustand an.

## Details einsehen

Details und deklarierte Berechtigungen eines Skills anzeigen:

```sh
plur1bus skill show <name>
```

Details eines Plugins anzeigen:

```sh
plur1bus plugin show <name>
```

Beim Auswählen einer Erweiterung in der Weboberfläche öffnet sich das Detailpanel mit Herkunftsangaben,
Kompatibilitätshinweisen und Berechtigungen.

## Aktivieren und deaktivieren

Einen Skill aktivieren oder deaktivieren:

```sh
plur1bus skill enable <name>
plur1bus skill disable <name>
```

Ein Plugin aktivieren oder deaktivieren:

```sh
plur1bus plugin enable <name>
plur1bus plugin disable <name>
```

In der Weboberfläche schaltet der Schalter die Erweiterung sofort um. Bei aktiver Ereignisverbindung aktualisiert sich
die Ansicht in Echtzeit.

## Erweiterungen installieren

Erweiterungen können aus einer lokalen Archivdatei (`.p1x` oder Tarball) installiert werden:

```sh
plur1bus skill install <path>
plur1bus plugin install <path>
```

Ein Erweiterungspaket kann vor der Installation überprüft werden, um Manifest und Berechtigungen einzusehen:

```sh
plur1bus ext inspect <path>
```

In der Weboberfläche öffnet **Aus Datei installieren** den Datei-Upload. Das Paket wird vorab geprüft und zeigt
Berechtigungen und Kompatibilität an, bevor die Installation bestätigt wird.

Die Installation direkt aus dem Web-Katalog (`plur1bus.app`) ist in dieser Version noch nicht verfügbar. Die
Weboberfläche zeigt hierzu einen informativen Hinweis statt eines inaktiven Bedienelements an.

## Deinstallieren und wiederherstellen

Eine Erweiterung deinstallieren:

```sh
plur1bus skill uninstall <name>
plur1bus plugin uninstall <name>
```

Beim Deinstallieren wird die Erweiterung in den Papierkorb verschoben, damit sie bei Bedarf wiederhergestellt werden kann.
Der Deinstallations-Dialog in der Weboberfläche bietet Optionen zum Bereinigen von Restdaten oder zur kaskadierenden
Entfernung abhängiger Komponenten.

Eine deinstallierte Erweiterung anhand ihrer Papierkorb-Kennung wiederherstellen:

```sh
plur1bus skill restore <trash_id>
plur1bus plugin restore <trash_id>
```
