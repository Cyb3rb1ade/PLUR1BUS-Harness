/** Thin B1 invocation bridge. Contains no expected outcomes, reference code, credentials or other cases. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const setup = JSON.parse(readFileSync(process.argv[2], "utf8"));
const solution = await import(pathToFileURL(setup.entry).href);
const fn = solution[setup.symbol];
const input = setup.input;
let output;

if (setup.id === "easy-ts-tags") {
  const before = JSON.stringify(input.values);
  try {
    const value = await fn(input.values);
    output = { value, unchanged: JSON.stringify(input.values) === before };
  } catch {
    output = { error: true };
  }
} else if (setup.id === "medium-ts-topology") {
  const before = JSON.stringify([input.nodes, input.edges]);
  try {
    const value = await fn(input.nodes, input.edges);
    output = { value, unchanged: JSON.stringify([input.nodes, input.edges]) === before };
  } catch {
    output = { error: true, unchanged: JSON.stringify([input.nodes, input.edges]) === before };
  }
} else if (setup.id === "hard-ts-workers" && input.mode === "occupancy") {
  const controller = new AbortController();
  const started = [],
    finished = [];
  const gates = new Map();
  let value,
    rejected = false,
    settled = false;
  const worker = async (item, index) => {
    started.push(index);
    await new Promise((resolve) => gates.set(index, resolve));
    finished.push(index);
    return item + index;
  };
  const pending = Promise.resolve()
    .then(() => fn(input.items, input.limit, worker, controller.signal))
    .then(
      (result) => {
        value = result;
        settled = true;
      },
      () => {
        rejected = true;
        settled = true;
      },
    );
  const checkpoint = () => new Promise((resolve) => setImmediate(resolve));
  await checkpoint();
  gates.get(input.releaseIndex)?.();
  await checkpoint();
  const afterRelease = { started: [...started], finished: [...finished] };
  // Drain even an incorrect serial/batched subject; no wall-time threshold determines the assertion.
  for (let step = 0; step < input.items.length + 2 && !settled; step++) {
    for (const release of gates.values()) release();
    await checkpoint();
  }
  await pending;
  output = { state: rejected ? "rejected" : "resolved", value, afterRelease };
} else if (setup.id === "hard-ts-workers") {
  const before = JSON.stringify(input.items),
    controller = new AbortController();
  const unhandled = [];
  const rejection = (value) => {
    unhandled.push(value);
  };
  process.on("unhandledRejection", rejection);
  const reason = input.mode === "undefined-failure" ? undefined : { codingReason: setup.symbol };
  let active = 0,
    peak = 0,
    calls = 0,
    finished = 0;
  const worker = async (item, index) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    try {
      await delay(input.delays[index] ?? 1);
      if ((input.mode === "failure" || input.mode === "undefined-failure") && index === 0) throw reason;
      return item + index;
    } finally {
      active--;
      finished++;
    }
  };
  if (input.mode === "pre-aborted") controller.abort(reason);
  const abort = input.mode === "abort" ? setTimeout(() => controller.abort(reason), 1) : undefined;
  try {
    const value = await fn(input.items, input.limit, worker, controller.signal);
    output = {
      state: "resolved",
      value,
      calls,
      peak,
      finished,
      unchanged: JSON.stringify(input.items) === before,
      unhandled: 0,
    };
  } catch (error) {
    output = {
      state: "rejected",
      sameReason: error === reason,
      calls,
      peak,
      finished,
      unchanged: JSON.stringify(input.items) === before,
      unhandled: 0,
    };
  } finally {
    clearTimeout(abort);
  }
  // Preserve the settlement snapshot above while allowing an unobserved worker rejection to surface.
  await delay(Math.max(0, ...input.delays) + 20);
  output.unhandled = unhandled.length;
  process.removeListener("unhandledRejection", rejection);
} else {
  output = { bridgeError: true };
}
process.stdout.write(JSON.stringify(output) + "\n");
