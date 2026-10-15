# Lokale Host-Tools und Sandbox-Status

Host-Tools laufen lokal unter der Berechtigungsprüfung des Harness. `exec.run` und Host-Unterprozesse benötigen standardmäßig eine OS-Sandbox. Fehlt die Isolation, wird der Aufruf verweigert; eine Freigabe allein ersetzt sie nicht.

Doctor zeigt Backend und Schutzstärke. macOS verwendet das veraltete `sandbox-exec` (Seatbelt); die aktuelle Policy verbietet Forks und überwacht den Speicher stichprobenartig. Unter Linux wird bubblewrap benötigt; schreibbare Policies bleiben bis zur dynamischen Credential-Sperre gesperrt. Unter Windows fehlt die Restricted-Token-/Job-Object-Implementierung; sandboxpflichtige Prozesse bleiben dort nicht verfügbar. Das Paket ist ein Draft und bietet noch keine vollständige Plattformabnahme.

Nur der Owner darf `tools.sandbox.required=false` setzen. Das erlaubt ausdrücklich ungeschützte Ausführung, wird vor jedem Prozessstart auditiert und erzeugt die Warnung NOT SANDBOXED in Doctor. Einige Hostctl-, Clipboard- und OS-Service-Pfade bleiben bei erforderlicher Sandbox gesperrt.

Apps öffnen oder fokussieren erfordert eine Einmalfreigabe für `apps.launch`. Schließen verwendet `proc.signal` und fordert ein reguläres Beenden an. Paketinstallation, Entfernen und Upgrade liefern derzeit Dry-run-Pläne; sie ändern keine installierten Pakete. Passwort- und Elevation-Wrapper werden ohne unterstützten T3-Pfad verweigert.

Nicht vertrauenswürdige Web-, fremde MCP-/Peer-Tool-Ergebnisse und Dateiergebnisse außerhalb der Roots verunreinigen den Turn (Taint). Die vorhandene Policy suspendiert dann Standing-Grants für externe beziehungsweise taint-sensitive Aktionen. Eine neue gültige Einmalfreigabe bleibt möglich. Der Zustand endet mit dem Turn.

Unter 95 % im Host-Eval oder bei einem Policy-Ausbruch zeigt Models „Eingeschränkte Tool-Nutzung“. Fehlende, über sieben Tage alte, zum Szenariensatz unpassende oder ausschließlich synthetische Nachweise gelten als „nicht geprüft“. Doctor zeigt die Abdeckung der Defaultmodelle. Ein erfolgreicher Fake-Provider-Test qualifiziert kein reales Modell.

Die verbindliche Release-Liste der Defaultmodelle wartet noch auf Owner-Review. Das Release-Gate bleibt geschlossen, bis jedes gelistete Modell passende aufgezeichnete oder Live-Nachweise hat. Die nächtliche Live-Tool-Auswahl verwendet sichere Scratch-Verzeichnisse und simulierte OS-Ports; sie bedient nie deinen Desktop und ersetzt keine OS-Sandbox-Abnahme.
