// A legacy core that outlived its Rust front door and hangs (P4-10 security review M4), for the supervisor's and
// 1staid's Rust tests. fake-core.mjs starts it with FAKE_CORE_LEGACY=1 as
// `node fake-legacy-hang.mjs <address> --behind-front-door hang`: it serves <address> (the core-legacy socket or pipe,
// so the OS names it as that address's server, which is what pins it on macOS) and ignores SIGTERM, SIGINT and the end
// of its stdin, as a legacy core with a stuck event loop does. It prints "listening" once it listens.
import { rmSync } from "node:fs";
import net from "node:net";

const address = process.argv[2];
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
if (process.platform !== "win32") rmSync(address, { force: true });
net.createServer(() => {}).listen(address, () => process.stdout.write("listening\n"));
setInterval(() => {}, 1 << 30);
