import { showBackgroundHint } from "./views/background-hint.ts";
import { createShell } from "./shell.ts";
import { nativeTransport } from "./ipc.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openQuitDialog, type QuitOffer } from "./views/quit-dialog.ts";

const shellRoot = document.createElement("div");
document.body.append(shellRoot);
createShell(shellRoot, nativeTransport);
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
