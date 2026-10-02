import { invoke } from "@tauri-apps/api/core";
import type { LocaleChoice } from "./i18n.ts";

export type ThemeChoice = "system" | "light" | "dark";
export type Platform = "mac" | "win" | "gnome" | "kde";
export type Settings = { theme: ThemeChoice; locale: LocaleChoice };
export type Connection = { id: string; name: string; kind: "bundled" | "local" | "remote"; origin: string; installationId: string; deviceId: string; tokenHint: string; certPin: string | null; caPin: string | null; nextCertPin: string | null; nextCaPin: string | null; observedCertPin: string | null; pairingNeeded: boolean };
export type TokenStoreKind = "keychain" | "memory-only";
export type ConnectionList = { connections: Connection[]; active: string | null; tokenStore: TokenStoreKind | null };
export type PairRequest = { name: string; origin: string; code: string; repairId: string | null };
export type Paired = { connection: Connection; tokenStore: TokenStoreKind };
export type DesktopTransport = {
  connectionsList(): Promise<ConnectionList>;
  connectionsRename(id: string, name: string): Promise<void>;
  connectionsRemove(id: string): Promise<void>;
  pairCode(request: PairRequest): Promise<Paired>;
  pairLocal(name: string): Promise<Paired>;
  openConnection(id: string): Promise<{ selected: boolean; spa_available: boolean }>;
  appInfo(): Promise<{ platform: Platform }>;
  settingsGet(): Promise<Settings>;
  settingsSet(value: Settings): Promise<Settings>;
};

export const nativeTransport: DesktopTransport = {
  connectionsList: () => invoke("connections_list"),
  connectionsRename: (id, name) => invoke("connections_rename", { request: { id, name } }),
  connectionsRemove: id => invoke("connections_remove", { request: { id } }),
  pairCode: request => invoke("pair_code", { request }),
  pairLocal: name => invoke("pair_local", { request: { name } }),
  openConnection: id => invoke("open_connection", { request: { id } }),
  appInfo: () => invoke("app_info"),
  settingsGet: () => invoke("settings_get"),
  settingsSet: settings => invoke("settings_set", { request: { settings } }),
};
