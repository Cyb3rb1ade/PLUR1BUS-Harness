// Tool names that collide with harness RPC methods/notifications are reserved (D109 §9.4).
// First-party overlap names that composeTools already registers as tools are the exception.
import { METHODS, NOTIFICATIONS } from "@plur1bus/rpc-schema";
import { HOST_TOOLS } from "../host-tools/catalog.ts";

/** Names composeTools registers as tools; derived from composition, not from typing grant.*. */
export const FIRST_PARTY_TOOL_NAMES: ReadonlySet<string> = Object.freeze(new Set([
  "exec.run",
  "media.generate",
  "media.edit",
  "image.generate",
  "image.edit",
  "web.search",
  "memory.recall",
  "memory.capture",
  ...HOST_TOOLS.map((t) => t.name),
]));

const RPC_NAMES: ReadonlySet<string> = new Set([...METHODS, ...NOTIFICATIONS]);
const FIRST_PARTY_PREFIXES: ReadonlySet<string> = new Set(
  [...FIRST_PARTY_TOOL_NAMES].map((n) => n.split(".")[0]!),
);
const RPC_PREFIXES: ReadonlySet<string> = new Set(
  [...RPC_NAMES].map((n) => (n.startsWith("external.turn.") ? "external.turn" : n.split(".")[0]!)),
);

/** True when `name` must not be registered as a tool. */
export function isReservedToolName(name: string): boolean {
  if (FIRST_PARTY_TOOL_NAMES.has(name)) return false;
  if (RPC_NAMES.has(name)) return true;
  if (name.startsWith("external.turn.")) return true;
  const prefix = name.split(".")[0]!;
  return RPC_PREFIXES.has(prefix) && !FIRST_PARTY_PREFIXES.has(prefix);
}
