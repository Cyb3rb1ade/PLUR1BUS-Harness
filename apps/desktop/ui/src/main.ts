import { translate } from "./i18n.ts";
import { showBackgroundHint } from "./views/background-hint.ts";
import { createShell } from "./shell.ts";
import { nativeTransport, withDeadlines } from "./ipc.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openQuitDialog, type QuitOffer } from "./views/quit-dialog.ts";

const shellRoot = document.createElement("div");
document.body.append(shellRoot);
if(window.location.hash==="#/approvals") {
  void import("./approvals-window.ts").then(({mountApprovals})=>mountApprovals(shellRoot,{
    settings:()=>nativeTransport.settingsGet(),
    appInfo:()=>nativeTransport.appInfo(),
    list:()=>invoke<{cards:import("./views/approvals.ts").ApprovalCard[];decideEnabled:boolean}>("approvals_list"),
    open:id=>invoke("approval_open",{request:{id}}),
    decide:(id,decision)=>invoke("approval_decide",{request:{id,decision}}),
    onChanged:listener=>listen("desktop-approvals-changed",listener),
  }));
} else {
  createShell(shellRoot, withDeadlines(nativeTransport));
  void nativeTransport.updateCheck?.(true).catch(()=>{});
}
if(window.location.hash!=="#/approvals") {
const offerQuit = (offer: QuitOffer) => openQuitDialog(offer, {
  confirm: choice => invoke("quit_response", {choice}),
  cancel: () => invoke("quit_response", {choice:null}),
});
// Install the listener before pulling the pending offer, so an early native Quit is not lost.
void listen<QuitOffer>("desktop-quit-offer", event => offerQuit(event.payload))
  .then(async () => { const pending = await invoke<QuitOffer | null>("quit_offer"); if (pending) offerQuit(pending); })
  .catch(() => { /* A failed handshake grants no permission to exit. */ });

const pullBackgroundHint = async () => {
  try { if (await invoke<boolean>("background_hint")) showBackgroundHint(); }
  catch { /* Capability failure cannot hide the resident window. */ }
};
void listen("desktop-background-hint", () => { void pullBackgroundHint(); })
  .then(pullBackgroundHint).catch(() => {});

void import("./views/crash-offer.ts").then(async ({showCrashOffers}) => {
  const offers = await invoke<import("./views/crash-offer.ts").CrashOffer[]>("crash_offers");
  const last = await invoke<{at:string;kind:string;summary:string;hasDiagnostics:boolean}|null>("crash_last_report").catch(() => null);
  if (last && offers.length === 0) offers.push({id:"last-session-marker", details:`${translate(document.documentElement.lang.startsWith("de")?"de":"en", "crash.unclean")} ${last.at}`});
  await showCrashOffers(offers, async id => {
    if (id !== "last-session-marker") await invoke("crash_handled", {id});
    if (last) await invoke("crash_dismiss");
  }, undefined, {open:()=>invoke("diagnostics_open"), restart:()=>invoke("crash_restart")});
}).catch(() => { /* Failed reads never consume local crash evidence. */ });

}
