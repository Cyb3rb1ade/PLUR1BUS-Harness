# Unabhängiges Review: Event-Audience (#492)

| | |
|---|---|
| **Thema** | Event-Audience: Bindung der Agent-Telemetrie an RBAC-Rechte (M6 Phase 0, #492) |
| **Geprüfter Commit / Branch** | `origin/main` @ `2b5a435c0` (PR #492 gemergt in `326da4c2b`) |
| **Datum** | 2026-10-18 |
| **Reviewer** | agy (unabhängiger Reviewer; hat den Code nicht verfasst) |
| **Empfehlung an den Owner** | **nicht abnahmefähig** (2 Major Befunde: Event-Schwall trennt unbeteiligte Verbindungen; DoS auf Approval-Benachrichtigungen) |

---

## 1. Übersicht und Abnahmekriterien

In PR #492 wurde die Filterung von Telemetrie- und Agent-Events an der IPC- und API-Schnittstelle überarbeitet.
Ziel war es, dass Abonnenten nur die Events erhalten, für die sie nach aktuellen RBAC-Rechten (`agent.read`) autorisiert sind, und dass private Events (`approval.*`, `grant.*`) nicht an unberechtigte Verbindungen leaken.

### Abnahmekriterien & Prüfpunkte:
1. **RPC-Server-Warteschlange & Reihenfolge:** Asynchrone Identity-/Rechte-Prüfung serialisiert über `c.notifications = c.notifications.then(...)`. Reihenfolge bleibt gewahrt. (Erfüllt)
2. **Snapshot der passenden Abos vor dem Limit:** Synchroner Snapshot von `eligible` Subscriptions vor Einreihung in die asynchrone Warteschlange. (Erfüllt, aber fehlerhafte Vorfilterung, siehe M1)
3. **`canReadAgent` & agentId-Targets:** Prüfung von `agent.read` für getypte `{ agentId }`-Ziele bei Subskription und bei Zustellung. (Erfüllt)
4. **Isolierung privater Events (Approval / Grant):** Kein Leak an unberechtigte Dritte. (Erfüllt, aber durch DoS-anfällige Fail-Closed-Logik erkauft, siehe M2)
5. **Schwall-Schutz & Verbindungs-Trennung:** Trennt ein Event-Schwall unbeteiligte Verbindungen? (**Nicht erfüllt / Verletzung**, siehe M1)

---

## 2. Ausgeführte Tests & Verifikation

Folgende Tests wurden lokal auf `2b5a435c0` ausgeführt:
- `packages/module-api/test/agent-audience.test.ts` (14 Tests, alle bestanden)
- `packages/module-api/test/notify-eligibility.test.ts` (15 Tests, alle bestanden)
- `packages/core/test/event-audience-sse.test.ts` (1 Test, bestanden)
- `packages/core/test/approvals/notify-transport.test.ts` (1 Test, bestanden)
- `packages/api/test/agent-events.test.ts` (3 Tests, alle bestanden)

---

## 3. Befunde

### Blocker
Keine.

### Major

#### M1 — Event-Schwall für einen Agenten trennt unbeteiligte Verbindungen (`packages/module-api/src/rpc-server.ts:306-309`)
- **Datei:Zeile:** `packages/module-api/src/rpc-server.ts:306-309`
- **Begründung:** 
  In `notify(method, params, opts)` wird für jede aktive Verbindung geprüft, ob eine Subskription existiert, die auf den Methodennamen passt:
  ```ts
  const eligible = [...c.subs.values()].filter(sub => opts.optIn ? sub.names?.includes(method) : !sub.names || sub.names.includes(method));
  if (!eligible.length) continue;
  if (c.pendingNotifications >= MAX_PENDING_NOTIFICATIONS) { c.sock.destroy(); continue; }
  c.pendingNotifications++;
  ```
  Hierbei wird **weder** `sub.agentId` **noch** `opts.audience` berücksichtigt!
  Wenn Verbindung B ein Abonnement ohne `names` (Wildcard) oder für ein Event mit `sub.agentId: "agent-b"` besitzt, und nun ein Schwall von 1.025 Events für `agent-a` (`audience: [{ agentId: "agent-a" }]`) abgefeuert wird, zählt `c.pendingNotifications` für Verbindung B hoch, obwohl Verbindung B keines dieser Events erhalten darf (die Filterung geschieht erst später asynchron in Zeile 329).
  Erreicht `c.pendingNotifications` das Limit von 1.024, wird `c.sock.destroy()` aufgerufen und Verbindung B getrennt.
- **Reproduzierbarer Test (Probe):**
  ```ts
  // Reproduktions-Probe: Verbindung B abonniert nur agent-b.
  // Ein Schwall von Events für agent-a trennt Verbindung B!
  await connB.call("events.subscribe", { agentId: "agent-b", names: ["recall.completed"] });
  for (let i = 0; i < 1025; i++) {
    server.notify("recall.completed", { text: "data" }, { audience: [{ agentId: "agent-a" }] });
  }
  await new Promise(r => setTimeout(r, 100));
  assert.equal(connBClosed, true, "Unbeteiligte Verbindung wurde getrennt!");
  ```
- **Abhilfe:** `sub.agentId` und offensichtlich disjunkte `opts.audience`-Targets müssen bereits in Zeile 306 synchron vor der Erhöhung von `pendingNotifications` gefiltert werden.

#### M2 — DoS auf Approval-Benachrichtigungen durch fremde Subskriptionen (`packages/core/src/approvals/notify.ts:48-69`)
- **Datei:Zeile:** `packages/core/src/approvals/notify.ts:48-69`
- **Begründung:**
  In `deliver()` sammelt der Notifier alle Verbindungen, die `approval.requested` abonniert haben. Anschließend iteriert er über diese Verbindungen und prüft, ob **jede einzelne** Verbindung berechtigt ist:
  ```ts
  if (!allowed) { log("notification withheld: an opted-in connection may not receive it", { method, connectionId }); return; }
  ```
  Wenn ein Agent oder ein beliebiger Benutzer ohne Zugriffsrecht auf das Approval `events.subscribe({ names: ["approval.requested"] })` aufruft, schlägt `allowed` für diese Verbindung fehl. Daraufhin bricht die gesamte Methode ab und das Event wird für **alle** Verbindungen (auch für den berechtigten Benutzer) unterdrückt!
  Zudem ruft `approvals/notify.ts:69` `o.notify(method, params, { optIn: true })` ohne `opts.audience: [{ personId: person }]` auf, wodurch der RPC-Server die Benachrichtigung nicht gezielt an die passende Verbindung zustellen kann.
- **Reproduzierbarer Test (Probe):**
  ```ts
  const notifier = createPermissionNotifier({
    subscriptions: () => [
      { connectionId: "conn-user", names: ["approval.requested"] },
      { connectionId: "conn-agent", names: ["approval.requested"] },
    ],
    notify: () => { notified = true; },
    principalOf: async (id) => id === "conn-user" ? { kind: "person", userId: "u1", role: "owner" } : { kind: "agent", agentId: "a1" },
    ...
  });
  notifier.events.emit("approval.requested", { approval: { ... } });
  await notifier.idle();
  assert.equal(notified, false); // Bestätigt: Notification wurde für den Benutzer blockiert!
  ```
- **Abhilfe:** `createPermissionNotifier` sollte `opts.audience: [{ personId }]` an `server.notify` übergeben, anstatt bei unberechtigten Dritt-Abonnenten die Benachrichtigung global zu unterdrücken.

### Minor / Nit
- **m1 (Minor) — Web-SSE empfängt keine Approval-Events über RPC:** Da `approvals/notify.ts` kein `audience` mitgibt, ist `delivery.audience === null`. In `packages/api/src/events-route.ts:14` werden Events ohne Audience verworfen (`if (delivery.audience === null) return GLOBAL_WEB_EVENTS.has(method)`). Web-Clients erhalten Approval-Updates daher nur indirekt über `inbox.changed`.

---

## 4. Fazit und Empfehlung

PR #492 schließt das Ausspähen fremder Agent-Telemetrie erfolgreich ab. Allerdings führen die synchrone Queue-Logik in `rpc-server.ts` und die Fail-Closed-Verarbeitung in `approvals/notify.ts` zu schweren Denial-of-Service-Schwachstellen (M1 und M2).
**Empfehlung: Nicht abnahmefähig**, bis M1 und M2 behoben sind.
