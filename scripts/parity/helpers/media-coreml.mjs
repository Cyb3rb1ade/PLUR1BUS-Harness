import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [log, mode, png, ...args] = process.argv.slice(2);
const emit = (message) => {
  const text = JSON.stringify(message);
  appendFileSync(log, JSON.stringify({ receive: text }) + "\n");
  process.stdout.write(text + "\n");
};
const request = (line) => {
  appendFileSync(log, JSON.stringify({ send: line }) + "\n");
  const value = JSON.parse(line);
  const fields = value.id ? { id: value.id } : {};
  if (value.op === "list-models" || value.operation === "list") {
    emit({ ...fields, type: "models", models: ["sample-split", "sample-gpu"] });
  } else if (value.op === "cancel") {
    emit({ id: value.target, type: "error", code: "cancelled" });
  } else if (mode === "hold") {
    emit({ ...fields, type: "progress", fraction: 0.25 });
  } else {
    writeFileSync(join(value.outputDir, "0.png"), Buffer.from(png, "base64"));
    emit({ ...fields, type: "progress", fraction: 0.5 });
    emit({ ...fields, type: "result", files: ["0.png"], seed: 42 });
  }
};

if (args.includes("--capabilities")) {
  if (mode === "legacy") process.exitCode = 1;
  else emit({ protocol: "jsonl/1", ops: ["generate", "img2img", "list-models", "cancel"] });
} else {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    request(line);
    if (!args.includes("--jsonl")) break;
  }
}
