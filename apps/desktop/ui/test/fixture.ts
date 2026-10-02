import { createShell } from "../src/shell.ts";
import type { DesktopTransport, Settings } from "../src/ipc.ts";
import { openDialog } from "../src/components/dialog.ts";
import { openSheet } from "../src/components/sheet.ts";

let settings: Settings = { theme: "system", locale: "system" };
let failNextSave = false;
let deferredSaves = false;
const pendingSaves: Array<{ value: Settings; resolve: (value: Settings) => void; reject: (error: Error) => void }> = [];
const boot = (window as any).__fixtureBoot as { platform?: "mac" | "win" | "gnome" | "kde"; failGet?: boolean; deferLoad?: boolean; locale?: string } | undefined;
let completeLoads: () => void = () => {};
const loaded = boot?.deferLoad ? new Promise<void>(resolve => { completeLoads = resolve; }) : Promise.resolve();
const transport: DesktopTransport = {
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
