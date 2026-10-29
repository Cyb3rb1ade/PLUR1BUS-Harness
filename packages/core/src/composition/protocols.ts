// Shared with package P. NULL origin is an internal harness session.
import type { SubjectKind } from "../policy/decide.ts";
import { SESSION_ORIGINS, type SessionOrigin } from "../session/types.ts";

export { SESSION_ORIGINS, type SessionOrigin };

export function subjectForOrigin(origin: SessionOrigin | null | undefined): SubjectKind {
  if (origin === "mcp") return "mcp-client";
  if (origin === "a2a") return "a2a-peer";
  if (origin === "acp-agent") return "acp-agent";
  return "agent";
}
