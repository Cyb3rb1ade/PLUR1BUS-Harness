/** A supervised import must not commit operationally rejected selected cards. Legacy report shapes remain intact. */
import { ImportError } from "./types.ts";

interface CardResult { outcome: string; reason?: string | undefined }
interface Report {
  errors: readonly unknown[];
  agents?: readonly { memory?: { cardResults: readonly CardResult[] } | undefined }[] | undefined;
  profilesOrAgents?: readonly { memory?: { cardResults: readonly CardResult[] } | undefined }[] | undefined;
}

// Existing semantic refusals are valid import outcomes; failures of embedding/storage are not successful writes.
// ADR-007 Q4 keeps unresolved user cards unbound, and tombstones must never be bypassed by a retry.
const SEMANTIC_REJECTIONS = new Set(["unresolved-user-scope", "previously-imported-deleted", "tombstone-blocked",
  "empty-text", "invalid-input", "principal-unresolved", "provenance-not-imported", "duplicate-in-batch"]);

/** Classify Engine operational rejection codes without copying messages or card content into diagnostics. */
export function isOperationalCardRejection(card: CardResult): boolean {
  return card.outcome === "rejected" && !SEMANTIC_REJECTIONS.has(card.reason ?? "");
}

/** Reject operational failures before the maintenance worker commits; no source content enters the error. */
export function assertImportReportComplete(report: Report): void {
  const agents = report.profilesOrAgents ?? report.agents ?? [];
  if (report.errors.length || agents.some(agent => agent.memory?.cardResults.some(isOperationalCardRejection))) {
    throw new ImportError("E_IMPORT_FAILED", "entity-failed", "Import entity failed");
  }
}
