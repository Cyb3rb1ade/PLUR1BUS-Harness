// Stable tool offers (N-F1–F3): scoped core tools first, then retained session offers and newly relevant tools.
/** The fixed discovery/read core has priority over the session's accumulated relevant tools. */
export const CORE_TOOL_NAMES: readonly string[] = Object.freeze([
  "capabilities.search", "skill.load", "skill.read", "file.read", "file.list", "file.stat",
  "web.search", "web.fetch",
]);
/** Already-admitted tool names and the effective model-family tool cap at the current turn boundary. */
