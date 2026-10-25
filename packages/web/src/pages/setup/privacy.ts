import type { PrivacyAcknowledgment } from "../../../../config-schema/src/privacy.ts";
import { effectiveCaption } from "../media-search/model.ts";
import { memoryChoice } from "./licences.ts";
import type { Answers, Change } from "./model.ts";
export type SetupPrivacy = {
    media?: PrivacyAcknowledgment;
    caption?: PrivacyAcknowledgment;
};
/** No text-cloud choice exists. Each exposed cloud function requires a separate confirmation. */
export function cloudFunctions(a: Answers): {
    function: "media" | "caption";
    provider: string;
}[] {
    if (!a.media.enabled)
        return [];
    const out: {
        function: "media" | "caption";
        provider: string;
    }[] = [];
    const caption = effectiveCaption(a.media, memoryChoice("embedding", a.embedding, a.memoryModels));
    if (a.media.captionSource !== "off" && caption && caption !== "local" && caption !== "off")
        out.push({ function: "caption", provider: caption });
    return out;
}
export function missingPrivacy(a: Answers): boolean {
    return cloudFunctions(a).some(c => a.privacy?.[c.function]?.provider !== c.provider);
}
/** Replace the affected parent, preserving unrelated fields while deleting the old confirmation.
 * Revision checking belongs to the caller. Generic config.set needs the same rule in the future transport. */
export function privacyChanges(a: Answers, changes: Change[], previous: unknown, personId: string): Change[] {
    const base = previous && typeof previous === "object" ? structuredClone(previous) as Record<string, any> : {};
    const relevant = changes.filter(c => c.key.startsWith("memory.mediaEmbedding."));
    const needs = relevant.some(c => c.key.endsWith(".provider")) || cloudFunctions(a).length > 0;
    if (!needs)
        return changes;
    for (const c of relevant) {
        const parts = c.key.slice("memory.mediaEmbedding.".length).split(".");
        let dst = base;
        for (const key of parts.slice(0, -1))
            dst = dst[key] ??= {};
        const key = parts.at(-1)!;
        if (key === "provider")
            delete dst.privacyAck;
        dst[key] = c.value;
    }
    for (const c of cloudFunctions(a)) {
        const ack = a.privacy?.[c.function];
        if (!ack || ack.provider !== c.provider)
            throw new Error("privacy acknowledgment required");
        const dst = c.function === "caption" ? base.caption ??= {} : base;
        // Never trust a saved/browser-supplied identity as the current writer.
        dst.privacyAck = { provider: c.provider, acknowledgedAt: ack.acknowledgedAt, by: personId };
    }
    return [...changes.filter(c => !c.key.startsWith("memory.mediaEmbedding.")), { key: "memory.mediaEmbedding", value: base }];
}
