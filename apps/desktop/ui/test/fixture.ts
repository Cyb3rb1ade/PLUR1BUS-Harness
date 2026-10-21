import {upgradeProgress} from "../src/views/upgrade-progress.ts";
import {updatesPage} from "../src/views/settings-updates.ts";
import {approvalCards} from "../src/views/approvals.ts";
import {translate} from "../src/i18n.ts";
import {showCrashOffers} from "../src/views/crash-offer.ts";
import { showBackgroundHint } from "../src/views/background-hint.ts";
import {versionPage} from "../src/views/settings-version.ts";
import { createShell } from "../src/shell.ts";
import type { DesktopTransport, Settings } from "../src/ipc.ts";
import { openDialog } from "../src/components/dialog.ts";
import { mountApprovals } from "../src/approvals-window.ts";
import { openQuitDialog } from "../src/views/quit-dialog.ts";
import { openSheet } from "../src/components/sheet.ts";
import { createTransportModel } from "../src/models/transport-model.ts";
import { transportChoice } from "../src/views/transport-choice.ts";

let settings: Settings = { theme: "system", locale: "system" };
let failNextSave = false;
let failQuit = false;
let autostart: boolean | null;
let autostartFail = false;
const autostartCalls: boolean[] = [];
let deferredSaves = false;
const pendingSaves: Array<{ value: Settings; resolve: (value: Settings) => void; reject: (error: Error) => void }> = [];
const boot = (window as any).__fixtureBoot as { bundled?: boolean; platform?: "mac" | "win" | "gnome" | "kde"; autostartUnknown?: boolean; failGet?: boolean; deferLoad?: boolean; locale?: string; rows?: import("../src/ipc.ts").Connection[]; deferConnections?: boolean; failConnections?: boolean; failProgress?: boolean; harnessState?: string; runtimeLog?: string } | undefined;
autostart = boot?.autostartUnknown ? null : false;
let rows: import("../src/ipc.ts").Connection[]=boot?.rows??[];
let active:string|null=null;
let pairingError:string|null=null;
let failConnections=boot?.failConnections??false;
let releaseConnections: (()=>void)|undefined;
const connectionGate = boot?.deferConnections ? new Promise<void>(resolve=>{releaseConnections=resolve;}) : Promise.resolve();
const calls = { pair: 0, remove: 0, open: 0, decide: 0 };
// Transport choice fixtures (spec §7.1): reports by host, the stored path per connection, every IPC call.
type Report = import("../src/ipc.ts").TransportReport;
const privateReport = (): Report => ({ category: "private", addresses: ["192.168.1.20"], hints: [], tailscale: null, needsPublicAck: false, classifier: "iana-special-2025-10-09" });
const publicReport = (host: string, code: string): Report => ({ category: "public", addresses: code === "target-mixed" ? ["192.168.1.20", "9.9.9.9"] : ["9.9.9.9"], hints: [{ code, severity: "warning", params: { host, addresses: "9.9.9.9" } }], tailscale: null, needsPublicAck: true, classifier: "iana-special-2025-10-09" });
const transportReports: Record<string, Report> = { "public.harness.test": publicReport("public.harness.test", "target-public"), "mixed.harness.test": publicReport("mixed.harness.test", "target-mixed") };
const transportViews: Record<string, import("../src/ipc.ts").TransportView> = {};
const transportCalls: unknown[][] = [];
let transportStoreReadOnly = false;
let transportCheckError: string | null = null;
let attentionListener: ((event: { id: string; code: string }) => void) | null = null;
let traySwitchListener: ((event: { id: string; error: string | null }) => void) | null = null;
const hostOf = (origin: string) => { try { return new URL(origin).hostname.replace(/^\[|\]$/g, ""); } catch { return origin; } };
const reportFor = (host: string): Report => transportReports[host] ?? privateReport();
const viewFor = (row: import("../src/ipc.ts").Connection) => transportViews[row.id] ?? { transport: "direct" as const, publicAck: false, storeReadOnly: transportStoreReadOnly };
const gates: Record<string, Promise<void> | undefined> = {};
const releases: Record<string, () => void> = {};
const hold = (name: string) => { gates[name] = new Promise<void>(resolve => { releases[name] = () => { gates[name] = undefined; resolve(); }; }); };
let completeLoads: () => void = () => {};
const loaded = boot?.deferLoad ? new Promise<void>(resolve => { completeLoads = resolve; }) : Promise.resolve();
const transport: DesktopTransport = {
 async helperStatus(){return {ready:true,restarting:false,capabilities:[],grants:[]};},
 async bridgeSettings(enabled){return {enabled:enabled??true,memoryOnly:true,secretsLocked:true};},
 async autostartGet(){return autostart;},
 async autostartSet(value){autostartCalls.push(value);if(autostartFail)throw new Error("injected autostart error");autostart=value;return autostart;},
 async connectionsList(){await connectionGate;if(failConnections)throw "storage";return {connections:rows,active,tokenStore:"memory-only",transports:Object.fromEntries(rows.filter(row=>row.kind==="remote").map(row=>[row.id,{...viewFor(row),storeReadOnly:transportStoreReadOnly}])),transportStore:transportStoreReadOnly?"read-only-newer":"read-write"};},
 async connectionsRename(id,name){rows=rows.map(row=>row.id===id?{...row,name}:row);},
 async connectionsRemove(id){calls.remove++;await gates.remove;rows=rows.filter(row=>row.id!==id);},
 async pairCode(request){calls.pair++;transportCalls.push(["pair",request.transport,request.publicAck]);await gates.pair;if(pairingError)throw pairingError;if(request.transport!=="tailscale"&&request.transport!=="direct")throw "invalid";const needs=reportFor(hostOf(request.origin)).needsPublicAck;if(needs&&!request.publicAck)throw "transport-confirm-needed";const connection={id:request.repairId??"fixture-row",name:request.name,origin:request.origin,kind:"remote" as const,installationId:"fixture-installation",deviceId:"fixture-device",tokenHint:"hint",certPin:null,caPin:null,nextCertPin:null,nextCaPin:null,observedCertPin:null,pairingNeeded:false};transportViews[connection.id]={transport:request.transport,publicAck:needs,storeReadOnly:transportStoreReadOnly};rows=[connection];return {connection,tokenStore:"memory-only"};},
 async pairLocal(){if(pairingError)throw pairingError;throw "denied";},
 async openConnection(id){calls.open++;transportCalls.push(["open",id]);await gates.open;if(pairingError)throw pairingError;const row=rows.find(r=>r.id===id);const report=row&&row.kind==="remote"?reportFor(hostOf(row.origin)):null;if(row&&report?.needsPublicAck&&!viewFor(row).publicAck)throw "transport-confirm-needed";active=id;return {selected:true,spa_available:false,transport:report};},
 async transportCheck(target,transport,purpose){transportCalls.push(["check",target,transport,purpose]);await gates.check;if(transportCheckError)throw transportCheckError;const host=target.kind==="origin"?hostOf(target.origin):target.kind==="host"?target.host:hostOf(rows.find(r=>r.id===target.id)?.origin??"");return reportFor(host);},
 async connectionTransportSet(id,transport,publicAck){transportCalls.push(["set",id,transport,publicAck]);const row=rows.find(r=>r.id===id);if(!row)throw "invalid";const view=viewFor(row);const needs=reportFor(hostOf(row.origin)).needsPublicAck;const kept=view.transport===transport&&view.publicAck;if(needs&&!publicAck&&!kept)throw "transport-confirm-needed";transportViews[id]={transport,publicAck:needs&&(publicAck||kept),storeReadOnly:transportStoreReadOnly};return reportFor(hostOf(row.origin));},
 async transportAttention(listener){attentionListener=listener;return ()=>{attentionListener=null;};},
 async traySwitch(listener){traySwitchListener=listener;return ()=>{traySwitchListener=null;};},
  async appInfo() { await loaded; return { platform: boot?.platform ?? "mac", locale: boot?.locale ?? "en-US" }; },
  async settingsGet() { await loaded; if (boot?.failGet) throw new Error("fixture settings read failure"); return settings; },
  async settingsSet(value) {
    if (failNextSave) { failNextSave = false; throw new Error("test write failure"); }
    if (deferredSaves) return new Promise<Settings>((resolve, reject) => pendingSaves.push({ value, resolve, reject }));
    settings = value; return settings;
  },
};
if(boot?.bundled){
 transport.runtimeDetect=async()=>[{id:"p1t-runtime",kind:"docker",endpoint:"unix:///p1t/engine.sock",source:"podman",engine:"Podman",version:"5.0",state:"ready"}];
 transport.bundleInstall=async()=>({connectionId:"p1t-bundled"});
 transport.bundleCancel=async()=>{};
 transport.harnessStatus=async()=>({state:boot?.harnessState??"ready"});
 if(boot?.failProgress)transport.bundleProgress=async()=>{throw "listen-failed";};
 transport.harnessStart=async()=>{};transport.harnessStop=async()=>{};
 transport.harnessLogsTail=async()=>boot?.runtimeLog??"synthetic redacted log";
}
const shellRoot = document.createElement("div");
document.body.append(shellRoot);
const shell = createShell(shellRoot, transport);
Object.assign(window, { testShell: {
  ...shell,
  rollbacks:0,
  showProgress:(step:string,outcome:import("../src/views/upgrade-progress.ts").UpgradeOutcome|null)=>{
    const main=document.createElement("main");main.className="content";
    main.append(upgradeProgress(step,outcome));shellRoot.replaceChildren(main);
  },
  showVersion:(recovery=false)=>{
    const status:import("../src/views/settings-version.ts").UpgradeStatus={appVersion:"0.1.1",installedVersion:"0.1.1",imageDigest:"sha256:synthetic",rollbackAvailable:!recovery,journal:{from:"0.1.0",to:"0.1.1",step:recovery?"recoveryFailed":"done",failedStep:null,diagnostic:recovery?"<img src=x onerror=alert(1)> synthetic redacted details":null,snapshot:{createdAt:"2026-10-10T00:00:00Z",bytes:100,fileCount:2}}};
    const renderer=versionPage({...transport,harnessUpgradeStatus:async()=>status,harnessRollback:async confirmed=>{if(!confirmed)throw new Error("confirmation");(window as any).testShell.rollbacks++;status.rollbackAvailable=false;status.journal!.step="rolledBack";status.journal!.failedStep="done";return {state:"rolledBack",from:"0.1.0",to:"0.1.1",failed_step:"done"};}},()=>shellRoot.replaceChildren(renderer()));
    shellRoot.replaceChildren(renderer());
  },
  showRecovery:()=>{(window as any).testShell.showVersion(true);},
  showUpdates:(store=false)=>{
    let snapshot:import("../src/models/update-model.ts").UpdateSnapshot={settings:{channel:"stable",held:false,autoPatch:true,quietHours:[3,5],checkOnStart:true},release:{version:"0.1.1",channel:"stable",kind:"patch",security:true,date:"2026-10-10",notes:{en:"<script>bad()</script>Fixed\n- [Docs](https://harness.test)",de:"Behoben"},minFromVersion:"0.1.0"},offer:{action:"show"},storeBuild:store,installAvailable:!store};
    const renderer=updatesPage({...transport,updateSettings:async request=>{if(request)snapshot={...snapshot,settings:request};return snapshot;},updateCheck:async()=>snapshot,updateInstall:async()=>{throw new Error("synthetic failure");},updateSkip:async()=>snapshot={...snapshot,offer:{action:"none"}},updateLater:async()=>snapshot={...snapshot,offer:{action:"none"}},updateStoreOpen:async()=>{}},()=>{shellRoot.replaceChildren(renderer());});
    shellRoot.replaceChildren(renderer());
  },
  // Update states beyond the plain offer: an intermediate version first, or a check the shell rejects with an IPC error code.
  showUpdateStates:(over:{offer?:import("../src/models/update-model.ts").UpdateSnapshot["offer"];checkError?:string}={})=>{
    const snapshot:import("../src/models/update-model.ts").UpdateSnapshot={settings:{channel:"stable",held:false,autoPatch:true,quietHours:[3,5],checkOnStart:true},release:{version:"0.1.1",channel:"stable",kind:"patch",security:false,date:"2026-10-10",notes:{en:"Fixed",de:"Behoben"},minFromVersion:"0.1.0"},offer:over.offer??{action:"show"},storeBuild:false,installAvailable:true};
    const renderer=updatesPage({...transport,updateSettings:async()=>snapshot,updateCheck:async()=>{if(over.checkError!==undefined)throw over.checkError;return snapshot;},updateInstall:async()=>{throw new Error("synthetic failure");},updateSkip:async()=>snapshot,updateLater:async()=>snapshot,updateStoreOpen:async()=>{}},()=>{shellRoot.replaceChildren(renderer());});
    shellRoot.replaceChildren(renderer());
  },
  calls,
  hold,
  release:(name:string)=>releases[name]?.(),
  showPendingApprovals:(cards:import("../src/views/approvals.ts").ApprovalCard[])=>{shellRoot.replaceChildren(approvalCards(cards,key=>translate("en",key),async()=>{},true,async()=>{calls.decide++;await gates.decide;}));},
  approvalsList: [] as Array<{ resolve: (value: { cards: import("../src/views/approvals.ts").ApprovalCard[]; decideEnabled: boolean }) => void; reject: (reason: unknown) => void }>,
  approvalsChanged: () => {},
  mountApprovalsWindow: () => {
    const self = (window as any).testShell;
    void mountApprovals(shellRoot, {
      settings: () => transport.settingsGet(), appInfo: () => transport.appInfo(),
      list: () => new Promise((resolve, reject) => { self.approvalsList.push({ resolve, reject }); }),
      open: async () => {}, decide: async () => {},
      onChanged: async listener => { self.approvalsChanged = listener; },
    });
  },
  approvalActions:[] as string[],
  showApprovals:(cards:import("../src/views/approvals.ts").ApprovalCard[],locale:"de"|"en"="en",enabled=false)=>{shellRoot.replaceChildren(approvalCards(cards,key=>translate(locale,key),async id=>{(window as any).testShell.approvalActions.push(`open:${id}`);},enabled,async(id,decision)=>{(window as any).testShell.approvalActions.push(`${decision}:${id}`);}));},
  showBackgroundHint,
  autostartCalls: () => autostartCalls,
  failAutostart: () => { autostartFail = true; },
  crashHandled: [] as string[],
  crashCopied: [] as string[],
  crashActions: [] as string[],
  openCrashActions: () => { void showCrashOffers([{id:"owned-crash",details:"synthetic details"}], async id => { (window as any).testShell.crashHandled.push(id); }, async () => {}, {open:async()=>{(window as any).testShell.crashActions.push("open");}, restart:async()=>{(window as any).testShell.crashActions.push("restart");}}); },
  openCrashText: (text: string) => { void showCrashOffers([{id:"text-crash",details:text}], async () => {}, async copied => { (window as any).testShell.crashCopied.push(copied); }); },
  openCrash: (failCopy = false, failAck = false) => { void showCrashOffers([{id:"owned-crash",details:"<img src=x onerror=alert(1)> synthetic details"}], async id => { if(failAck)throw new Error("injected"); (window as any).testShell.crashHandled.push(id); }, async text => { if(failCopy)throw new Error("injected"); (window as any).testShell.crashCopied.push(text); }); },
  quitDecisions: [] as string[],
  setQuitFailure: (value: boolean) => { failQuit = value; },
  openQuit: () => openQuitDialog({choice:"keep-running",canStopHarness:false}, { confirm: async choice => { if (failQuit) throw new Error("injected rejection"); (window as any).testShell.quitDecisions.push(choice); }, cancel: async () => { (window as any).testShell.quitDecisions.push("cancel"); } }),
  setPairingError:(value:string|null)=>{pairingError=value;},
  setTransportReport:(host:string,report:Report|null)=>{if(report)transportReports[host]=report;else delete transportReports[host];},
  setTransportView:(id:string,view:import("../src/ipc.ts").TransportView)=>{transportViews[id]=view;},
  setTransportStoreReadOnly:(value:boolean)=>{transportStoreReadOnly=value;},
  setTransportCheckError:(value:string|null)=>{transportCheckError=value;},
  transportCalls:()=>transportCalls,
  fireAttention:(id:string,code:string)=>attentionListener?.({id,code}),
  // The native tray switch: `connections_list` changes underneath, then the shell event (desktop spec §6.3).
  fireTraySwitch:(id:string,error:string|null)=>{if(!error)active=id;traySwitchListener?.({id,error});},
  showTransportChoice:(purpose:import("../src/ipc.ts").Purpose,host:string,locale:"en"|"de"="en",storeReadOnly=false)=>{
    const model=createTransportModel(transport.transportCheck!.bind(transport),purpose,undefined,0);
    const form=document.createElement("main");form.className="content";
    form.append(transportChoice((key,values)=>translate(locale,key,values),model,{idPrefix:"fixture-transport",storeReadOnly}));
    shellRoot.replaceChildren(form);
    model.setTarget({kind:"host",host,port:22},host);
    (window as any).testShell.choiceModel=model;
  },
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

// Installation fixtures exercise the same views and transport interfaces as the native shell.
import { advancedSettings } from "../src/views/settings-advanced.ts";
import { integrationControls } from "../src/views/integration-controls.ts";
import { installRuntime } from "../src/views/install-runtime.ts";
Object.assign((window as any).testShell, {
 installCalls:[] as unknown[],
 showIntegration:(kind:"desktop"|"menu"|"store"="desktop",fail=false)=>{
  const render=integrationControls({...transport,desktopIntegrationGet:async()=>({kind,enabled:false}),desktopIntegrationSet:async enabled=>{if(fail)throw Error("foreign-secret");return {kind,enabled};}},key=>translate("en",key),()=>shellRoot.replaceChildren(render()));
  shellRoot.replaceChildren(render());
 },
 showInstall:(platform:"mac"|"win"|"linux"="win",locale:"en"|"de"="en")=>{
  const self=(window as any).testShell;
  const render=installRuntime({...transport,installOptions:async()=>({platform,appleAvailable:platform==="mac",dockerLicence:"Docker terms",podmanLicence:"Apache-2.0"}),runtimeInstallApple:async agreed=>{self.installCalls.push(["apple",agreed]);},runtimeInstallVendor:async(vendor,agreed)=>{self.installCalls.push([vendor,agreed]);},runtimeEnablePodmanSocket:async()=>{self.installCalls.push(["socket"]);}},key=>translate(locale,key),()=>shellRoot.replaceChildren(render()),()=>{self.installCalls.push(["recheck"]);});
  shellRoot.replaceChildren(render());
 },
 showAdvanced:(locale:"en"|"de"="en")=>{
  const self=(window as any).testShell;
  const render=advancedSettings({...transport,cliShimInstall:async add=>{self.installCalls.push(["shim",add]);},cliShimRemove:async()=>{},diagnosticsOpen:async()=>{},uninstallSummary:async level=>({level,containers:["plur1bus-harness"],images:level==="app_only"?[]:["sha256:fixture"],volumes:level==="everything"?[{name:"plur1bus-state",bytes:null},{name:"plur1bus-state-pre-0.1.0",bytes:4096}]:[],preservesData:level!=="everything",removesKeychain:level==="everything"}),uninstallRun:async(level,confirmation)=>{self.installCalls.push(["uninstall",level,confirmation]);}},key=>translate(locale,key),()=>shellRoot.replaceChildren(render()));
  shellRoot.replaceChildren(render());
 },
});
