# Remote-Zugriff

Unter **Settings → Devices & Remote** wählst du `local`, `tailnet` oder `network`. Standard ist `tailnet`: Tailscale muss installiert und angemeldet sein. Fehlt es, zeigt Doctor die Ursache; die API öffnet keinen Ersatz-Netzwerklistener. `local` blendet die Pairing-Karte aus.

Owner und Admin richten zunächst lokal TOTP oder einen Passkey ein. Für Remote-Anmeldungen ist der zweite Faktor standardmäßig Pflicht. Ein lokal ohne zweiten Faktor erstelltes Cookie reicht dort nicht aus.

Für `network` brauchst du eine HTTPS-Adresse, TLS und die ausdrückliche Bestätigung des Sicherheitshinweises. Selbstsignierte Zertifikate werden erzeugt; alternativ lädst du Zertifikat und passenden privaten Schlüssel als PEM hoch. Bestehende Zertifikate werden zunächst vorgemerkt. Der Schlüssel bleibt privat auf dem Server. Beschränke zulässige Client-Netze bei Bedarf über CIDRs. Starte nach einer Konfigurationsänderung die API beziehungsweise den Daemon neu; nur den Core neu zu starten genügt nicht. `1staid check` meldet bei aktivem `network` eine Warnung.

Öffne anschließend einen Pairing-Code. Verwende den QR-Code/Deep-Link mit Fingerprint oder gib den Code im unterstützten Client ein. Der Client muss vor dem Senden des Codes den Zertifikatsnachweis überprüfen. Bei geändertem Zertifikat nicht einfach die Warnung übergehen. Ein Code ist einmalig und läuft ab.

Für einen Zertifikatswechsel wähle zuerst **Stage**. Geräte erhalten das nächste Vertrauen über ihre bestehende Verbindung und bestätigen es mit ihrem Geräteschlüssel. Aktiviere erst anschließend. Geräte, die die Ankündigung verpasst haben, müssen erneut gekoppelt werden. Die API wird niemals über Funnel öffentlich geteilt.
