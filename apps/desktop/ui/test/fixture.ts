import { createShell } from "../src/shell.ts";
import type { DesktopTransport, Settings } from "../src/ipc.ts";

let settings: Settings = { theme: "system", locale: "system" };
let failNextSave = false;
let deferredSaves = false;
const pendingSaves: Array<{ value: Settings; resolve: (value: Settings) => void; reject: (error: Error) => void }> = [];
const boot = (window as any).__fixtureBoot as { platform?: "mac" | "win" | "gnome" | "kde"; failGet?: boolean } | undefined;
const transport: DesktopTransport = {
  async appInfo() { return { platform: boot?.platform ?? "mac" }; },
  async settingsGet() { if (boot?.failGet) throw new Error("fixture settings read failure"); return settings; },
  async settingsSet(value) {
    if (failNextSave) { failNextSave = false; throw new Error("test write failure"); }
    if (deferredSaves) return new Promise<Settings>((resolve, reject) => pendingSaves.push({ value, resolve, reject }));
    settings = value; return settings;
  },
};
const shell = createShell(document.body, transport);
Object.assign(window, { testShell: {
  ...shell,
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
