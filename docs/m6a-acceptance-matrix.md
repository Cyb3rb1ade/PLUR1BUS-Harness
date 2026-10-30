# M6-A Protokolle: Abnahmematrix, Spike-Ergebnisse und Schnittstellengrenzen

**Status:** M6-A · **PR:** [#824](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/824) · **Companion:** [mcp-server.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/mcp-server.md), [oauth.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/oauth.md), [a2a.md](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/a2a.md), [ADR-008](file:///Users/cyberblade/worktrees/codex-p-m6a-protocols/docs/adr/ADR-008-protocols-mcp-acp-a2a.md).

Dieses Dokument fasst die Ergebnisse der Spikes A0.1 und A0.2, die 21 Abnahmepunkte inklusive ihrer Testnachweise, die architekturbedingte Engine-Grenze bei Memory-Recall sowie die dokumentierten Abweichungen und Folgepunkte für Paket P (M6-A) zusammen.

---

## 1. Ergebnisse der Spikes A0.1 und A0.2

### Spike A0.1: `@a2a-js/sdk` 1.3.0 Evaluierung
* **Abhängigkeitsprüfung (`docs/dependency-policy.md`):** Exakter Pin auf `@a2a-js/sdk@1.3.0`, Lizenz `Apache-2.0`, Veröffentlichungsdatum `2026-09-29` (> 4 Wochen alt). Peer-Dependencies (`express`, `@grpc/grpc-js`) sind optional und werden im Produktivbetrieb nicht installiert.
* **Architektur-Entscheidungen:**
  1. **Single-Listener Multi-Agent Dispatch:** `DefaultRequestHandler` und `JsonRpcTransportHandler` werden pro exponiertem Agent instanziiert. Ein gemeinsamer `node:http`-Endpunkt bedient `POST /a2a/{agentId}` sowie Discovery unter `/.well-known/agent-card.json` und `/a2a/{agentId}/.well-known/agent-card.json`.
  2. **Express-Freiheit im Kern:** Der Serverkern arbeitet ohne `express`. `TaskStore` und `AgentExecutor` implementieren die SDK-Schnittstellen direkt auf `node:http`.
  3. **Streaming & Backpressure:** `JsonRpcTransportHandler` generiert SSE-Streams. Synchronous Header-Validierung erfolgt vor `res.writeHead(200)`; nachfolgende Chunks beachten `res.write()`-Rückgabewerte und warten auf `drain`.
  4. **Legacy 0.3 Kompatibilität:** Fehlt der `A2A-Version`-Header, verlangt A2A 1.0 standardmäßig `-32009`. Mit `a2aServer.legacy03: true` übersetzt `LegacyJsonRpcTransportHandler` die v0.3-Methoden (`message/send`, `tasks/get` etc.) transparent.
  5. **Extensions:** Erweiterungsmethoden werden vor dem geschlossenen SDK-Switch in einem Pre-Dispatch abgefangen; fehlende Aktivierung im `A2A-Extensions`-Header führt zu `-32008`.
* **Testnachweis:** `packages/api/test/a2a-sdk-spike.test.ts` (5 Tests).

### Spike A0.2: Dual-Ära MCP Server
* **Abhängigkeitsprüfung:** `@modelcontextprotocol/sdk` ist im Workspace auf `1.32.1` (`MIT`) gepinnt.
* **Architektur-Entscheidungen:**
  1. **Moderne Ära (`2026-07-28`):** Zustandsloser Handler (`packages/api/src/mcp/routes.ts`), unterstützt `server/discover`, `tools/list`, `tools/call`. Pflichtprüfung auf `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method` und `Mcp-Name`. Fehlercodes `-32022` (unbekannte Version) und `-32020` (Header-Abweichung).
  2. **Legacy Ära (`2025-11-25`):** `StreamableHTTPServerTransport` mit `sessionIdGenerator: undefined` und `enableJsonResponse: true`. Keine Vergabe von `Mcp-Session-Id`. Standalone `GET` und `DELETE` liefern `405 Method Not Allowed`.
  3. **Invariante:** Lexikografisch deterministische Tool-Sortierung, kein Memory-Leck in Tool-Beschreibungen, strikte Authentifizierung mit Bearer-Token.
* **Testnachweis:** `packages/api/test/mcp-server-spike.test.ts` (2 Test-Suites).

---

## 2. Die 21 Abnahmepunkte und Testnachweise

| Nr. | Bereich | Kriterium | Testnachweis | Status |
|:---:|---|---|---|:---:|
| 1 | MCP | Zwei Clients (Legacy v1 SDK 2025-11-25 und Modern 2026-07-28) bestehen je 3 Prüfungen über stdio und HTTP (initialize/discover, Gruppenfreigabe, memory_recall mit Scope-Filter) | `packages/api/test/mcp-server-spike.test.ts`<br>`packages/core/test/mcp/stdio-server.test.ts` | Bestanden |
| 2 | MCP | Standardmäßig verweigert: `mcpServer.enabled=false` → 404; Agent nicht freigegeben → keine Tools; Token-Agent-Mismatch → 403; fehlendes Schreibrecht verwehrt `memory_store` | `packages/api/test/mcp-routes.test.ts`<br>`packages/api/test/mcp-server.test.ts` | Bestanden |
| 3 | MCP | Protokollhygiene: Origin/Host-Prüfung, Header-Validierung, keine `Mcp-Session-Id`, Bearer mit `resource_metadata`, Cookie-only-Rejection | `packages/api/test/mcp-routes.test.ts`<br>`packages/api/test/mcp-server.test.ts` | Bestanden |
| 4 | MCP | Expositionsmatrix: Kein Zugriff auf `admin.*`, `humanOnly`, Grant-, Freigabe-, Secret-, Config-, Identity- oder Device-Methoden | `packages/api/test/mcp-tools.test.ts`<br>`packages/core/test/mcp/tools.test.ts` | Bestanden |
| 5 | MCP | D109: `agent_ask` mit zustimmungspflichtigem Tool liefert `approval-required` und parkt mit Subjekt `mcp-client` | `packages/api/test/mcp-tools.test.ts` | Bestanden |
| 6 | MCP | Capabilities-Hygiene: Keine Deklaration von Sampling, Roots, Logging oder Elicitation; keine Server-Initiated Requests | `packages/api/test/mcp-server.test.ts`<br>`packages/api/test/mcp-server-spike.test.ts` | Bestanden |
| 7 | MCP | Limits & Redaktion: Rate-Limiting, Payload-Grenzen, Concurrency-Slots für teure Aufrufe, PII/Secret-Redaktion, Audit ohne Argumente/Ergebnisse | `packages/api/test/mcp-routes.test.ts`<br>`packages/api/test/mcp-tools.test.ts` | Bestanden |
| 8 | OAuth 2.1 | Vollständiger Flow gegen Harness: Login, Consent mit Agent/Projekt/Gruppen, PKCE S256, Code/Token-Tausch, Aufruf von `/mcp` mit agent-gebundenem Token | `packages/api/test/oauth.test.ts`<br>`packages/api/test/oauth-routes.test.ts` | Bestanden |
| 9 | OAuth 2.1 | Abweisungen: Fehlendes PKCE oder `code_challenge_method=plain`, ungültige Redirect-URI | `packages/api/test/oauth.test.ts`<br>`packages/api/test/oauth-routes.test.ts` | Bestanden |
| 10 | OAuth 2.1 | Code-Replay-Schutz: Zweifach eingelöster Authorization Code widerruft den gesamten Grant und alle daraus erzeugten Tokens | `packages/api/test/oauth-routes.test.ts` (`M6A-S1`) | Bestanden |
| 11 | OAuth 2.1 | Refresh-Rotation: Atomare Rotation mit Concurrency-Schutz; Replay eines alten Refresh-Tokens widerruft die gesamte Token-Familie | `packages/api/test/oauth-routes.test.ts` (`M6A-S2`) | Bestanden |
| 12 | OAuth 2.1 | Audience/Resource & Scope Bounds: Token für fremde Ressource führt zu 401; Scopes über Personenrechte hinaus sind nicht erteilbar | `packages/api/test/oauth-routes.test.ts` (`M6A-B6`) | Bestanden |
| 13 | OAuth 2.1 | Metadaten RFC 9728 & RFC 8414 aus `publicOrigin`; Authorization Response enthält Pflicht-Parameter `iss` | `packages/api/test/oauth-routes.test.ts` (`M6A-S6`) | Bestanden |
| 14 | OAuth 2.1 | Remote 2FA & Sofort-Widerruf: Owner-Login verlangt 2FA remote; Token-Widerruf via `/oauth/revoke` wirkt sofort auf Access- und Refresh-Tokens | `packages/api/test/oauth-routes.test.ts`<br>`packages/api/test/oauth-service.test.ts` (`M6A-B4`) | Bestanden |
| 15 | A2A 1.0 | Agent Card Discovery: Unter beiden Pfaden (`/.well-known/agent-card.json` und per Agent), gültig nach 1.0-Schema, Ed25519-Signatur aus SecretStore, ohne internen Inhalt | `packages/api/test/a2a-card.test.ts` (`M6A-S8`) | Bestanden |
| 16 | A2A 1.0 | Server Task Lifecycle: `SendMessage`, `SendStreamingMessage` in Erzeugungsreihenfolge, `ListTasks` isoliert nach Aufrufer, `CancelTask` bricht Turn im Core ab | `packages/api/test/a2a-server.test.ts`<br>`packages/api/test/a2a-streaming.test.ts` | Bestanden |
| 17 | A2A 1.0 | Task-Persistenz & Limits: `SqliteTaskStore` mit WAL übersteht Neustart; Quotas pro Peer und Grenzen für Text (64 KiB), Parts (16), History (20) und Output (256 KiB) | `packages/api/test/a2a-server.test.ts` (`M6A-B7`, `M6A-S12`) | Bestanden |
| 18 | A2A 1.0 | Outbound A2A Client: `consult_agent` prüft Egress-Policy (Spy), DNS-Pinning, SSRF-Blockade privater Netze und verweigert unverified Peers | `packages/core/test/a2a/outbound-client.test.ts` | Bestanden |
| 19 | Cross-Protocol | Zero-Leak Invariante: Kein Memory-Inhalt in MCP-Tool-Schemas, `server/discover`, OAuth-Metadaten oder A2A-Agent-Cards | `packages/api/test/protocol-leak.test.ts` | Bestanden |
| 20 | Invariante T0 | Externe Principals besitzen Oberfläche T0 und können keine Freigaben erteilen; Freigaben tragen externes Subjekt | `packages/core/test/rbac/external-principals.test.ts`<br>`packages/core/test/rbac/guard.test.ts` | Bestanden |
| 21 | Invariante Secrets | Tokens, Codes, Signaturschlüssel und Secret-Werte erscheinen nie in Logs, Audit-Einträgen, Fehlermeldungen oder Antworten | `packages/api/test/secret-leak.test.ts`<br>`packages/api/test/a2a-server.test.ts`<br>`packages/api/test/mcp-tools.test.ts` | Bestanden |

---

## 3. Engine-Grenze bei Memory-Recall (`scope-not-enforceable`)

Gemäß Befund B8 und der Vorgabe aus PR #821 gilt für den Memory-Recall über Protokollschnittstellen (MCP und A2A):
* Die in dieser Version gepinnte Memory-Engine kann pro Einzelanfrage serverseitig ausschließlich den `user`-Scope ausblenden.
* Sofern eine Exposure-Policy verlangt, dass `workspace`- oder `agent`-privater Scope unterdrückt werden muss (d. h. wenn der Aufrufer nicht über die entsprechenden Berechtigungen verfügt), kann die Engine dies auf Abfrageebene nicht granular filtern.
* **Fail-Closed Verhalten:** In diesem Fall antwortet der Memory-Port strikt fail-closed mit:
  ```json
  {
    "degraded": {
      "reason": "scope-not-enforceable"
    }
  }
  ```
  Es werden unter keinen Umständen unberechtigte Memory-Einträge an den Aufrufer herausgegeben.

---

## 4. Dokumentierte Abweichungen und Folgepunkte

Folgende Punkte sind für nachfolgende Meilensteine und Refactoring-Schritte vorgemerkt:

1. **Ausgehender A2A-Client (Vollintegration):** Der Client liegt als Kernbibliothek vor (`packages/core/src/a2a/outbound-client.ts`). Die weiterführende Verdrahtung von `DelegationTarget`, dynamischer Kartensignaturprüfung, D109-Einbettung, `localOnly`-Zonierung sowie Budget- und Audit-Limits wird im Zuge des Agent-Bridge-Ausbaus komplettiert.
2. **Legacy 0.3 Codebasis:** Der 0.3-Protokollcode verbleibt als Opt-in (`a2aServer.legacy03: true`) zur Abwärtskompatibilität und wird mit der offiziellen Abkündigung des Altprotokolls bereinigt.
3. **Skills als MCP-Tools:** Skills werden konsistent mit Namensschema `skill/<name>` exponiert und sind in beiden Protokoll-Ären ansprechbar.
4. **ProtocolSseWriter:** Die A2A SSE-Stream-Bridge des SDKs serialisiert Events gegenwärtig über eigene Formatter; die Vereinheitlichung auf den internen `ProtocolSseWriter` folgt.
5. **MCP Disabled Response:** Bei deaktiviertem Server antwortet `/mcp` mit 404 (bzw. 403 auf nicht freigegebenen Agenten).
6. **IBAN-Redaktionsmuster:** Die PII-Regel wurde präzisiert, um Fehlklassifikationen von hexadezimalen Token-Strings zu verhindern.
7. **Relative Core-Src-Imports:** Bestehende relative Pfade zwischen API und Core werden im Rahmen der Modulentkopplung bereinigt.
8. **RPC 1.9.0 Spezifikation:** Sämtliche neuen Methoden für Memory-Sensitivität (`memory.sensitivity.*`) sind sauber in RPC 1.9.0 typisiert und getestet.
9. **OAuth SPA Login-Redirect:** Weiterleitung von `/login?redirect=` im Frontend-Router bei nicht authentifizierter Browser-Sitzung.
