# Unabhängiges Review: Chat-Modellwahl (#575, #568)

| | |
|---|---|
| **Thema** | Modell- und Reasoning-Auswahl pro Chat (Provider-Stufen, Web-Dropdowns, REST-Endpunkte) (#575, #568) |
| **Geprüfter Commit / Branch** | PR #568 gemergt auf `origin/main` @ `2b5a435c0`; PR #575 auf Branch `origin/feat/chat-model-effort` @ `e15f0d668` |
| **Datum** | 2026-10-18 |
| **Reviewer** | agy (unabhängiger Reviewer; hat den Code nicht verfasst) |
| **Empfehlung an den Owner** | **abnahmefähig mit Auflagen** (Keine Blocker; 2 Minor-Befunde zu Tool-Schleifen-Thinking und Budget-Vorabkalkulation) |

---

## 1. Übersicht und Abnahmekriterien

PR #575 und PR #568 setzen die Owner-Entscheidung vom 17./18.10.2026 um, dass Modell und Reasoning-/Thinking-Stufe pro direktem Chat frei gewählt werden können (auch in Inkognito-Chats).
Hierfür wurden die REST-Routen `GET /api/v1/chats/{sessionId}/model` und `PATCH /api/v1/chats/{sessionId}/model` (Core-Methoden `chat.model.get` und `chat.model.set`) sowie UI-Dropdowns im Chat-Kopf eingeführt.

### Abnahmekriterien & Prüfpunkte:
1. **Sicherheit der REST-Route (`PATCH /api/v1/chats/{id}/model`):**
   - Wird `caller` serverseitig abgeleitet? Ja, die Person stammt aus der authentifizierten Session (`authenticatedPrincipal(ctx)`). Ein im Request-Body übergebener `caller` wird mit HTTP 400 (`unknown chat body field`) abgelehnt. (Erfüllt)
   - Greift CSRF? Ja, `csrf: method !== "GET"` erzwingt das Vorhandensein eines gültigen CSRF-Tokens (Fehler 403 ohne Token). (Erfüllt)
   - Greift Rate-Limiting? Ja, eingestuft unter `rate: "write"`. (Erfüllt)
   - Greift `humanOnly`? Ja, in `packages/core/src/rbac/guard.ts` ist `"chat.model.set"` explizit mit `{ ...rule("chat:write", system), humanOnly: true }` markiert. (Erfüllt)
2. **Sperrung in WebMCP:**
   - Ist WebMCP für `chat.model.set` gesperrt? Ja, `packages/webmcp/src/provider.ts` führt `chat.model.set` zusammen mit `session.model.set` im Set `FORBIDDEN_EXACT`. (Erfüllt)
3. **Durchsetzung von „Nur lokal“:**
   - Kann man ein von „Nur lokal“ gesperrtes Profil setzen? Nein. In `chat-surface.ts:111` wird geprüft:
     `if (option.disabledReason === "local-only") throw new RpcError("E_DENIED", "only local models may be used in this chat", { reason: "local-only" });`
     Ein Setzen wird mit `E_DENIED local-only` abgewiesen. (Erfüllt)
4. **Inkognito-Chats:**
   - Hält ein Inkognito-Chat die Wahl nur im Speicher? Ja, Inkognito-Sessions werden im ephemeren In-Memory-Store gehalten. Datenbank-Prüfungen auf `sessions.sqlite` (`session_model_profiles`) bestätigen, dass keine Zeile persistiert wird. (Erfüllt)

---

## 2. Ausgeführte Tests & Verifikation

Lokal auf Branch `feat/chat-model-effort` ausgeführt:
- `packages/api/test/chats-model.test.ts` (2 Tests, alle bestanden)
- `packages/core/test/session/chat-models.test.ts` (18 Tests, alle bestanden)
- `packages/providers/test/reasoning.test.ts` (14 Tests, alle bestanden)
- `packages/webmcp/test/rbac-matrix.test.ts` (14 Tests, alle bestanden)
- `packages/web/test/chat-model-picker.test.ts` (12 Tests, alle bestanden)

---

## 3. Befunde

### Blocker
Keine.

### Major
Keine.

### Minor / Nit

#### m1 (Minor) — Anthropic: Thinking-Signaturen werden zwischen Tool-Schleifen nicht mitgeführt (`packages/providers/src/anthropic/request.ts:25`)
- **Datei:Zeile:** `packages/providers/src/anthropic/request.ts:25`
- **Begründung:**
  Wenn ein Modell mit Anthropic Thinking ein Werkzeug aufruft und die Antwort in der nächsten Runde an das Modell zurückgegeben wird, verlangt die Anthropic-API, dass die Thinking-Signatur des vorherigen Turns wieder übermittelt wird.
  Da diese Signatur in der Session-Historie noch nicht als strukturierter Block persistiert wird, laufen Folgerunden einer mehrstufigen Tool-Schleife ohne Thinking-Parameter weiter (um API-Fehler 400 zu vermeiden).
- **Auflage / Empfehlung:** Folgeaufgabe einplanen, um Thinking-Signaturen in `ChatMessage.toolCalls` bzw. Transcript-Events abzuspeichern.

#### m2 (Minor) — Budget-Vorabprüfung rechnet mit regulärem `maxTokens` statt angehobenem Thinking-Budget (`packages/core/src/composition/provider.ts:335`)
- **Datei:Zeile:** `packages/core/src/composition/provider.ts:335`
- **Begründung:**
  Bei Modellen mit Thinking-Budget (z. B. Anthropic Claude 3.7 / Extended Thinking oder Gemini Budget) muss `max_tokens` serverseitig über das Thinking-Budget gehoben werden, damit das Modell neben dem Nachdenken auch Text ausgeben kann.
  Die Vorab-Zulassungsprüfung im Budget rechnet derzeit jedoch mit der vom Client ursprünglich angefragten Obergrenze. Reicht das Restbudget zwar für `maxTokens`, aber nicht für das gehobene Thinking-Budget, kann es bei der Abrechnung zu einer Nachbelastung kommen.
- **Auflage / Empfehlung:** Vorabkalkulation im Provider-Guard auf das effektiv gehobene Budget anpassen.

#### m3 (Nit) — Lokaler Chat-Verlaufshinweis verliert sich bei Seiten-Reload
- **Datei:Zeile:** `packages/web/src/pages/chat/model-switch.ts:28`
- **Begründung:** Der Hinweis im Chat-Verlauf („Modell gewechselt: ... · Reasoning: ...“) ist rein flüchtig im Web-Client angelegt und verschwindet nach einem Neuladen der Seite, da kein persistentes Session-Event im Transcript geschrieben wird.

---

## 4. Fazit und Empfehlung

Die Chat-Modell- und Reasoning-Auswahl ist vorbildlich gegen CSRF, Privilege Escalation, Caller-Spoofing und unberechtigten WebMCP-Zugriff abgesichert. Das Verhalten in Inkognito-Chats entspricht vollständig den Vorgaben.
**Empfehlung: Abnahmefähig mit Auflagen** (Auflagen m1 und m2 für nachfolgende Iterationen festhalten).
