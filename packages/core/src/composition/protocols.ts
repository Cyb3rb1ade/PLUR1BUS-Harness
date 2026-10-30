import type { SubjectKind } from "../policy/decide.ts";
import type { SessionOrigin } from "../session/types.ts";

/**
 * Shared M6-A / M6-B contract: maps a session's immutable `origin` to its D109 `SubjectKind`
 * (`mcp` -> `mcp-client`, `a2a` -> `a2a-peer`, `acp-agent` -> `acp-agent`, `NULL`/`undefined` -> `agent`).
 */
export function subjectForOrigin(origin: SessionOrigin | null | undefined): SubjectKind {
  switch (origin) {
    case "mcp":
      return "mcp-client";
    case "a2a":
      return "a2a-peer";
    case "acp-agent":
      return "acp-agent";
    default:
      return "agent";
  }
}
