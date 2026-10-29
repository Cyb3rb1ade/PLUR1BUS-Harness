# OAuth 2.1 Autorisierungsserver

**Status:** M6-A · **Companion:** [ADR-007](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/adr/ADR-007-users-roles-identity.md), [ADR-008](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/adr/ADR-008-protocols-mcp-acp-a2a.md), [mcp-server.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/mcp-server.md), [security.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/security.md), [api.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/api.md).

Der PLUR1BUS-Harness enthält einen integrierten OAuth 2.1 Autorisierungsserver (`packages/api/src/oauth`). Er ermöglicht externen Anwendungen (wie MCP-Clients oder Entwicklungsumgebungen), zeitlich begrenzte Zugriffstoken mit gebundenen Rechten sicher über einen standardisierten Autorisierungsablauf im Browser zu beziehen.

## Architektur und Standards

Der Autorisierungsserver implementiert den aktuellen Stand der OAuth-Spezifikationen:

* **OAuth 2.1 Draft:** Strengere Sicherheitsregeln gegenüber OAuth 2.0. Kein Implicit Grant, kein Resource Owner Password Credentials Grant, verpflichtendes PKCE.
* **RFC 8414:** Authorization Server Metadata unter `/.well-known/oauth-authorization-server`.
* **RFC 9728:** Protected Resource Metadata unter `/.well-known/oauth-protected-resource`.
* **RFC 7636:** Proof Key for Code Exchange (PKCE) mit zwingender Vorgabe `code_challenge_method=S256`. Die veraltete Methode `plain` wird strikt abgewiesen.
* **RFC 7009:** Token Revocation unter `/oauth/revoke`.
* **Draft-ietf-oauth-client-id-metadata-document:** Dynamische Auflösung von Client-Metadaten über HTTPS-URLs als `client_id`.

## Endpunkte

### 1. Metadaten-Endpunkte

* **`GET /.well-known/oauth-authorization-server`:** Liefert die Server-Metadaten mit Endpunkten, unterstützten Scopes, Grant-Typen und PKCE-Methoden.
* **`GET /.well-known/oauth-protected-resource`:** Liefert Metadaten geschützter Ressourcen (RFC 9728). Unterstützt den Abfrageparameter `?resource=...` zur Filterung auf `/mcp` oder `/a2a`.

### 2. Autorisierungsendpunkt

* **`GET /oauth/authorize`:**
  * Prüft die Client-Identität und die registrierten `redirect_uris`.
  * Verlangt eine aktive Benutzersitzung. Ist der Benutzer nicht angemeldet, erfolgt eine Weiterleitung auf `/login`.
  * Erzwingt bei Zugriff über externe Schnittstellen (`remote`) eine frische Zwei-Faktor-Authentifizierung (Schritt 2FA).
  * Bei Bestätigung (`approve=true`) wird ein einmaliger Autorisierungscode ausgestellt (Gültigkeit: 10 Minuten) und die Weiterleitung zur Callback-URL durchgeführt.
  * Andernfalls wird der Benutzer zur Zustimmungsseite (`/consent`) geleitet.
* **`POST /oauth/authorize`:** Nimmt die Entscheidung des Benutzers auf der Zustimmungsseite entgegen. Bei Ablehnung erfolgt eine Weiterleitung mit dem Fehlercode `access_denied`.

### 3. Token-Endpunkt

* **`POST /oauth/token`:**
  * **Code-Austausch (`grant_type=authorization_code`):** Tauscht den Autorisierungscode unter Vorlage des `code_verifier` gegen ein Zugriffstoken und ein Refreshtoken. Der Code ist strikt einmalig verwendbar.
  * **Token-Erneuerung (`grant_type=refresh_token`):** Stellt ein neues Zugriffstoken aus und rotiert das Refreshtoken.

### 4. Widerrufs-Endpunkt

* **`POST /oauth/revoke`:** Widerruft ein Zugriffs- oder Refreshtoken gemäß RFC 7009. Antworten liefern stets HTTP 200, unabhängig davon, ob das Token zuvor existierte.

### 5. Verwaltung von Berechtigungen (Grants)

* **`GET /api/v1/oauth/grants`:** Listet alle aktiven OAuth-Grants des angemeldeten Benutzers auf.
* **`POST /api/v1/oauth/grants/revoke`:** Widerruft einen Grant, die gesamte zugehörige Refreshtoken-Familie sowie das aktive Zugriffstoken.

## Sicherheitsmechanismen

### PKCE-Erzwingung
Jede Autorisierungsanfrage muss einen `code_challenge` mit `code_challenge_method=S256` übergeben. Anfragen ohne PKCE oder mit `plain` werden mit `invalid_request` abgewiesen.

### Redirect-URI-Prüfung
* Für reguläre Web-Clients gilt exakter Zeichenkettenvergleich mit den im Client hinterlegten `redirect_uris`.
* Für native Clients auf `http://127.0.0.1` oder `http://localhost` sind dynamische Portnummern zulässig, sofern Pfad und Schema exakt übereinstimmen (RFC 8252).

### Client ID Metadata Documents
Clients können anstelle statischer Registrierung eine vollqualifizierte HTTPS-URL als `client_id` verwenden. Der Server ruft das JSON-Dokument ab und validiert es:
* **SSRF-Schutz:** Der Abruf blockiert Anfragen an private Netzwerke, Loopback-Adressen (`127.0.0.0/8`, `::1`), Link-Local-Adressen (`169.254.0.0/16`) und Cloud-Metadatendienste (`169.254.169.254`).
* Es werden nur `https://`-URLs akzeptiert.

### Refreshtoken-Rotation und Replay-Erkennung
Jedes Refreshtoken kann genau einmal verwendet werden. Bei einer Token-Erneuerung wird das bisherige Refreshtoken entwertet und ein neues erzeugt.
Wird ein bereits verwendetes Refreshtoken erneut eingereicht (Replay-Angriff), widerruft der Server unverzüglich die gesamte Token-Familie (`familyId`) sowie das aktive Zugriffstoken.

### Scope-Isolation
Token werden strikt für eine Zielressource ausgestellt:
* Scopes für MCP (`mcp.read`, `mcp.write`, `memory.*`) können nicht für A2A angefordert werden.
* Scopes für A2A (`a2a.task`) können nicht für MCP angefordert werden.
* Ein Token trägt eine feste Bindung an die Ziel-Audience und den Ziel-Agenten (`binding: { audience, agentId }`). Cross-Resource-Aufrufe werden mit HTTP 401 `invalid-audience` abgewiesen.

## Audit-Ereignisse (D111)

Alle sicherheitsrelevanten Vorgänge werden im manipulationssicheren Audit-Log festgehalten:

| Ereignis | Actor | Target | Detail-Eigenschaften |
|---|---|---|---|
| `oauth.authorize` | Benutzer-ID | `agent:<id>` | `clientId`, `audience`, `scopes` |
| `oauth.token` | `oauth:<clientId>` | `token:<id>` | `clientId`, `audience`, `agentId`, `tokenId` |
| `oauth.refresh` | `oauth:<clientId>` | `token:<id>` | `clientId`, `tokenId`, `familyId` |
| `oauth.revoke` | Benutzer-ID / `oauth:<clientId>` | `token:<id>` | `clientId`, `tokenId` (optional) |
| `oauth.denied` | Benutzer-ID / `anonymous` | `oauth:<clientId>` | `clientId`, `reason` |
