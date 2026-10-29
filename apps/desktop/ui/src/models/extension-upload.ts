// File offers carry a native mailbox id; this model never receives a local path or package bytes.
export type UploadConnection = { id: string; origin: string };
import { createStepUp } from "./stepup.ts";
export function createExtensionUpload(linkId: number) {
    let rows: UploadConnection[] = [];
    let selected: string | null = null;
    let busy = false;
    let done = false;
    let failed = false;
    let mfaRequired = false;
    let approval: {id: string; model: ReturnType<typeof createStepUp>} | null = null;
    return {
        get selected() { return selected; }, get busy() { return busy; }, get done() { return done; }, get failed() { return failed; },
        get mfaRequired() { return mfaRequired; },
        get approval() {
            const row = rows.find(row => row.id === selected);
            if (!row) return null;
            if (approval?.id !== row.id) approval = {id: row.id, model: createStepUp(row, "extensions")};
            return approval.model;
        },
        connections(value: UploadConnection[]) {
            rows = value;
            if (!rows.some(row => row.id === selected)) selected = rows.length === 1 ? rows[0]!.id : null;
        },
        choose(id: string) { if (!busy) selected = rows.some(row => row.id === id) ? id : null; },
        async review(send: (request: { linkId: number; connectionId: string }) => Promise<unknown>): Promise<boolean> {
            if (!selected || busy || done) return false;
            busy = true; failed = false; mfaRequired = false;
            try { await send({ linkId, connectionId: selected }); done = true; return true; }
            catch (error) { failed = true; mfaRequired = error === "second-factor-required"; return false; }
            finally { busy = false; }
        },
    };
}
