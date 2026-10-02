import { createShell } from "../src/shell.ts";
import type { DesktopTransport, Settings } from "../src/ipc.ts";

let settings: Settings = { theme: "system", locale: "system" };
let failNextSave = false;
const transport: DesktopTransport = {
  async appInfo() { return { platform: "mac" }; },
  async settingsGet() { return settings; },
  async settingsSet(value) {
    if (failNextSave) { failNextSave = false; throw new Error("test write failure"); }
    settings = value; return settings;
  },
};
const shell = createShell(document.body, transport);
Object.assign(window, { testShell: { ...shell, failNextSave: () => { failNextSave = true; } } });
