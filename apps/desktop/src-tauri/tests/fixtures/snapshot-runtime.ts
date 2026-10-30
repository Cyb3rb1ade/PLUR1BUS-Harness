// Test-only resources: the developer's pinned Node replaces an explicitly inert packaging fixture.
import { stageSnapshotRuntime } from "../../../scripts/snapshot-runtime.mjs";
import { writeDesktopSourceConfig } from "../../../../../packages/core/test/import/desktop-source-fixture.ts";
import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

if (process.version !== "v24.21.0") throw new Error("pinned Node required");
const root=process.argv[2]!;
const target=process.platform === "win32" ? "x86_64-pc-windows-msvc" : process.platform === "darwin" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-gnu";
const resources=join(root,"resources");
const runtime=await stageSnapshotRuntime({target,resources,fixture:true});
const executable=join(resources,runtime.node.path);
copyFileSync(process.execPath,executable); chmodSync(executable,0o755);
runtime.node.sha256=createHash("sha256").update(readFileSync(executable)).digest("hex");
const source=join(root,"source"); mkdirSync(source);
const sourceType=writeDesktopSourceConfig(source);
writeFileSync(join(source,"SOUL.md"),"Native host source persona\n");
writeFileSync(join(source,".env"),"TOKEN=NATIVE_SNAPSHOT_SECRET_MARKER\n");
process.stdout.write(JSON.stringify({runtime,sourceType}));
