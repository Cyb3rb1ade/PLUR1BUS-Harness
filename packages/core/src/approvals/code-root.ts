/** Q25 trusted request builder. Only CodingSessions calls this port; tool/model arguments cannot select its origin. */
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { decide, type SurfaceTrust } from "../policy/index.ts";
import type { ApprovalAsk } from "../tools/approval.ts";
import { GrantError } from "../grants/store.ts";

export interface CodeRootRequest {
  root: string;
  person: string;
  agentId: string;
  sessionId: string;
  surface: SurfaceTrust;
  signal: AbortSignal;
  /** Live host predicate; a disconnected/ended session cannot be approved, including after a Core restart. */
  sessionActive(): boolean;
  projectId?: string;
}

/** The root, write access, recursive match and maximum session scope are computed by trusted Harness code. */
export function codeRootAsk(input: CodeRootRequest, reachesSystemTree: (root: string) => boolean): ApprovalAsk {
  if (
    !input.person ||
    !input.agentId ||
    !input.sessionId ||
    input.signal.aborted ||
    !input.sessionActive() ||
    input.surface < 1 ||
    !isAbsolute(input.root) ||
    realpathSync.native(input.root) !== input.root ||
    reachesSystemTree(input.root)
  ) {
    throw new GrantError("invalid-grant", "code folder request is protected, cancelled or has no authenticated person");
  }
  const args = {
    origin: "code-session-root",
    root: input.root,
    access: "write",
    recursive: true,
    sessionId: input.sessionId,
    agentId: input.agentId,
    person: input.person,
  };
  const actionHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
  const decision = decide(
    {
      capability: "fs.write",
      tool: "code.session.open",
      effect: "local-write",
      actionHash,
      flags: { outsideRoots: true, denyListHit: false },
      targets: [input.root],
      access: "write",
    },
    {
      principal: { person: input.person },
      subject: { kind: "agent", agentId: input.agentId },
      surface: input.surface,
      sessionId: input.sessionId,
    },
    { grants: { list: () => [], get: () => undefined }, clock: { now: () => 0 } },
  );
  if (decision.kind !== "ask")
    throw new GrantError("invalid-grant", "code folder permission is not an approval request");
  const grantOptions = decision.request.grantOptions.filter((option) => option.scope === "session");
  if (grantOptions.length !== 1)
    throw new GrantError("invalid-grant", "session scope is unavailable for this code folder");
  return {
    request: { ...decision.request, grantOptions },
    tool: "code.session.open",
    callId: `code-root_${randomUUID()}`,
    args,
    agentId: input.agentId,
    principal: input.person,
    sessionId: input.sessionId,
    park: false,
    signal: input.signal,
    targets: [input.root],
    access: "write",
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
}
