// Seeds for the M3 part 2 screenshots (shots.ts): thin wrappers over the page test fixtures, nothing is modified there.
import type { MockHarnessServer } from "./mock-server.ts";
import { installAgents, world } from "./agents-fixtures.ts";
import { installActivity, installSessions, makeSessions, NOW } from "./activity-fixtures.ts";
import { installLogsMocks, makeLines } from "./logs-fixtures.ts";
import { meta, seedSecrets } from "./secrets-fixtures.ts";
import { seedConfig } from "./settings-config-fixtures.ts";
import { seed as seedSetup } from "./setup-fixtures.ts";
import { seed as seedUsers } from "./users-fixtures.ts";

export { NOW };

export function seedAgents(server: MockHarnessServer): void {
  installAgents(server, world({
    agents: {
      main: { displayName: "Main", createdAt: "2026-09-01T09:00:00.000Z", skills: ["web-search", "calendar"] },
      bernd: { displayName: "Bernd das Bot", createdAt: "2026-09-12T09:00:00.000Z", skills: ["notes"] },
      scribe: { displayName: "Scribe", createdAt: "2026-09-20T09:00:00.000Z", skills: [], state: "archived" },
    },
  }));
}
export const seedGeneral = (server: MockHarnessServer): void => { seedConfig(server.rpc); };
export const seedUsersPage = (server: MockHarnessServer): void => seedUsers(server.rpc);
export function seedSecretsPage(server: MockHarnessServer): void {
  seedSecrets(server.rpc, [meta("anthropic.apiKey"), meta("telegram.token", { backend: "file" }), meta("matrix.accessToken"), meta("openai.apiKey", { updatedAt: "2026-10-05T10:00:00.000Z" })]);
}
export function seedDevices(server: MockHarnessServer): void {
  server.rpc.handle("config.get", () => ({ key: "remote.publish", tier: "advanced", value: "lan", restartClass: "core", restart: "core", revision: "r1" }), { write: false });
}
export const seedLogs = (server: MockHarnessServer): void => { installLogsMocks(server, { lines: makeLines(120), tail: false }); };
export const seedActivity = (server: MockHarnessServer): void => { installActivity(server); };
export const seedSessions = (server: MockHarnessServer): void => { installSessions(server, makeSessions(30)); };
export const seedWizard = (server: MockHarnessServer): void => seedSetup(server.rpc);
