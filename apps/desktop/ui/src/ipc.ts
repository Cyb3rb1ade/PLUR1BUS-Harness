import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { LocaleChoice } from "./i18n.ts";

export type ThemeChoice = "system" | "light" | "dark";
export type Platform = "mac" | "win" | "gnome" | "kde";
export type Settings = { theme: ThemeChoice; locale: LocaleChoice };
export type Connection = { id: string; name: string; kind: "bundled" | "local" | "remote"; origin: string; installationId: string; deviceId: string; tokenHint: string; certPin: string | null; caPin: string | null; nextCertPin: string | null; nextCaPin: string | null; observedCertPin: string | null; pairingNeeded: boolean };
export type TokenStoreKind = "keychain" | "memory-only";
export type ConnectionList = { connections: Connection[]; active: string | null; tokenStore: TokenStoreKind | null };
export type ConnectionSnapshot = { status: "loading" | "ready" | "error"; data: ConnectionList | null };
export type PairRequest = { name: string; origin: string; code: string; repairId: string | null };
export type Paired = { connection: Connection; tokenStore: TokenStoreKind };
export type HelperStatus={ready:boolean;restarting:boolean;capabilities:string[];grants:string[]};
export type BridgeSettings={enabled:boolean;memoryOnly:boolean;secretsLocked:boolean;secretsState?:"locked"|"unlocked"|"unknown"};
export type DesktopTransport = {
  harnessUpgradeStatus?():Promise<import("./views/settings-version.ts").UpgradeStatus>;
  harnessRollback?(confirmed:boolean):Promise<import("./views/upgrade-progress.ts").UpgradeOutcome|null>;
  upgradeProgress?(onStep:(step:string)=>void):Promise<()=>void>;
  upgradeOutcome?(onOutcome:(outcome:import("./views/upgrade-progress.ts").UpgradeOutcome)=>void):Promise<()=>void>;
  updateSettings?(request?:import("./models/update-model.ts").UpdatePreferences):Promise<import("./models/update-model.ts").UpdateSnapshot>;
  updateCheck?(startup?:boolean):Promise<import("./models/update-model.ts").UpdateSnapshot>;
  updateInstall?():Promise<void>;
  updateSkip?():Promise<import("./models/update-model.ts").UpdateSnapshot>;
  updateLater?():Promise<import("./models/update-model.ts").UpdateSnapshot>;
  updateStoreOpen?():Promise<void>;
  helperStatus?():Promise<HelperStatus>;
  bridgeSettings?(enabled?:boolean):Promise<BridgeSettings>;
  bundleProgress?(onStep:(step:string)=>void):Promise<()=>void>;
  runtimeDetect?(): Promise<import("./models/wizard-model.ts").RuntimeItem[]>;
  bundleCancel?(runtimeId:string):Promise<void>;
  bundleInstall?(runtimeId: string, agreed: boolean): Promise<{connectionId: string}>;
  harnessStart?(memoryGib?: number): Promise<void>;
  harnessStop?(): Promise<void>;
  harnessStatus?(): Promise<{state: string;resources?:{memoryMiB:number}}>;
  harnessStatusEvents?(onStatus:(status:{state:string})=>void):Promise<()=>void>;
  harnessLogsTail?(): Promise<string>;
  autostartGet?(): Promise<boolean | null>;
  autostartSet?(enabled: boolean): Promise<boolean>;
  connectionsList(): Promise<ConnectionList>;
  connectionsRename(id: string, name: string): Promise<void>;
  connectionsRemove(id: string): Promise<void>;
  pairCode(request: PairRequest): Promise<Paired>;
  pairLocal(name: string): Promise<Paired>;
  openConnection(id: string): Promise<{ selected: boolean; spa_available: boolean }>;
  appInfo(): Promise<{ platform: Platform; locale: string }>;
  settingsGet(): Promise<Settings>;
  settingsSet(value: Settings): Promise<Settings>;
};

export const nativeTransport: DesktopTransport = {
 harnessUpgradeStatus:()=>invoke("harness_upgrade_status"),
 harnessRollback:confirmed=>invoke("harness_rollback",{confirmed}),
 upgradeProgress:onStep=>listen<string>("desktop-upgrade-progress",event=>onStep(event.payload)),
 upgradeOutcome:onOutcome=>listen<import("./views/upgrade-progress.ts").UpgradeOutcome>("desktop-upgrade-outcome",event=>onOutcome(event.payload)),
 updateSettings:request=>invoke("update_settings",{request:request??null}),
 updateCheck:startup=>invoke("update_check",{startup:startup??false}),
 updateInstall:()=>invoke("update_install"),
 updateSkip:()=>invoke("update_skip"),
 updateLater:()=>invoke("update_later"),
 updateStoreOpen:()=>invoke("update_store_open"),
  helperStatus:()=>invoke("helper_status"),
  bridgeSettings:enabled=>invoke("bridge_settings",{request:{enabled:enabled??null}}),
  bundleProgress: onStep => listen<string>("desktop-bundle-progress",event=>onStep(event.payload)),
  runtimeDetect: () => invoke("runtime_detect"),
  bundleCancel: runtimeId => invoke("bundle_install",{request:{runtimeId,agreed:true,action:"cancel"}}),
  bundleInstall: (runtimeId, agreed) => invoke("bundle_install", {request:{runtimeId,agreed}}),
  harnessStart: memoryGib => invoke("harness_start",{request:{memoryGib:memoryGib??null}}),
  harnessStop: () => invoke("harness_stop"),
  harnessStatus: () => invoke("harness_status"),
  harnessStatusEvents: onStatus => listen<{state:string}>("desktop-harness-status",event=>onStatus(event.payload)),
  harnessLogsTail: () => invoke("harness_logs_tail"),
  autostartGet: () => invoke("autostart_get"),
  autostartSet: enabled => invoke("autostart_set", {enabled}),
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
