// D109 §9 (D5): headless and unattended runs. A job runs under its owner's principal and may use ONLY standing grants created for
// that job (`decide()` already filters grants that way: scope `always` with `jobId`; session and task grants of the person who
// created the job never carry over). When no such grant covers an approval-class call, the owner's ruling for D5 is that the call
// is refused at once, as a `never`: nothing is asked, nothing parks, nothing waits. Silence is never approval.
//
// (The spec text of §9 says the job "parks and notifies". The task for D5 asks for deny without waiting; this gate implements the
// task. Parking can be added later by letting the gate pass an `ask` through again.)
import type { Context, Decision } from "./decide.ts";

export const HEADLESS_RULE = "headless:no-job-grant";

export function headlessGate(decision: Decision, ctx: Pick<Context, "headless">): Decision {
  if (decision.kind === "ask" && (ctx.headless !== undefined || decision.park)) {
    return { kind: "deny", reason: "policy-never", rule: HEADLESS_RULE };
  }
  return decision;
}
