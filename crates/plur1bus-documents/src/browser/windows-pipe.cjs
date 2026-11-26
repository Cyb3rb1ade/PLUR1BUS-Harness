const { spawn } = require("node:child_process");
const [, root, executable, ...args] = process.argv;
const browser = spawn(executable, args, {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  env: { TEMP: root, TMP: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: root },
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
