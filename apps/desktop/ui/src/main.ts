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
