import { createShell } from "../src/shell.ts";
import type { DesktopTransport, Settings } from "../src/ipc.ts";
import { openDialog } from "../src/components/dialog.ts";
import { openSheet } from "../src/components/sheet.ts";

let settings: Settings = { theme: "system", locale: "system" };
let failNextSave = false;
let deferredSaves = false;
const pendingSaves: Array<{ value: Settings; resolve: (value: Settings) => void; reject: (error: Error) => void }> = [];
const boot = (window as any).__fixtureBoot as { platform?: "mac" | "win" | "gnome" | "kde"; failGet?: boolean; deferLoad?: boolean; locale?: string; rows?: import("../src/ipc.ts").Connection[]; deferConnections?: boolean; failConnections?: boolean } | undefined;
let rows: import("../src/ipc.ts").Connection[]=boot?.rows??[];
let active:string|null=null;
let pairingError:string|null=null;
let failConnections=boot?.failConnections??false;
let releaseConnections: (()=>void)|undefined;
const connectionGate = boot?.deferConnections ? new Promise<void>(resolve=>{releaseConnections=resolve;}) : Promise.resolve();
let completeLoads: () => void = () => {};
const loaded = boot?.deferLoad ? new Promise<void>(resolve => { completeLoads = resolve; }) : Promise.resolve();
const transport: DesktopTransport = {
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
const shell = createShell(document.body, transport);
Object.assign(window, { testShell: {
  ...shell,
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
