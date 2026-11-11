// Cross-runtime snapshot check (RE-D170) against the installed engine pin 9f34008c143c5da87b2194b5a28442b407ff8ba7.
// --create <stateDir> <baseDbPath> <snapshotsDir>: Node createSnapshot, prints its report.
// --verify <dir>: Node verifySnapshot, prints its report or {"reason": <SnapshotError reason>}.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

let engineRoot;
try {
  engineRoot = path.dirname(createRequire(path.join(process.cwd(), "package.json")).resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
} catch {
  throw new Error("run pnpm test:prep (the engine package is not installed)");
}
const { createSnapshot, verifySnapshot } = await import(pathToFileURL(path.join(engineRoot, "lib/snapshot/store-snapshot.js")));
const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === "--create") {
    const [stateDir, baseDbPath, snapshotsDir] = args;
    console.log(JSON.stringify(await createSnapshot({ stateDir, baseDbPath, snapshotsDir, label: "node" })));
  } else if (mode === "--verify") {
    console.log(JSON.stringify(await verifySnapshot({ dir: args[0] })));
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (error) {
  if (typeof error?.reason !== "string") throw error;
  console.log(JSON.stringify({ reason: error.reason }));
}
