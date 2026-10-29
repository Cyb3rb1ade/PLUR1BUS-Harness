/** A GUI-selected store needs an actual Engine verdict; legacy CLI routing stays unchanged. */
import { ImportError } from "./types.ts";

interface SelectedOptions { adoptStoreId?: string; adoptStrategy?: string; onConflict?: string }
interface StoreReport { sourceType?: string; stores?: readonly { storeId: string; action: string; reasons: readonly string[] }[] }

export function requireSelectedStoreTransfer(report: StoreReport, options: SelectedOptions): "accepted" | "skipped" | undefined {
  if (!options.adoptStoreId) return undefined;
  const store = report.stores?.find(item => item.storeId === options.adoptStoreId);
  if (store && ["preview-ok", "taken-over", "matched-existing"].includes(store.action)) return "accepted";
  if (options.adoptStrategy !== "re-embed" && options.onConflict === "skip" && store?.action === "skipped"
    && store.reasons.includes("store-exists-skipped")) return "skipped";
  throw new ImportError("E_STORE_INCOMPATIBLE", "source-store-probe-failed", "Selected store could not be verified for transfer");
}
