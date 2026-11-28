const { spawn } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const [, root, executable, ...args] = process.argv;

// Windows resolves its known folders relative to USERPROFILE. Chrome needs
// those folders to exist to distinguish its default directory from our profile.
const localAppData = join(root, "AppData", "Local");
const roamingAppData = join(root, "AppData", "Roaming");
mkdirSync(localAppData, { recursive: true });
mkdirSync(roamingAppData, { recursive: true });

const browser = spawn(executable, args, {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  env: {
    TEMP: root,
    TMP: root,
    USERPROFILE: root,
    LOCALAPPDATA: localAppData,
    APPDATA: roamingAppData,
  },
  shell: false,
  windowsHide: true,
});
const input = browser.stdio[3];
const output = browser.stdio[4];
browser.once("error", () => { process.exitCode = 1; process.stdin.destroy(); });
browser.once("close", code => { process.exitCode = code ?? 1; process.stdin.destroy(); });
input.once("error", () => browser.kill());
output.once("error", () => browser.kill());
process.stdin.once("error", () => browser.kill());
process.stdout.once("error", () => browser.kill());
process.stdin.once("end", () => browser.kill());
process.stdin.pipe(input);
output.pipe(process.stdout);
