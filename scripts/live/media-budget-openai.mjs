// Manual live test of image limits in media units (owner decision 2026-10-19). Never run by tests, CI, an installer
// or the core. It drives the harness's real media path (the media.generate RPC surface, the call budget, the job
// runner and the OpenAI HTTP adapter) in a throwaway home with a hard limit of 2 images per day, and asks for three
// images one after another: 1 and 2 must succeed, 3 must be refused by the budget without any network call.
//
//   OPENAI_API_KEY=... node scripts/live/media-budget-openai.mjs
//
// The key is read only from process.env.OPENAI_API_KEY and handed to the adapter; it is never printed or written.
// Safety net: every fetch is counted before it is sent, and a third one is refused, whatever happens, so at most two
// paid provider calls are made. Optional: PLUR1BUS_LIVE_IMAGE_MODEL (default gpt-image-1-mini, the smallest size,
// 1024x1024, n=1). PLUR1BUS_LIVE_OPENAI_BASE_URL and PLUR1BUS_LIVE_DRY_NO_LIMIT are for the dry-run test against a
// loopback stub only and are refused for any other host.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The harness sources are TypeScript with workspace `source` exports: re-run with the flags the package tests use.
if (!process.execArgv.includes("--conditions=source")) {
  const r = spawnSync(process.execPath, ["--conditions=source", "--experimental-strip-types", "--no-warnings=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const MAX_PROVIDER_CALLS = 2;
const IMAGE_LIMIT = 2;
const ATTEMPTS = 3;
const PROMPT = "A small red apple on a plain white table, simple flat illustration";

if (!process.env.OPENAI_API_KEY) {
  console.log("media-budget-openai: OPENAI_API_KEY is not set; nothing was sent. Set it in the environment to run this live test.");
  process.exit(0);
}

const base = process.env.PLUR1BUS_LIVE_OPENAI_BASE_URL;
if (base !== undefined) {
  const host = new URL(base).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) { console.error("media-budget-openai: PLUR1BUS_LIVE_OPENAI_BASE_URL is for a loopback stub only"); process.exit(2); }
}
const dryNoLimit = process.env.PLUR1BUS_LIVE_DRY_NO_LIMIT === "1";
if (dryNoLimit && base === undefined) { console.error("media-budget-openai: PLUR1BUS_LIVE_DRY_NO_LIMIT needs a loopback stub"); process.exit(2); }

// The safety net, installed before any harness code is loaded: counted before the request leaves, refused past the cap.
let providerCalls = 0;
let netTripped = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (providerCalls >= MAX_PROVIDER_CALLS) {
    netTripped = true;
    return Promise.reject(new Error(`safety net: refused provider call #${providerCalls + 1} (at most ${MAX_PROVIDER_CALLS})`));
  }
  providerCalls += 1;
  return realFetch(input, init);
};

const { mkdtemp } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createMediaSurface } = await import("../../packages/core/src/rpc/media-surface.ts");
const { guardMethods } = await import("../../packages/core/src/rbac/guard.ts");
const { createBudgetService, createCallBudget } = await import("../../packages/core/src/budget/index.ts");
const { HttpImageAdapter, OutputStore } = await import("../../packages/media/src/index.ts");

const home = await mkdtemp(join(tmpdir(), "p1b-live-media-budget-"));
const dbPath = join(home, "state", "budget.sqlite");
const clock = { now: () => Date.now() };
const budget = createCallBudget({ path: dbPath, clock });
const ledger = createBudgetService({ path: dbPath, clock });
if (!dryNoLimit) ledger.setLimit({ scope: "global", period: "day", metric: "images", hard: IMAGE_LIMIT });

const model = process.env.PLUR1BUS_LIVE_IMAGE_MODEL || "gpt-image-1-mini";
// One attempt per request (no transport retries), so a provider call is never repeated behind the net's back. A loopback
// stub never gets the key (the media transport refuses to send a credential to a private host anyway).
const adapter = new HttpImageAdapter({ id: "openai", model, retry: { maxAttempts: 1 }, timeoutMs: 180_000, ...(base ? { baseUrl: base } : { apiKey: process.env.OPENAI_API_KEY }) });
const store = new OutputStore(join(home, "media", "outputs"));
const stop = new AbortController();
const surface = createMediaSurface({ home, adapters: [adapter], store, budget, signal: stop.signal, policy: async () => {}, notify: () => {} });
const methods = guardMethods(surface.methods, { resolve: () => ({ userId: "live-owner", role: "owner", kind: "person" }), now: () => Date.now() });
const ctx = { requestId: "live", connectionId: "live", signal: stop.signal };

const budgetLine = () => {
  const s = ledger.status();
  const lim = s.limits.find((l) => l.metric === "images");
  const today = s.periods.find((p) => p.period === "day");
  return lim ? `images used ${lim.used} of hard ${lim.hard} (${lim.state})` : `images used ${today?.total.images ?? 0} (no image limit)`;
};

console.log(`media-budget-openai: model ${model}, 1024x1024, n=1, hard limit ${dryNoLimit ? "none (dry run of the safety net)" : `${IMAGE_LIMIT} images/day`}`);
console.log(`home ${home}`);
const results = [];
for (let i = 1; i <= ATTEMPTS; i++) {
  const before = providerCalls;
  let status, delivered = 0, detail = "";
  try {
    const q = await methods["media.generate"]({ agentId: "live", request: { prompt: PROMPT, n: 1, size: { width: 1024, height: 1024 }, format: "png" } }, ctx);
    await surface.close(); // waits for the job to finish
    const job = await methods["media.job.get"]({ id: q.jobId }, ctx);
    status = job.state;
    if (job.state === "succeeded") {
      const out = await methods["media.output.get"]({ id: q.jobId }, ctx);
      delivered = out.manifest.files.length;
      detail = out.manifest.files.map((f) => join(store.root, q.jobId, f.path)).join(", ");
    } else detail = job.error ?? "";
  } catch (e) {
    status = e?.error === "E_DENIED" && e?.reason === "budget_exceeded" ? "refused (budget_exceeded)" : "error";
    detail = String(e?.message ?? e);
  }
  const calls = providerCalls - before;
  results.push({ status, calls });
  console.log(`attempt ${i}: ${status}; requested 1 image, delivered ${delivered}; provider calls ${calls}; ${budgetLine()}${detail ? `; ${detail}` : ""}`);
}
await surface.close();
budget.close(); ledger.close();

console.log(`images: ${store.root}`);
console.log(`provider calls in total: ${providerCalls}${netTripped ? " (the safety net refused a further call)" : ""}`);
const ok = !netTripped && results[0]?.status === "succeeded" && results[1]?.status === "succeeded"
  && results[2]?.status === "refused (budget_exceeded)" && results[2]?.calls === 0 && providerCalls <= MAX_PROVIDER_CALLS;
console.log(ok ? "PASS: 2 images generated, the third refused by the budget before any network call" : "FAIL: see the attempts above");
process.exit(ok ? 0 : 1);
