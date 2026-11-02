import { setTimeout as delay } from "node:timers/promises";
/** AF0 offline executable body. Tests prepend the absolute Node shebang because the server environment is reduced. */
import { createServer } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "serve" || args[1] !== "--socket") {
  throw new Error("fake fm requires exactly serve --socket PATH");
}
const socket = isAbsolute(args[2]) ? args[2] : resolve(args[2]);
const mode = await readFile(join(dirname(socket), "fake-mode"), "utf8").catch(error => {
  if (error.code !== "ENOENT") throw error;
  return "stay";
});
let eof = false;
const health = () => ({
  status: "fm serve is running",
  models: [{ name: "system", available: true }, { name: "pcc", available: false, reason: "synthetic" }],
  offline: { argv: args, env: process.env, cwd: process.cwd(), pid: process.pid, stdinEof: eof },
});
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(health()));
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.stdin.on("end", () => {
  eof = true;
  if (mode === "exit-on-eof") stop();
});
process.stdin.resume();
if (mode === "exit-when-orphaned") {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) stop();
  }, 5).unref();
}
if (mode === "delayed-listen") {
  await delay(150);
  await unlink(socket);
}
server.listen(socket);
