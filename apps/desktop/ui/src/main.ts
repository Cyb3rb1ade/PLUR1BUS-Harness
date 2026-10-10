import { showBackgroundHint } from "./views/background-hint.ts";
import { createShell } from "./shell.ts";
import { nativeTransport } from "./ipc.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openQuitDialog, type QuitOffer } from "./views/quit-dialog.ts";

const shellRoot = document.createElement("div");
document.body.append(shellRoot);
if(window.location.hash==="#/approvals") {
  void import("./views/approvals.ts").then(async({approvalCards})=>{
    const {resolveLocale,translate}=await import("./i18n.ts");
    const [settings,info]=await Promise.all([nativeTransport.settingsGet(),nativeTransport.appInfo()]);
    document.documentElement.lang=resolveLocale(settings.locale,info.locale);
    document.documentElement.dataset.platform=info.platform;
    document.documentElement.dataset.theme=settings.theme==="system"?(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):settings.theme;
    const t=(key:import("./i18n.ts").MessageKey)=>translate(resolveLocale(settings.locale,info.locale),key);
    const render=async()=>{const data=await invoke<{cards:import("./views/approvals.ts").ApprovalCard[];decideEnabled:boolean}>("approvals_list");shellRoot.replaceChildren(approvalCards(data.cards,t,id=>invoke("approval_open",{request:{id}}),data.decideEnabled,(id,decision)=>invoke("approval_decide",{request:{id,decision}})));};
    await listen("desktop-approvals-changed",()=>{void render();});await render();
  });
} else {
  createShell(shellRoot, nativeTransport);
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
  await showCrashOffers(offers, id => invoke("crash_handled", {id}));
}).catch(() => { /* Failed reads never consume local crash evidence. */ });

}
