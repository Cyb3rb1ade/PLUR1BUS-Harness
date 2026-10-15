# M3 Phase 2 — Remote listener and device trust

Baut auf #493 auf. Die Implementierung liegt auf `codex/m3-p2-remote-listener`; Vorgänger und `origin/main` wurden normal gemergt.

## Inventar

Neue API-Dateien trennen Listener/Exec, private Zertifikate, Transportpolitik, Konfigurationsrouten und Pairing/Trust-Controller. Vier private API-Service-RPCs verwenden denselben Core DeviceStore wie die bestehenden Device-RPCs. Schema, generierter Python-Client, OpenAPI, RPC-/API-Dokumentation, DE/EN-Hilfe und Devices & Remote sind ergänzt. `1staid` und Doctor melden Netzwerkexposition beziehungsweise einen fehlgeschlagenen Remote-Start.

## Entscheidungen und Verhalten

`tailnet` bleibt Default. Die API behält ihren gewöhnlichen Loopback-Listener und startet einen separaten privaten Tailscale-Backend-Port. Tailscale fehlt, ist nicht angemeldet, hat eine fremde Serve-Regel oder öffentlichen Funnel: explizite Unavailable-/Doctor-Meldung, kein Netzwerk-Fallback. Eine nichtleere Tailnet-CIDR-Liste wird ausdrücklich verweigert, weil der Proxy nur seine Loopback-Adresse zeigt; dort gelten Tailscale-ACLs. Keine Forwarded-Header liefern Identität oder TLS-Vertrauen.

`network` verlangt TLS, einen bestätigten aktuellen Sicherheitshinweis und eine konsistente HTTPS-Origin/Port-Kombination. Eine Allowlist prüft den wirklichen Socket vor TLS. Der bestätigende Actor kommt aus der authentifizierten Person; die Konfiguration wird auditiert und mit Supervisor-Revision-CAS geändert. Die API beziehungsweise der Daemon muss danach neu starten; nur ein Core-Neustart reicht dem Standalone-API-Prozess nicht.

Owner/Admin brauchen remote einen zweiten Faktor. Das gilt auch für importierte lokale Cookies; persönliche Tokens enthalten keinen Faktornachweis und können diese Pflicht nicht umgehen. TOTP ist verdrahtet; Passkeys kommen im folgenden PR. Loopback bleibt für Enrollment verfügbar.

Private Zertifikate/Schlüssel liegen atomar und mit 0600 vor, inklusive Dateityp-, Eigentümer-, Größen-, Chain-, SAN-, Ablauf- und Key-Match-Prüfung. Neue Materialstände werden getrennt vorgemerkt. Trust wird über den authentifizierten Core-Kanal angekündigt, mit Geräteschlüssel bestätigt und erst dann live gewechselt. Verpasste Geräte werden für erneutes Pairing ausgewiesen; fremde Geräte-IDs bleiben gegenüber Member/Viewer verborgen. Ein Absturz nach dem Live-Wechsel wird aus dem dauerhaften Aktivierungszustand konsistent rekonstruiert.

## Bedrohungstabelle

| Angriff | Schutz | Test |
|---|---|---|
| Unbeabsichtigter Nicht-Loopback-HTTP-/Funnel-Listener | Fail-closed Transportplan, TLS und Notice; feste Tailscale-Argumente | `remote-policy.test.ts`, `remote-runtime.test.ts` |
| Fremder Client trotz Allowlist oder falschem Zertifikat | Socket-CIDR vor TLS; tatsächlicher Leaf-Pin | `remote-runtime.test.ts` |
| Passwort-only Owner/Admin über Remote | Faktor-Gate bei Login und jeder Sitzung/Token-Verwendung | `remote-policy.test.ts` |
| Gefälschter Hinweis-Actor oder verlorenes Config-Update | Authentifizierter Actor, Audit vor CAS | `remote-config.test.ts` |
| Code abgreifen, wiederverwenden oder online erraten | Nonce-only Vorab-Proof, tatsächlicher Client-Leaf/Origin, Argon2, Limits, einmaliger Code/Receipt | `remote-pairing.test.ts`, `remote-pairing-tls.test.ts` |
| Gefälschtes Trust-Ack oder vorzeitiger Wechsel | Ed25519-Key-Possession, gebundene Einmal-Challenge, Announcement vor Activate | `remote-pairing.test.ts`, `remote-pairing-tls.test.ts` |
| Manipulierter privater Trust-/Zertifikatsspeicher | Größen-, Eigentümer-, Typ- und Permission-Prüfung | `remote-pairing.test.ts`, `remote-certificates.test.ts` |
| Operator liest fremden direkten Chat | Metadaten ohne Titel; auditiertes Break-glass und sofortiger Zielhinweis | `chats-core.test.ts` über echte HTTP/Core-Anfragen |

## Owner-Fragen

Zwei explizit geprüfte Bootstrap-Ausnahmen benötigen noch keine Cookie-Session: `pair-proof` erhält nur einen Nonce bei einem Owner-geöffneten Code; `devices/pair` authentifiziert sich durch dessen einmaligen Code plus TLS-Proof-Receipt beziehungsweise signiertes QR-Angebot. Eine ungekoppelte App kann noch keine gekoppelte Identität haben. Beide Wege bleiben ohne offenen Grant geschlossen, sind rate-limitiert und auditiert und erzeugen keine Passwort-Session. Der Proof ist keine TLS-Autorität: der Client muss seinen tatsächlichen Leaf und die konfigurierte Origin selbst vergleichen. Ein veralteter Tailscale-Leaf-Snapshot führt zur Ablehnung.

Native Tailscale-/Desktop-Abnahme bleibt ein ausdrücklich benannter externer TODO-Test. Die gleiche OS-Benutzergrenze ist unverändert akzeptiert. OIDC kommt nach M3. Keine Engine-Änderung, keine neue Abhängigkeit; bestehende RPC_RULES wurden nicht verändert.

## Konflikt-Hotspots

API-Dispatch/Bootstrap-Verdrahtung, Core-Composition, additive RPC-Regeln und Schema, generierte Dokumente, Devices-Seite. Neue Transportlogik bleibt in eigenen Dateien.

## Validierung

Node 24.21: vollständige API-Suite vor dem abschließenden privaten Trust-Reader-Hardening 759 Tests, 751 erfolgreich, 0 Fehler, 4 bestehende Skips, 4 bestehende TODOs. Nach dem Hardening Controller und echte HTTPS/Core-Kopplung 20/20 erfolgreich. Weitere Nachweise: Schema 55/55, Config-Schema 49/49, RBAC/Guard/Pairing-Sweep 620/620, Runtime/Cert/Policy 12/12 und Origin-Port-Negativtest. Echter TLS-Pin-Erfolg/-Fehler, Allowlist, Live-Rotation, einmaliges Pairing und Geräte-Acks wurden ausgeführt. Browser Devices/Remote: 32 unterschiedliche Tests erfolgreich. Rust-`1staid`: 30/30; `pnpm lint` inklusive 99 Script-Tests erfolgreich. `pnpm docs:check` erfolgreich mit kanonischem macOS-`TMPDIR=/private/tmp` (sonst scheitert der bestehende Symlink-/Leerzeichen-Prozesspfad-Test). Kein CI-Polling, kein echtes Tailscale-Publishing auf dem Benutzerrechner.
