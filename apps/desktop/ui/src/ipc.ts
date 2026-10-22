import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { LocaleChoice } from "./i18n.ts";
import { withDeadline } from "./models/deadline.ts";
import { parseUpdateProgress } from "./models/update-model.ts";

export type ThemeChoice = "system" | "light" | "dark";
export type Platform = "mac" | "win" | "gnome" | "kde";
export type Settings = { theme: ThemeChoice; locale: LocaleChoice };
export type Connection = { id: string; name: string; kind: "bundled" | "local" | "remote"; origin: string; installationId: string; deviceId: string; tokenHint: string; certPin: string | null; caPin: string | null; nextCertPin: string | null; nextCaPin: string | null; observedCertPin: string | null; pairingNeeded: boolean };
export type TokenStoreKind = "keychain" | "memory-only";
export type ConnectionList = { connections: Connection[]; active: string | null; tokenStore: TokenStoreKind | null };
export type ConnectionSnapshot = { status: "loading" | "ready" | "error"; data: ConnectionList | null; timedOut?: boolean };
export type LinkEnvelope = { id: number; intent: {kind: "pair"; origin: string; code: string; pin: string | null; ca: string | null} | {kind: "open"; path: string} | {kind: "chat" | "install" | "p1x" | "ignored"} };
export type PairPrefill = { linkId: number; origin: string; code: string; pin: string | null; ca: string | null };
export type PairRequest = { name: string; origin: string; code: string; repairId: string | null; linkId?: number | null };
export type Paired = { connection: Connection; tokenStore: TokenStoreKind };
export type HelperStatus={ready:boolean;restarting:boolean;capabilities:string[];grants:string[]};
export type BridgeSettings={enabled:boolean;memoryOnly:boolean;secretsLocked:boolean;secretsState?:"locked"|"unlocked"|"unknown"};
export type Vendor="docker"|"podman";
export type InstallOptions={platform:"mac"|"win"|"linux";appleAvailable:boolean;dockerLicence:string|null;podmanLicence:string|null};
export type UninstallLevel="app_only"|"app_and_images"|"everything";
export type UninstallSummary={level:UninstallLevel;containers:string[];images:string[];volumes:{name:string;bytes:number|null}[];removesKeychain:boolean;preservesData:boolean};
export type IntegrationState={kind:"desktop"|"menu"|"store";enabled:boolean};
export type DesktopTransport = {
  desktopIntegrationGet?():Promise<IntegrationState|null>;
  desktopIntegrationSet?(enabled:boolean):Promise<IntegrationState|null>;
  installOptions?():Promise<InstallOptions>;
  runtimeInstallProgress?(step:(step:string)=>void):Promise<()=>void>;
  runtimeInstallApple?(licenceAccepted:boolean):Promise<void>;
  runtimeInstallVendor?(vendor:Vendor,licenceAccepted:boolean):Promise<void>;
  runtimeEnablePodmanSocket?():Promise<void>;
  cliShimInstall?(addToPath:boolean):Promise<void>;
  cliShimRemove?():Promise<void>;
  diagnosticsOpen?():Promise<void>;
  uninstallSummary?(level:UninstallLevel):Promise<UninstallSummary>;
  uninstallRun?(level:UninstallLevel,confirmation:string):Promise<void>;
  uninstallProgress?(step:(step:string)=>void):Promise<()=>void>;

  deepLinkNext?(): Promise<LinkEnvelope | null>;
  deepLinkEvents?(ready: () => void): Promise<() => void>;
  deepLinkOpen?(path: string): Promise<void>;
  harnessUpgradeStatus?():Promise<import("./views/settings-version.ts").UpgradeStatus>;
  harnessRollback?(confirmed:boolean):Promise<import("./views/upgrade-progress.ts").UpgradeOutcome|null>;
  upgradeProgress?(onStep:(step:string)=>void):Promise<()=>void>;
  upgradeOutcome?(onOutcome:(outcome:import("./views/upgrade-progress.ts").UpgradeOutcome)=>void):Promise<()=>void>;
  updateSettings?(request?:import("./models/update-model.ts").UpdatePreferences):Promise<import("./models/update-model.ts").UpdateSnapshot>;
  updateCheck?(startup?:boolean):Promise<import("./models/update-model.ts").UpdateSnapshot>;
  updateInstall?():Promise<void>;
  updateProgress?(onProgress:(progress:import("./models/update-model.ts").UpdateProgress)=>void):Promise<()=>void>;
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
  appInfo(): Promise<{ platform: Platform; locale: string; store_managed?:boolean; sandboxed?:boolean }>;
  settingsGet(): Promise<Settings>;
  settingsSet(value: Settings): Promise<Settings>;
};

export const nativeTransport: DesktopTransport = {
  desktopIntegrationGet:()=>invoke("desktop_integration_get"),
  desktopIntegrationSet:enabled=>invoke("desktop_integration_set",{request:{enabled}}),
  installOptions:()=>invoke("install_options"),
  runtimeInstallProgress:step=>listen<string>("desktop-runtime-install-progress",event=>step(event.payload)),
  runtimeInstallApple:licenceAccepted=>invoke("runtime_install_apple",{request:{licenceAccepted}}),
  runtimeInstallVendor:(vendor,licenceAccepted)=>invoke("runtime_install_vendor",{request:{vendor,licenceAccepted}}),
  runtimeEnablePodmanSocket:()=>invoke("runtime_enable_podman_socket"),
  cliShimInstall:addToPath=>invoke("cli_shim_install",{request:{addToPath}}),
  cliShimRemove:()=>invoke("cli_shim_remove"),
  diagnosticsOpen:()=>invoke("diagnostics_open"),
  uninstallSummary:level=>invoke("uninstall_summary",{request:{level,confirmation:null}}),
  uninstallRun:(level,confirmation)=>invoke("uninstall_run",{request:{level,confirmation}}),
  uninstallProgress:step=>listen<string>("desktop-uninstall-progress",event=>step(event.payload)),

  deepLinkNext: () => invoke("deep_link_next"),
  deepLinkEvents: ready => listen("desktop-link-pending", ready),
  deepLinkOpen: path => invoke("deep_link_open", {request: {path}}),
 harnessUpgradeStatus:()=>invoke("harness_upgrade_status"),
 harnessRollback:confirmed=>invoke("harness_rollback",{confirmed}),
 upgradeProgress:onStep=>listen<string>("desktop-upgrade-progress",event=>onStep(event.payload)),
 upgradeOutcome:onOutcome=>listen<import("./views/upgrade-progress.ts").UpgradeOutcome>("desktop-upgrade-outcome",event=>onOutcome(event.payload)),
 updateSettings:request=>invoke("update_settings",{request:request??null}),
 updateCheck:startup=>invoke("update_check",{startup:startup??false}),
 updateInstall:()=>invoke("update_install"),
 updateProgress:onProgress=>listen<unknown>("desktop-update-progress",event=>{const progress=parseUpdateProgress(event.payload);if(progress)onProgress(progress);}),
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

/** How long the UI waits for the calls that otherwise leave a view loading until the native side answers.
 * Calls that wait for a person get `INTERACTIVE_DEADLINE_MS`: `pair_code` opens the OS credential store (a keychain
 * unlock or consent prompt can be on screen) and needs several network steps of up to 15 s each, so a short deadline
 * would report a timeout while the person is still answering the prompt (owner decision on #716). The others are
 * non-interactive and keep short deadlines: `connections_list` never acquires credentials, `harness_logs_tail` is one
 * runtime call. */
export const INTERACTIVE_DEADLINE_MS = 120_000;
export type Deadlines = { connectionsList: number; pairCode: number; harnessLogsTail: number };
export const DEADLINES: Deadlines = { connectionsList: 20_000, pairCode: INTERACTIVE_DEADLINE_MS, harnessLogsTail: 30_000 };
export function withDeadlines(base: DesktopTransport, limits: Deadlines = DEADLINES): DesktopTransport {
  const logs = base.harnessLogsTail;
  return {
    ...base,
    connectionsList: () => withDeadline(() => base.connectionsList(), limits.connectionsList),
    pairCode: request => withDeadline(() => base.pairCode(request), limits.pairCode),
    ...(logs ? { harnessLogsTail: () => withDeadline(() => logs.call(base), limits.harnessLogsTail) } : {}),
  };
}
