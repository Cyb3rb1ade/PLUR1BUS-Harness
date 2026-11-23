import { fileURLToPath } from "node:url";
import { HostPacer } from "../../packages/core/src/tools/web/robots.ts";
import { exporterMain } from "./lib.mjs";

type Step = { host: string; advance?: number; crawlMs?: number; cancel?: boolean };

export async function recordWebPacer() {
  const plans: Step[][] = [
    [
      { host: "a.test" }, { host: "a.test" }, { host: "a.test", advance: 400 },
      { host: "b.test" }, { host: "a.test", crawlMs: 3000 }, { host: "a.test" },
    ],
    [
      { host: "a.test" }, { host: "a.test", cancel: true }, { host: "a.test" },
      { host: "a.test", cancel: true, advance: 300 }, { host: "a.test", advance: 400 },
      { host: "b.test" },
    ],
  ];
  const cases = [];
  for (const steps of plans) {
    let now = 1000;
    let fail = false;
    const sleeps: number[] = [];
    const outcomes: string[] = [];
    const pacer = new HostPacer({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (fail) throw new Error("fixture cancellation");
        now += ms;
      },
    });
    for (const step of steps) {
      now += step.advance ?? 0;
      fail = step.cancel ?? false;
      try {
        await pacer.wait(step.host, step.crawlMs);
        outcomes.push("ok");
      } catch {
        outcomes.push("cancelled");
      }
    }
    cases.push({ steps, expected: { sleeps, outcomes, hosts: pacer.size } });
  }
  return { pacer: { source: "packages/core/src/tools/web/robots.ts", cases } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "webtools", build: recordWebPacer });
}
