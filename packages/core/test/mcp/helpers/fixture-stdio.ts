// stdio entry for the fixture server: `node --experimental-strip-types fixture-stdio.ts`.
//   FIXTURE_WEDGE=1       ignore SIGTERM and stay alive after stdin closes (only SIGKILL stops it)
//   FIXTURE_STARTUP_MS=n  delay before the server starts answering
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFixtureServer } from "./fixture-server.ts";

const wedge = process.env.FIXTURE_WEDGE === "1";
if (wedge) { process.on("SIGTERM", () => { /* trapped */ }); setInterval(() => { /* keep the event loop alive */ }, 1000); }
else process.stdin.on("end", () => process.exit(0));

const delay = Number(process.env.FIXTURE_STARTUP_MS ?? 0);
if (delay > 0) await new Promise((r) => setTimeout(r, delay));
process.stderr.write("fixture ready\n");
await createFixtureServer().server.connect(new StdioServerTransport());
