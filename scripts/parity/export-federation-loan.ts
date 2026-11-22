import { pathToFileURL } from "node:url";
import { createLoan, lenderLoanView, modelLease, modelWorkDecision, transitionLoan, type LoanEvent, type LoanOffer,
  type LoanState, type ModelLease } from "../../packages/core/src/federation/loan-model.ts";
import { exporterMain } from "./lib.mjs";

const start = 1_000_000;
const base: LoanOffer = {
  loanId: "mission", agentId: "agent", lenderFingerprint: "home", borrowerFingerprint: "away",
  createdAt: start, expiresAt: start + 2_592_000_000, keepMissionCopies: false, secretNames: ["calendar.read"],
};
type Step =
  | { kind: "event"; at: number; event: LoanEvent }
  | { kind: "renew"; at: number; patch?: Partial<ModelLease>; previous?: boolean }
  | { kind: "lease" | "lender"; at: number }
  | { kind: "work"; at: number; project?: string };
const at = (n: number) => start + n;
const event = (t: number, e: LoanEvent): Step => ({ kind: "event", at: at(t), event: e });
const renew = (t: number, patch?: Partial<ModelLease>): Step => ({ kind: "renew", at: at(t), ...(patch ? { patch } : {}) });
const work = (t: number, project: string | undefined = "project"): Step => ({
  kind: "work", at: at(t), ...(project ? { project } : {}),
});
const accept = event(0, { type: "accept", borrowerProjectId: "project" });
const active = [accept, renew(0)];
const lenderActive = [event(0, { type: "accept" }), renew(0)];

function failure(error: unknown) {
  if (!(error instanceof Error)) throw error;
  return { error: error.message };
}

function scenario(name: string, side: "lender" | "borrower", steps: Step[], patch: Partial<LoanOffer> = {}, now = start) {
  const offer = { ...base, ...patch };
  let state: LoanState;
  try { state = createLoan(offer, side, now); } catch (error) {
    return { name, offer, side, now, initial: failure(error), steps: [] };
  }
  const initial = state;
  const results = steps.map(step => {
    let result: unknown;
    try {
      switch (step.kind) {
        case "event": state = transitionLoan(state, step.event, step.at); result = state; break;
        case "renew": {
          const lease = step.previous ? state.lease! : { ...modelLease(state, step.at), ...step.patch };
          state = transitionLoan(state, { type: "renew", lease }, step.at); result = state; break;
        }
        case "lease": result = modelLease(state, step.at); break;
        case "lender": result = lenderLoanView(state); break;
        case "work": result = modelWorkDecision(state, step.project, step.at); break;
      }
    } catch (error) { result = failure(error); }
    return { step, result };
  });
  return { name, offer, side, now, initial, steps: results };
}

export function buildFederationLoanVectors() {
  return { loan: [
    scenario("work boundaries", "borrower", [
      accept, work(0), renew(0), work(0), work(0, "other"), { kind: "work", at: start }, work(119_999),
      work(120_000), event(119_999, { type: "tick" }), event(120_000, { type: "tick" }), renew(150_000),
      work(269_999), work(270_000), { kind: "lender", at: at(151_000) },
    ]),
    scenario("borrower offline", "borrower", [...active, event(86_399_999, { type: "tick" }),
      event(86_400_000, { type: "tick" }), renew(86_400_000), event(86_400_001, { type: "confirm-removal" })]),
    scenario("lender offline", "lender", [...lenderActive, work(0), event(899_999, { type: "tick" }),
      renew(900_000), event(900_000, { type: "tick" })]),
    scenario("renewal shifts grace", "lender", [...lenderActive, renew(30_000),
      event(929_999, { type: "tick" }), event(930_000, { type: "tick" })]),
    ...(["recall", "revoke", "return"] as const).map(type =>
      scenario(type, "borrower", [...active, event(10, { type }), work(10), renew(20), event(20, { type: "confirm-removal" })])),
    scenario("decline", "borrower", [event(1, { type: "return" }), event(2, { type: "decline" }), renew(3)]),
    scenario("project", "lender", [accept, event(1, { type: "confirm-removal" }), event(2, { type: "accept" })]),
    scenario("missing project", "borrower", [event(0, { type: "accept" }), accept, accept]),
    scenario("short offer", "borrower", [...active, { kind: "lease", at: at(10_000) }, work(59_999), work(60_000),
      event(60_000, { type: "tick" }), { kind: "lease", at: at(60_000) }], { expiresAt: at(60_000) }),
    scenario("expired on creation", "borrower", [work(60_000), accept], { expiresAt: at(60_000) }, at(60_000)),
    scenario("oversized duration", "borrower", [], { expiresAt: at(2_592_000_001) }),
    scenario("invalid offer time", "borrower", [], { createdAt: Number.MAX_SAFE_INTEGER + 1 }),
    scenario("invalid secret reference", "borrower", [], { secretNames: ["invalid=value"] }),
    scenario("same peers", "borrower", [], { lenderFingerprint: base.borrowerFingerprint }),
    scenario("invalid id", "borrower", [], { loanId: "invalid id" }),
    scenario("clock rollback", "borrower", [...active, work(-1), event(-1, { type: "tick" }), renew(-1)]),
    scenario("wrong leases", "borrower", [...active,
      renew(30_000, { loanId: "foreign" }), renew(30_000, { agentId: "foreign" }),
      renew(30_000, { borrowerFingerprint: "foreign" }), renew(30_000, { issuedAt: at(30_001) }),
      renew(30_000, { notAfter: at(150_001) }), renew(30_000, { notAfter: at(30_000) }),
      { kind: "renew", at: at(30_000), previous: true }, renew(30_000), renew(30_001, { issuedAt: at(29_999) }),
      renew(60_000, { notAfter: at(90_000) }),
    ]),
  ] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "federation", build: buildFederationLoanVectors });
}
