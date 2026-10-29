# MCP-Server: Bereitstellung von Harness-Funktionen für externe Hosts

**Status:** M6-A · **Companion:** [ADR-008](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/adr/ADR-008-protocols-mcp-acp-a2a.md), [oauth.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/oauth.md), [host-adapters.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/host-adapters.md), [rbac.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/rbac.md), [security.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/security.md), [api.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/api.md).

Der MCP-Server des PLUR1BUS-Harness stellt Funktionen (Memory-Recall, Agent-Turns, Skills) für externe MCP-Hosts (wie Claude Desktop, Cursor, Codex CLI oder benutzerdefinierte Clients) bereit.

## Architektur und Laufzeit

Der MCP-Server läuft direkt in der API (`packages/api/src/mcp`) und im Core (`packages/core/src/mcp`), ohne externen Prozess, ohne zusätzlichen Daemon und ohne `uv` (Owner-Vorgabe).

* **HTTP-Endpunkt:** `POST /mcp` verarbeitet JSON-RPC-Anfragen beider Protokoll-Ären.
* **stdio-Bridge:** Der Befehl `plur1bus mcp serve [--agent <id>]` stellt einen stdio-Transport bereit. Gemäß Festlegung 9 leitet die Bridge stdio-Anfragen transparent über `run/api.json` an den HTTP-Endpunkt `/mcp` weiter. Damit existiert im Gesamtsystem genau eine Server-Implementierung für Autorisierung, Rate-Limiting, Tool-Ausführung und Audit.
* **Authentifizierung der Bridge:** Stdio nutzt das Umgebungstoken `PLUR1BUS_MCP_TOKEN`. Auf `stdout` fließen ausschließlich JSON-RPC-Nachrichten; Diagnostik und Logs verbleiben strikt auf `stderr`.

## Dual-Ära Protokollunterstützung

Der Endpunkt `/mcp` unterstützt zwei Protokoll-Ären:

### 1. Moderne Ära (MCP 2026-07-28)

* **Stateless HTTP:** Vollständig zustandslos über HTTP `POST /mcp`. Das Schließen der Verbindung bricht laufende Vorgänge über `AbortSignal` ab.
* **Pflicht-Header:**
  * `Mcp-Protocol-Version: 2026-07-28`
  * `Mcp-Method: <method>` (muss exakt mit `rpc.method` übereinstimmen)
  * `Mcp-Name: <tool>` bei `tools/call`
  * `Mcp-Param-<name>: <value>` bei Tool-Parametern mit Header-Annotation
  * Bei fehlenden oder abweichenden Headern antwortet der Server mit Fehlercode `-32020`.
  * Bei unbekannten Protokollversionen antwortet der Server mit `-32022`.
* **Metadaten:** `_meta["io.modelcontextprotocol/protocolVersion"]` muss mit der Header-Version übereinstimmen.
* **Antwortstruktur:** Antworten deklarieren `resultType: "complete"`, `ttlMs: 60000` und `cacheScope: "private"`.
* **Deterministische Reihenfolge:** Werkzeuge in `tools/list` sind deterministisch alphabetisch nach Namen sortiert.
* **HTTP-Semantik:** Notifications (ohne `id`) werden mit HTTP 202 beantwortet. `GET` und `DELETE` werden mit HTTP 405 Method Not Allowed (`Allow: POST`) abgewiesen.

### 2. Ältere Ära (MCP 2025-11-25 und älter)

* Anfragen mit `initialize` oder älteren Versionen werden über das zustandslose v1-SDK (`@modelcontextprotocol/sdk` 1.32.1 mit `StreamableHTTPServerTransport`) abgewickelt.
* Keine Unterstützung veralteter oder riskanter Protokollmerkmale: Kein Sampling, keine Roots, kein Server-Logging und keine Elicitation.

## Werkzeuggruppen

Werkzeuge sind modular in Gruppen gegliedert:

| Gruppe | Werkzeuge | Beschreibung |
|---|---|---|
| `memory` | `memory_recall`, `memory_store` | Abruf von Erinnerungen des gebundenen Agents mit automatischer Maskierung von Geheimnissen und PII (IBAN, Kartennummern). `memory_store` steht nur bei expliziter Autorisierung nach Festlegung 5 zur Verfügung. |
| `agent` | `agent_ask`, `agent_status` | Starten eines externen Agenten-Turns (`agent_ask`) mit Streaming-Fortschritt sowie Abfrage des Agentenzustands (`agent_status`). |
| `skills` | `skills/list`, `skills/get`, `resources/read` | MCP-Skills nach `io.modelcontextprotocol/skills`. Freigabe nur für dem Agent explizit zugeordnete Skills; Zugriff auf Ressourcen beachtet Pfad-, Größen- und Geheimnisgrenzen (kein Zugriff auf `.env*` oder sensitive Dateien). |

## Konfiguration und Freigabe

Der MCP-Server ist standardmäßig vollständig deaktiviert (deny-by-default):

```json
{
  "mcpServer": {
    "enabled": false
  },
  "agents": {
    "bernd": {
      "mcpServer": {
        "exposed": true,
        "groups": ["memory", "agent", "skills"]
      }
    }
  }
}
```

* `mcpServer.enabled`: Globaler Schalter (Standard: `false`, Tier: `advanced`, Live-Restart).
* `agents.<id>.mcpServer.exposed`: Agent-spezifischer Schalter (Standard: `false`).
* `agents.<id>.mcpServer.groups`: Liste aktiver Werkzeuggruppen (Standard: `["memory", "agent", "skills"]`).

## Authentifizierung und Agenten-Bindung

Jeder Aufruf von `/mcp` erfordert ein persönliches API-Token mit spezifischer Protokollbindung. Token können manuell über `POST /api/v1/tokens` oder automatisiert über den OAuth 2.1 Autorisierungsablauf ([oauth.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/oauth.md)) bezogen werden:

* **Token-Bindung:** Ein Token wird mit `binding: { audience: "mcp", agentId: "<id>" }` ausgestellt.
* **Audience-Prüfung:** Ein Token für `audience: "a2a"` oder ohne Bindung wird auf `/mcp` abgewiesen.
* **Ressourcen-Metadaten (RFC 9728):** Bei fehlender Authentifizierung antwortet der Server mit HTTP 401 und dem Header `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
* **RBAC-Kontext:** Ein Token agiert als Prinzipal der Art `agent` mit den Rechten des Besitzers, eingeengt auf seine Scopes und den gebundenen Agenten (`agent.use`).

## Rate-Limits und Concurrency

* **Route-Ebene:** Anfragen auf `/mcp` unterliegen standardmäßig der Rate-Klasse `rpc`.
* **Modellgestützte Turns (`agent_ask`):**
  * Zieht Kontingent aus der Rate-Klasse `expensive`.
  * Belegt einen Slot des installationsweiten Limits `expensiveConcurrency` (Standard: 8 gleichzeitige rechenintensive Vorgänge).
  * Bei Überschreitung des Limits oder Erschöpfung der Slots antwortet der Server mit HTTP 429 (`Retry-After`) und schreibt ein Audit-Ereignis `mcp.server.denied`.

## Audit-Trail (D111)

Alle Aufrufe werden im Hash-Chained Audit-Log erfasst. Aus Datenschutzgründen enthalten Audit-Einträge **niemals Argumente oder Ergebnisse** von Werkzeugaufrufen:

* `mcp.server.call`:
  * `actor`: Benutzer- oder Token-Identifikator
  * `target`: `agent:<agentId>`
  * `detail`: `{ "tokenId": "...", "tool": "memory_recall", "agentId": "..." }`
* `mcp.server.denied`:
  * `target`: `agent:<agentId>`
  * `detail`: `{ "tokenId": "...", "tool": "...", "agentId": "...", "reason": "rate-limited" | "agent-not-exposed" | "tool-not-found" | "header-mismatch" | "concurrency-limit" }`
