import { pathToFileURL } from "node:url";
import { acknowledgeMemoryBatch, borrowerMemoryDisposition, createMemoryOutbox, foreignMemoryUse, makeMemoryBatches,
  receiveMemoryBatch, selectedHomeMemories, type LoanMemoryRef, type MemoryAck, type MemoryBatch } from "../../packages/core/src/federation/loan-memory-policy.ts";
import { createLoan, transitionLoan, type LoanOffer } from "../../packages/core/src/federation/loan-model.ts";
import { exporterMain } from "./lib.mjs";

const offer: LoanOffer = {
  loanId: "loan-one", agentId: "agent", lenderFingerprint: "home", borrowerFingerprint: "away",
  createdAt: 1000, expiresAt: 1000 + 2_592_000_000, keepMissionCopies: false, secretNames: [],
};
const borrower = transitionLoan(createLoan(offer, "borrower", 1000), { type: "accept", borrowerProjectId: "local-project" }, 1000);
const ref = (id: string, personKey = "eva", level: LoanMemoryRef["level"] = "shareable"): LoanMemoryRef =>
  ({ id, personKey, level, contentHash: "a".repeat(64) });

function result(fn: () => unknown) {
  try { return fn(); } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.message };
  }
}

export function buildFederationMemoryVectors() {
  const mixed = [ref("s3"), ref("p1", "eva", "private"), ref("c1", "eva", "confidential"), ref("s2", "chris"), ref("s1")];
  const generation = [mixed, [...mixed].reverse(), [], [ref("a"), ref("a", "other")], [ref("id", "not a key")],
    [{ ...ref("id"), contentHash: "bad" }]];
  const one = makeMemoryBatches(borrower, [ref("m1")])[0]!;
  const overlap = makeMemoryBatches(borrower, [ref("m1"), ref("m2")])[0]!;
  const next = makeMemoryBatches(borrower, [ref("m2")])[0]!;
  const changed = makeMemoryBatches(borrower, [{ ...ref("m1"), contentHash: "b".repeat(64) }])[0]!;
  const moved = makeMemoryBatches(borrower, [ref("m1", "other", "private")])[0]!;
  const privateBatch = makeMemoryBatches(borrower, [ref("p1", "eva", "private")])[0]!;
  const foreignState = transitionLoan(createLoan({ ...offer, loanId: "foreign-loan" }, "borrower", 1000),
    { type: "accept", borrowerProjectId: "local-project" }, 1000);
  const foreign = makeMemoryBatches(foreignState, [ref("m1")])[0]!;
  const inputs: Array<[string, readonly MemoryBatch[], MemoryBatch]> = [
    ["initial", [], one], ["replay", [one], one], ["overlap", [one], overlap], ["different batch same ref", [overlap], next],
    ["content conflict", [one], changed], ["relationship conflict", [one], moved], ["prior conflict", [one, changed], next],
    ["private labeled descriptor", [], privateBatch], ["bad batch digest", [], { ...one, batchId: "c".repeat(64) }],
    ["wrong mission", [], { ...one, loanId: "other" }], ["invalid previous hash", [{ ...one, batchId: "b".repeat(64) }], next],
    ["valid foreign receipt", [], foreign], ["foreign prior", [foreign], next], ["bad order", [], { ...overlap, items: [...overlap.items].reverse() }],
  ];
  const outbox = createMemoryOutbox([one, next]);
  const ackInputs: MemoryAck[] = [
    { loanId: offer.loanId, batchId: one.batchId }, { loanId: offer.loanId, batchId: next.batchId },
    { loanId: "other", batchId: one.batchId }, { loanId: offer.loanId, batchId: "b".repeat(64) },
  ];
  return { memory: {
    offer,
    selected: [[], [ref("s"), ref("c", "chris", "confidential")], [ref("p", "chris", "private")]]
      .map(input => ({ input, result: result(() => selectedHomeMemories(input)) })),
    generation: generation.map(input => ({ input, result: result(() => makeMemoryBatches(borrower, input)) })),
    inbound: inputs.map(([name, received, batch]) => ({ name, received, batch, result: result(() => receiveMemoryBatch(received, offer, batch)) })),
    outbox,
    acks: ackInputs.map(ack => ({ ack, result: result(() => acknowledgeMemoryBatch(outbox, ack)) })),
    use: (["shareable", "confidential", "private"] as const).map(level => ({ level, result: foreignMemoryUse(level) })),
    disposition: [false, true].flatMap(keepMissionCopies => [false, true].flatMap(acknowledged => [false, true].map(ended =>
      ({ keepMissionCopies, acknowledged, ended, result: borrowerMemoryDisposition({ ...offer, keepMissionCopies }, acknowledged, ended) })))),
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "federation", build: buildFederationMemoryVectors });
}
