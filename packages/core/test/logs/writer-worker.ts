import { createWriter } from "../../src/logs/writer.ts";
const dir = process.argv[2]!; const base = Number(process.argv[3]);
const w = createWriter({ dir, role: "core", source: { kind: "harness", id: "core", version: null }, timers: false, maxBytes: 1000000 });
for (let i = 0; i < 30; i++) w.write("core.process.started", { pid: base + i });
w.close();
