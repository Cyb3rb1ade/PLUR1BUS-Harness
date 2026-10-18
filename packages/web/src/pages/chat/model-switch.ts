import type { Api } from "../../api/index.ts";
import "./rpc-types.ts";
export interface ModelSwitchPreview {
  sessionId: string; profile: string; previousProfile: string | null; revision: number; applied: boolean;
  warning: "cache-rebuild-cost-prefixes-preserved";
}
/** Preview is immutable input to confirmation: never reread a changed text field when applying it. */
export async function previewModelSwitch(api: Api, sessionId: string, profile: string): Promise<ModelSwitchPreview> {
  return api.rpc("session.model.set", { sessionId, profile }, { write: true });
}
export async function confirmModelSwitch(api: Api, preview: ModelSwitchPreview): Promise<ModelSwitchPreview> {
  return api.rpc("session.model.set", { sessionId: preview.sessionId, profile: preview.profile, confirmed: true, expectedRevision: preview.revision }, { write: true });
}
