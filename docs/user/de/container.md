# Container

Diese Seite erklärt, wie die Harness als Container läuft: auf einem Mac über Apple Containers oder über Docker, auf
einem Server, einem Heimserver oder einem VPS über Docker. Sie beschreibt außerdem die optionalen Sidecars und die
Befehle, mit denen du den Stack steuerst. Jeder Befehl hier existiert in diesem Build (`docs/cli.md` ist die
vollständige Referenz). Die englische Fassung ist [../en/containers.md](../en/containers.md). Für die Installation
ohne Container siehe [quickstart.md](quickstart.md).

## Wofür das gut ist

Das Harness-Image enthält den Supervisor, den Core und die Kommandozeile `plur1bus` in einem abgeschotteten Container.
Du brauchst es, wenn die Harness auf einem Rechner laufen soll, auf dem du keine Installation im Benutzerverzeichnis
willst, etwa auf einem VPS oder einem Heimserver. Die Installation ohne Container bleibt der normale Weg für
Entwicklung und den eigenen Laptop.

Im Container laufen Dienste mit eingeschränkten Rechten: ein Nutzer ohne Login (UID 10001), ein Dateisystem, das
nur für den Zustand beschreibbar ist, keine zusätzlichen Linux-Rechte und keine neuen Rechte für Prozesse. Die
Zustandsdaten liegen in einem Volume des Container-Systems und überleben Neustarts und Image-Updates.

## Runtime: Apple Containers oder Docker

Die Harness kann zwei Container-Laufzeiten nutzen:

- **Apple Containers** (Version 1.5.0) auf macOS 26 oder neuer auf Apple-Silicon-Macs. Bei `auto` wird diese Laufzeit
  bevorzugt, auch wenn ein Dienst erst aktiviert werden muss.
- **Docker** als Alternative. Erkannt werden Docker Desktop, OrbStack, Colima, Docker-Kontexte und rootlose
  Podman-kompatible Sockets. Unter Windows wird die Docker-Named-Pipe genutzt.

Ist ein Runtime nicht installiert, zeigt der Plan den offiziellen Download und die Lizenz. Den Download startet die
Installation nur mit einer eigenen Zustimmung (`--accept-runtime-download`). Die Harness führt die Installer des
Herstellers nicht selbst aus: du schließt die Installation des Herstellers ab und wiederholst den Befehl.

Eine Remote-Docker-Verbindung braucht TLS. Die Zertifikatspfade kommen aus `DOCKER_CERT_PATH` und werden nicht
gespeichert.

Unter Windows ist die Named-Pipe-Anbindung noch nicht nativ auf Windows geprüft. Die Tests liefen auf einem Mac mit
Apple Containers und mit Docker.

## Installation

Zuerst zeigt der Plan, was passieren würde, ohne etwas zu ändern:

```sh
plur1bus install --container --container-plan
```

Danach installierst du, interaktiv mit Rückfrage oder ohne Rückfrage:

```sh
plur1bus install --container
plur1bus install --container --non-interactive
```

Das gleiche Ergebnis erreichst du über `setup`:

```sh
plur1bus setup --container --image <digest-pinned-image> --non-interactive
```

Die Optionen im Überblick:

- `--runtime auto|apple|docker` wählt die Laufzeit. Ohne Angabe gilt `containers.runtime`. Eine ausdrücklich gewählte
  Laufzeit, die nicht verfügbar ist, wird abgelehnt, sie fällt nicht still auf eine andere zurück.
- `--image <ref>` nennt das Image. Für den Betrieb verwendest du eine Digest-Referenz (`…@sha256:…`), kein Tag.
- `--image-from <archive>` lädt ein Image aus einem Archiv, für Installationen ohne Netz. Das Archiv muss die
  Referenz enthalten, die du mit `--image` angibst.
- `--sidecar <id>=bundled|off|<url>` legt fest, wie ein Sidecar läuft (siehe unten).
- `--container-manifest <datei-oder-url>` nutzt einen anderen signierten Feed. Ohne Image und ohne Manifest nimmt die
  Installation das Image aus dem signierten Stable-Kanal, mit `--channel beta` aus dem Beta-Kanal.

Die Installation schreibt `container-install.json` mit Stack, Laufzeit, Version und Gesundheitsfrist. Sie nimmt eine
Sperre auf dem Host, damit zwei Läufe nicht gegeneinander arbeiten.

## Den Stack steuern

```sh
plur1bus --json container status
plur1bus --json container up
plur1bus --json container down
plur1bus container logs
plur1bus --json container logs plur1bus-harness
```

- `status` zeigt Laufzeit und Zustand des Stacks. Es ist nur lesend.
- `up` startet den Stack und wartet, bis er gesund ist. Ein zweiter Aufruf läuft ohne Schaden durch.
- `down` stoppt und entfernt die Container des Stacks. Die Zustands-Volumes bleiben erhalten, deine Daten also auch.
- `logs` zeigt die Logs eines Dienstes, Standard ist `plur1bus-harness`. Mit `--json` kommt ein JSON-Dokument pro Zeile.

Der Befehl `container` arbeitet nur mit Containern, die zu dieser Installation gehören. Fremde Container oder Netze
fasst er nicht an.

## Die Harness-API ist nicht von außen erreichbar

Die Container-Installation veröffentlicht keinen Port der Harness. Der aktuelle Core spricht über eine
authentifizierte Unix-Verbindung innerhalb des Containers. Ein Zugriff von außen ist damit in diesem Build nicht
vorgesehen.

Der Schlüssel `containers.bindAddress` existiert für einen späteren HTTP-Listener. Er lehnt die Adressen `0.0.0.0` und
`::` ab, akzeptiert also nur Loopback- oder private LAN-Adressen. Heute veröffentlicht die Installation aber keinen
Port, daher hat der Schlüssel in diesem Build keine Wirkung nach außen.

## Sidecars

Sidecars sind Dienste neben der Harness. Es gibt zwei:

- `searxng`, eine Suchmaschine, die die Installation betreiben oder an die sie einen fremden Dienst anbinden kann.
- `valkey`, ein Speicherdienst, den SearXNG als Abhängigkeit braucht. Läuft SearXNG gebündelt, wird Valkey mitgestartet,
  sofern du nichts anderes angibst.

Jeder Sidecar hat einen von drei Modi:

- `bundled`: die Installation startet den Dienst als Container auf demselben Host.
- `remote`: der Dienst läuft auf einem anderen Rechner, etwa über Tailscale. Eine Adresse ohne Zugangsdaten reicht,
  zum Beispiel `http://100.64.0.10:8080`. Für Valkey gilt das Schema `valkey://HOST:PORT/0`. Die Installation startet
  dann keinen lokalen Container dafür. Ist der Dienst nicht erreichbar, bricht die Installation vor dem Start des
  Stacks ab.
- `off`: der Dienst bleibt aus. Es wird weder ein Container gestartet noch eine Gesundheitsprüfung gemacht.

```sh
plur1bus install --container --image <digest-pinned-image> --sidecar searxng=bundled
plur1bus install --container --image <digest-pinned-image> --sidecar searxng=http://100.64.0.10:8080
plur1bus install --container --image <digest-pinned-image> --sidecar searxng=off
```

Ein gebündeltes SearXNG mit entferntem Valkey wählst du so:

```sh
plur1bus install --container --image <digest-pinned-image> --sidecar valkey=valkey://100.64.0.20:6379/0
```

Sidecars veröffentlichen keinen Port auf dem Host. Die Installation erzeugt eine private Konfiguration für den Dienst
mit einem zufälligen Suchgeheimnis und hängt sie schreibgeschützt ein.

Für HTTPS-Dienste kannst du ein eigenes CA-Bündel (`caBundle`) und einen Fingerabdruck (`fingerprint`, SHA-256 des
Zertifikats) angeben. Der Fingerabdruck prüft nur die Gesundheitsprüfung der Installation. Wenn die Harness selbst mit
dem Dienst spricht, muss sie dieselbe Vertrauensregel anwenden. Die Gesundheitsprüfung nutzt keinen Proxy und folgt
keinen Weiterleitungen.

## Konfiguration

Die Container-Einstellungen stehen in `config.json`. Die Schlüssel mit ihrem Standard:

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `containers.runtime` | `auto` | `auto`, `apple` oder `docker` |
| `containers.image` | leer | Image-Referenz, im Betrieb mit Digest |
| `containers.stateVolume` | `plur1bus-state` | Name des Zustands-Volumes |
| `containers.bindAddress` | `127.0.0.1` | Bindeadresse für einen späteren HTTP-Listener, siehe oben |
| `containers.healthTimeoutMs` | `120000` | Zeit, die ein Dienst für seinen Gesundheitstest hat |
| `sidecars.<id>.mode` | `off` | `bundled`, `remote` oder `off` |
| `sidecars.<id>.url` | leer | Pflicht bei `remote`, ohne Zugangsdaten |
| `sidecars.<id>.caBundle` | leer | PEM-Datei für HTTPS-Dienste |
| `sidecars.<id>.fingerprint` | leer | `sha256:` plus 64 Hex-Zeichen, nur für selbstsignierte Zertifikate |
| `sidecars.<id>.timeoutMs` | `5000` | Zeitlimit der Gesundheitsprüfung bei `remote` |

Ein Beispiel:

```json
{
  "schemaVersion": 1,
  "containers": { "runtime": "auto", "healthTimeoutMs": 120000 },
  "sidecars": {
    "searxng": { "mode": "remote", "url": "http://100.64.0.10:8080", "timeoutMs": 5000 },
    "valkey": { "mode": "off" }
  }
}
```

Die Schlüssel `containers.*` und `sidecars.*` sind im Schema als „advanced" und `live` eingestuft (`x-tier`,
`x-restart`). Welche Änderung den laufenden Stack tatsächlich neu aufbaut, ist im Code nicht als Regel dokumentiert.
Prüfe nach einer Änderung mit `plur1bus --json container status`.

## Updates

Außerhalb des Containers aktualisiert `plur1bus update` das Programm wie gewohnt. Auf einem Host mit
`container-install.json` aktualisiert `update` dagegen das Image, nicht die Programmdatei. Die Reihenfolge:
das neue Image wird gezogen, bevor der alte Container gestoppt wird, das Zustands-Volume bleibt, und der neue
Container muss gesund werden. Schlägt das fehl, wird der alte Stand wiederhergestellt.

```sh
plur1bus update --plan --manifest stable.json
plur1bus update --yes --manifest stable.json
plur1bus update status
plur1bus update --rollback
```

Im Container selbst antworten `setup` und `update` mit `container-managed`. Ein Update führst du dann am Host aus.

Ein Update, das das Schema des Speichers ändert, lehnt der Image-Updater ab. Ein altes Image kann eine Datenmigration
nicht rückgängig machen. Dafür braucht es eine eigene Sicherung und Migration (siehe [operations.md](operations.md)).

## Was es noch nicht gibt

- Ein öffentliches, frei ladbares Image. Veröffentlichte Pakete sind privat, bis das Release es freigibt.
- Einen eigenen Init-Prozess der Harness als PID 1. Der Container nutzt bis dahin `init` (tini).
- Eine HTTP-API und ein HTTP-Gesundheitstest.
- Eine Suche für den Agenten. Die Sidecars stellen Dienste bereit, sie binden sich aber nicht an den Core an.

## Weiter

- [quickstart.md](quickstart.md): Installation ohne Container, erste Schritte.
- [operations.md](operations.md): Verzeichnisse, Logs, Aktualisieren und Fehlersuche.
- [bestaetigung-betriebssystem.md](bestaetigung-betriebssystem.md): Warum manche Freigaben eine Bestätigung des Betriebssystems brauchen.
