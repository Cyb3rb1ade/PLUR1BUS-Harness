import { createShell } from "../src/shell.ts";
import type { DesktopTransport, Settings } from "../src/ipc.ts";
import { openDialog } from "../src/components/dialog.ts";
import { openQuitDialog } from "../src/views/quit-dialog.ts";
import { openSheet } from "../src/components/sheet.ts";

let settings: Settings = { theme: "system", locale: "system" };
let failNextSave = false;
let failQuit = false;
let autostart: boolean | null;
let autostartFail = false;
const autostartCalls: boolean[] = [];
let deferredSaves = false;
const pendingSaves: Array<{ value: Settings; resolve: (value: Settings) => void; reject: (error: Error) => void }> = [];
const boot = (window as any).__fixtureBoot as { platform?: "mac" | "win" | "gnome" | "kde"; autostartUnknown?: boolean; failGet?: boolean; deferLoad?: boolean; locale?: string; rows?: import("../src/ipc.ts").Connection[]; deferConnections?: boolean; failConnections?: boolean } | undefined;
autostart = boot?.autostartUnknown ? null : false;
let rows: import("../src/ipc.ts").Connection[]=boot?.rows??[];
let active:string|null=null;
let pairingError:string|null=null;
let failConnections=boot?.failConnections??false;
let releaseConnections: (()=>void)|undefined;
const connectionGate = boot?.deferConnections ? new Promise<void>(resolve=>{releaseConnections=resolve;}) : Promise.resolve();
let completeLoads: () => void = () => {};
const loaded = boot?.deferLoad ? new Promise<void>(resolve => { completeLoads = resolve; }) : Promise.resolve();
const transport: DesktopTransport = {
 async autostartGet(){return autostart;},
 async autostartSet(value){autostartCalls.push(value);if(autostartFail)throw new Error("injected autostart error");autostart=value;return autostart;},
 async connectionsList(){await connectionGate;if(failConnections)throw "storage";return {connections:rows,active,tokenStore:"memory-only"};},
 async connectionsRename(id,name){rows=rows.map(row=>row.id===id?{...row,name}:row);},
 async connectionsRemove(id){rows=rows.filter(row=>row.id!==id);},
 async pairCode(request){if(pairingError)throw pairingError;const connection={id:request.repairId??"fixture-row",name:request.name,origin:request.origin,kind:"remote" as const,installationId:"fixture-installation",deviceId:"fixture-device",tokenHint:"hint",certPin:null,caPin:null,nextCertPin:null,nextCaPin:null,observedCertPin:null,pairingNeeded:false};rows=[connection];return {connection,tokenStore:"memory-only"};},
 async pairLocal(){if(pairingError)throw pairingError;throw "denied";},
 async openConnection(id){if(pairingError)throw pairingError;active=id;return {selected:true,spa_available:false};},
  async appInfo() { await loaded; return { platform: boot?.platform ?? "mac", locale: boot?.locale ?? "en-US" }; },
  async settingsGet() { await loaded; if (boot?.failGet) throw new Error("fixture settings read failure"); return settings; },
  async settingsSet(value) {
    if (failNextSave) { failNextSave = false; throw new Error("test write failure"); }
    if (deferredSaves) return new Promise<Settings>((resolve, reject) => pendingSaves.push({ value, resolve, reject }));
    settings = value; return settings;
  },
};
const shellRoot = document.createElement("div");
document.body.append(shellRoot);
const shell = createShell(shellRoot, transport);
Object.assign(window, { testShell: {
  ...shell,
  autostartCalls: () => autostartCalls,
  failAutostart: () => { autostartFail = true; },
  quitDecisions: [] as string[],
  setQuitFailure: (value: boolean) => { failQuit = value; },
  openQuit: () => openQuitDialog({choice:"keep-running",canStopHarness:false}, { confirm: async choice => { if (failQuit) throw new Error("injected rejection"); (window as any).testShell.quitDecisions.push(choice); }, cancel: async () => { (window as any).testShell.quitDecisions.push("cancel"); } }),
  setPairingError:(value:string|null)=>{pairingError=value;},
  setConnections:async(value:import("../src/ipc.ts").Connection[])=>{rows=value;if("refreshConnections" in shell)await (shell as any).refreshConnections();},
  storedConnections:()=>rows,
  releaseConnections:()=>releaseConnections?.(),
  setConnectionsFailure:(value:boolean)=>{failConnections=value;},
  completeLoads: () => completeLoads(),
  openRepeatedOverlays: () => {
    openSheet("First sheet", document.createElement("p"), "Close");
    openSheet("Second sheet", document.createElement("p"), "Close");
    openDialog("First dialog", "First content", "Close", "Confirm");
    openDialog("Second dialog", "Second content", "Close", "Confirm");
  },
  failNextSave: () => { failNextSave = true; },
  deferSaves: () => { deferredSaves = true; },
  pendingSaves: () => pendingSaves.map(item => item.value),
  storedSettings: () => settings,
  completeNextSave: () => {
    const next = pendingSaves.shift();
    if (!next) throw new Error("No pending save");
    settings = next.value;
    next.resolve(settings);
  },
  rejectNextSave: () => {
    const next = pendingSaves.shift();
    if (!next) throw new Error("No pending save");
    next.reject(new Error("fixture write failure"));
  },
} });
