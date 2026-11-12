// RE-05/T1 queue goldens. All observed behavior is executed in the pinned Node modules.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only git repository> node <this-file>
// Pressure and lag are explicitly controlled for deterministic scheduling; pressure itself is recorded separately.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pin = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git) throw new Error("PLUR1BUS_ENGINE_SRC and PLUR1BUS_ENGINE_GIT are required");
if (process.version !== "v24.21.0") throw new Error("the recorder requires Node 24.21.0");
const verified = new Map();
function verify(relative) {
  if (verified.has(relative)) return;
  const bytes = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${pin}:${relative}`]);
  if (!bytes.equals(expected)) throw new Error(`pinned source hash mismatch: ${relative}`);
  verified.set(relative, createHash("sha256").update(bytes).digest("hex"));
  const imports = bytes.toString("utf8").matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g);
  for (const match of imports) {
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (dependency.endsWith(".js") || dependency.endsWith(".mjs")) verify(dependency);
  }
}
const sources = ["lib/runtime-scheduler.js", "lib/runtime-pressure-gate.js", "lib/bounded-operation-queue.js",
  "lib/post-turn-queue.js", "lib/post-turn-detach.js"];
for (const source of sources) verify(source);
const load = (relative) => import(pathToFileURL(path.join(root, relative)));
const schedulerApi = await load(sources[0]);
const pressureApi = await load(sources[1]);
const boundedApi = await load(sources[2]);
const postApi = await load(sources[3]);
const lockApi = await load("lib/job-lock.js");
const raw = (value) => JSON.stringify(value);
const results = {};

const pickConfig = (config) => Object.fromEntries(["captureTimeoutMs", "maxConcurrentCapturePerAgent",
  "backgroundPriority", "maxQueueDepthCapturePerAgent", "pressureGateEnabled", "rssWarningBytes", "rssCriticalBytes"]
  .map((key) => [key, config[key]]));
results.config = [
  { name: "defaults", input: {} },
  { name: "custom", input: { captureTimeoutMs: 27.9, maxConcurrentCapturePerAgent: 2,
    backgroundPriority: "normal", maxQueueDepthCapturePerAgent: 2, pressureGateEnabled: false,
    rssWarningBytes: 50, rssCriticalBytes: 100 } },
  { name: "invalid", input: { captureTimeoutMs: 0, maxConcurrentCapturePerAgent: -1,
    backgroundPriority: "high", maxQueueDepthCapturePerAgent: null, pressureGateEnabled: 0,
    rssWarningBytes: "9", rssCriticalBytes: "bad" } },
  { name: "fractional", input: { captureTimeoutMs: 0.5, maxConcurrentCapturePerAgent: 0.5,
    maxQueueDepthCapturePerAgent: 0.5, rssWarningBytes: 0.5, rssCriticalBytes: 0.5 } },
].map((entry) => ({ ...entry, raw: raw(pickConfig(schedulerApi.normalizeRuntimeConfig(entry.input))) }));

const originalMemoryUsage = process.memoryUsage;
try {
  results.pressure = [0, 2 ** 27, 17 * 2 ** 27, 2 * 2 ** 30, 3 * 2 ** 30, 4.5 * 2 ** 30, 5 * 2 ** 30].map((rss) => {
    process.memoryUsage = () => ({ rss, heapUsed: 2 ** 29 });
    return { rss, heap: 2 ** 29, raw: raw(pressureApi.checkRuntimePressure()) };
  });
} finally { process.memoryUsage = originalMemoryUsage; }

const boundedInputs = [
  { name: "evicts-oldest-background", depth: 2, items: [
    { id: "a", background: true, priority: "low" }, { id: "b", background: true, priority: "low" },
    { id: "c", background: true, priority: "low" }] },
  { name: "explicit-exceeds-soft-cap", depth: 2, items: [
    { id: "a", background: false, priority: "normal" }, { id: "b", background: true, priority: "normal" },
    { id: "c", background: false, priority: "high" }, { id: "d", background: true, priority: "low" }] },
  { name: "unbounded-zero-depth", depth: 0, items: [
    { id: "a", background: true, priority: "low" }, { id: "b", background: true, priority: "low" }] },
];
results.bounded = boundedInputs.map((entry) => {
  const evicted = [];
  const queue = boundedApi.makeBoundedQueue({ maxDepth: entry.depth, onEvict: (item) => evicted.push(item.id) });
  const steps = entry.items.map((item) => ({ result: queue.push(item), ids: queue.queue.map((job) => job.id),
    evicted: [...evicted] }));
  return { ...entry, raw: raw(steps) };
});

const magic = "__" + ["open", "claw"].join("") + "_memory_core_light_sleep__";
const admissionInputs = [
  { name: "ordinary-user", event: { prompt: "I am dreaming about background colors and promotion" }, ctx: {} },
  { name: "cron", event: { origin: "cron", prompt: "/memory example" }, ctx: {} },
  { name: "heartbeat", event: { prompt: "HEARTBEAT_OK" }, ctx: {} },
  { name: "active-memory", event: {}, ctx: { sessionKey: "agent:alpha:active-memory:1" } },
  { name: "background-session", event: {}, ctx: { sessionKey: "agent:alpha:background:1" } },
  { name: "manual-trigger", event: { trigger: "manual" }, ctx: {} },
  { name: "explicit-recall", event: { origin: "cron", prompt: "/recall favorite food" }, ctx: {} },
  { name: "magic", event: { prompt: magic }, ctx: {} },
];
results.admission = admissionInputs.map(({ name, event, ctx }) => ({ name,
  input: name === "magic" ? { magic: true } : { event, ctx },
  raw: raw({ background: schedulerApi.isBackgroundTurn(event, ctx),
    skip: schedulerApi.shouldSkipAutoCaptureForInternalTurn(event, ctx) }) }));

const idleLogger = { warn() {}, debug() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function scheduler(config = {}, logger = idleLogger) {
  return schedulerApi.createBackgroundMemoryScheduler({
    config: { pressureGateEnabled: false, eventLoopLagSnapshot: false, ...config }, logger,
  });
}
function statusCapture(service) {
  const { lastBackgroundCaptureAt, ...status } = service.status().capture;
  return { ...status, backgroundTimestampWritten: lastBackgroundCaptureAt !== null };
}
const schedule = scheduler();
const order = [];
let releaseFirst;
const first = schedule.enqueueCapture("alpha", {}, async () => {
  order.push("active");
  await new Promise((resolve) => { releaseFirst = resolve; });
});
await tick();
const rest = [
  ["low", { background: true, priority: "low" }], ["normal", { priority: "normal" }],
  ["high", { priority: "high" }],
].map(([name, meta]) => schedule.enqueueCapture("alpha", meta, () => { order.push(name); }));
releaseFirst();
const ordered = await Promise.all([first, ...rest]);
await tick();
results.order = { raw: raw({ order, results: ordered, status: statusCapture(schedule) }),
  resultLines: ordered.map(raw), statusLine: raw(statusCapture(schedule)) };

const concurrent = scheduler({ maxConcurrentCapturePerAgent: 2 });
const concurrentOrder = [];
let releaseConcurrentA;
let releaseConcurrentB;
const concurrentA = concurrent.enqueueCapture("alpha", {}, async () => {
  concurrentOrder.push("first");
  await new Promise((resolve) => { releaseConcurrentA = resolve; });
});
await tick();
const concurrentB = concurrent.enqueueCapture("alpha", {}, async () => {
  concurrentOrder.push("second");
  await new Promise((resolve) => { releaseConcurrentB = resolve; });
});
await tick();
const concurrentC = concurrent.enqueueCapture("alpha", {}, () => { concurrentOrder.push("third"); });
const concurrentHeld = statusCapture(concurrent);
releaseConcurrentA();
const concurrentAResult = await concurrentA;
const concurrentCResult = await concurrentC;
releaseConcurrentB();
const concurrentBResult = await concurrentB;
await tick();
results.concurrent = { order: concurrentOrder, heldLine: raw(concurrentHeld),
  resultLines: [concurrentAResult, concurrentBResult, concurrentCResult].map(raw),
  statusLine: raw(statusCapture(concurrent)) };

const timed = scheduler({ captureTimeoutMs: 20 });
const timedOrder = [];
let releaseTimed;
const timedFirst = timed.enqueueCapture("alpha", {}, async () => {
  timedOrder.push("first-start");
  await new Promise((resolve) => { releaseTimed = resolve; });
  timedOrder.push("first-end");
});
await tick();
const timedSecond = timed.enqueueCapture("alpha", {}, () => { timedOrder.push("second-start"); });
const timeoutResult = await timedFirst;
const timeoutState = statusCapture(timed);
releaseTimed();
const afterTimeout = await timedSecond;
await tick();
results.timeout = { raw: raw({ timeoutResult, timeoutState, afterTimeout, order: timedOrder,
  status: statusCapture(timed) }), timeoutResultLine: raw(timeoutResult), timeoutStateLine: raw(timeoutState),
  statusLine: raw(statusCapture(timed)) };

const beforeAbort = new AbortController();
beforeAbort.abort();
const abortedService = scheduler();
results.preAborted = { raw: raw(await abortedService.enqueueCapture("alpha", { signal: beforeAbort.signal }, () => {})) };

const queuedAbortService = scheduler();
let releaseAbort;
const blocking = queuedAbortService.enqueueCapture("alpha", {}, () => new Promise((resolve) => { releaseAbort = resolve; }));
await tick();
const queuedAbort = new AbortController();
let sawAborted = false;
const queued = queuedAbortService.enqueueCapture("alpha", { signal: queuedAbort.signal }, (signal) => {
  sawAborted = signal.aborted;
});
queuedAbort.abort();
releaseAbort();
await blocking;
const queuedResult = await queued;
await tick();
results.queuedAbort = { raw: raw({ sawAborted, result: queuedResult, status: statusCapture(queuedAbortService) }) };

try {
  process.memoryUsage = () => ({ rss: 5 * 2 ** 30, heapUsed: 2 ** 29 });
  const pressureScheduler = scheduler({ pressureGateEnabled: true });
  results.pressureAdmission = [];
  for (const meta of [{ background: true }, { priority: "low" }, { priority: "high" }, {}]) {
    const outcome = await pressureScheduler.enqueueCapture("alpha", meta, () => {});
    results.pressureAdmission.push({ meta, raw: raw(outcome) });
  }
} finally { process.memoryUsage = originalMemoryUsage; }

const scratch = mkdtempSync(path.join(tmpdir(), "ca-post-turn-record-"));
try {
  const normalizeId = (text, id) => text.replaceAll(id, "<uuid>");
  const make = (payload, n, agent = "alpha") => postApi.enqueuePostTurnWork(scratch, agent, payload,
    { now: 1_790_000_000_000 + n, logger: idleLogger });
  const firstEntry = make({ turns: [{ role: "user", content: "A synthetic public fixture sentence." }],
    lightDream: true, episodes: false }, 0);
  const rawFirst = normalizeId(readFileSync(path.join(scratch, ".post-turn-queue/alpha", firstEntry.file), "utf8"), firstEntry.id);
  make({ turns: [], lightDream: false, episodes: true }, 1);
  const failed = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await postApi.drainPostTurnWork(scratch, "alpha", () => false, { logger: idleLogger });
    const contents = normalizeId(readFileSync(path.join(scratch, ".post-turn-queue/alpha", firstEntry.file), "utf8"), firstEntry.id);
    failed.push({ result: outcome, resultLine: raw(outcome), contents });
  }
  let seen = 0;
  const droppedThenProcessed = await postApi.drainPostTurnWork(scratch, "alpha", () => ++seen !== 1, { logger: idleLogger });
  const reserved = make({ attempts: 99, id: "old", agentId: "old", enqueuedAt: -1, extra: true }, 2, "beta");
  const rawReserved = normalizeId(readFileSync(path.join(scratch, ".post-turn-queue/beta", reserved.file), "utf8"), reserved.id);
  const payloadCases = [
    '{"z":true,"2":"second","1":"first","statement":"cut \\ud83d"}',
    '{"values":[1.0,1e-7,1e21,1e20,-0],"nested":{"2":2,"1":1}}',
  ].map((input, index) => {
    const entry = make(JSON.parse(input), 20 + index, "codec");
    return { input, now: 1_790_000_000_020 + index,
      raw: normalizeId(readFileSync(path.join(scratch, ".post-turn-queue/codec", entry.file), "utf8"), entry.id) };
  });
  const lockPath = path.join(scratch, ".post-turn-queue/beta/.drain.lock");
  lockApi.acquireJobLock(lockPath);
  let locked;
  try { locked = await postApi.drainPostTurnWork(scratch, "beta", () => true, { logger: idleLogger }); }
  finally { lockApi.releaseJobLock(lockPath); }
  let clockCalls = 0;
  const deadline = await postApi.drainPostTurnWork(scratch, "beta", () => true,
    { logger: idleLogger, budgetMs: 1, now: () => clockCalls++ === 0 ? 0 : 2 });
  let capDropped = 0;
  for (let i = 0; i < 202; i++) capDropped += make({ turns: [], sequence: i }, i, "cap").dropped;
  results.postTurn = { raw: raw({ firstEntry: rawFirst, failed, droppedThenProcessed, reservedEntry: rawReserved,
    locked, deadline, cap: { dropped: capDropped, count: postApi.countPostTurnWork(scratch, "cap") } }),
    droppedThenProcessedLine: raw(droppedThenProcessed), lockedLine: raw(locked), deadlineLine: raw(deadline), payloadCases };
} finally { rmSync(scratch, { recursive: true, force: true }); }

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, "golden"), { recursive: true });
const payload = { schema: "capture-queue/1", recordedFrom: { engine: "node", commit: pin, node: process.version,
  sourceHashes: Object.fromEntries([...verified].sort(([a], [b]) => a.localeCompare(b))),
  flags: { schedulerPressureGateEnabled: false, schedulerEventLoopLagSnapshot: false,
    pressureAdmissionGateEnabled: true, concurrentCaptureSlots: 2,
    pressureCasesOverrideMemoryUsage: true, timeoutCaseMs: 20, postTurnNowMs: 1_790_000_000_000 },
  excluded: ["recall queue/cache (owned by RE-04)", "AsyncLocalStorage identity detachment (host adapter only)"] }, results };
const text = `${JSON.stringify(payload, null, 2)}\n`;
if (text.toLowerCase().includes(["open", "claw"].join(""))) throw new Error("forbidden adapter marker survived fixture normalization");
writeFileSync(path.join(here, "golden/queue.json"), text);
console.log(`wrote golden/queue.json; verified ${verified.size} source hashes`);
