import type { ContextBlock, Deferral } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

const SEP = "\n\n";

/** I4: a clip length that never ends on a high surrogate, so a non-BMP character (emoji, CJK extension) is kept
 *  or cut whole. A lone surrogate would reach JSON as `\ud83d`, which serde_json (the Rust CLI) refuses. */
function safeKeep(text: string, keep: number): number {
  if (keep <= 0) return 0;
  const unit = text.charCodeAt(keep - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? keep - 1 : keep;
}

/**
 * The harness's own join (spec §6.6 --joined): order preserved, non-empty blocks separated by a blank line, total ≤ capChars.
 * Over the cap, clipping is preferred to dropping: scanning from the last block backwards, the first droppable block that can
 * absorb the whole overflow and keep at least one character is clipped. When no droppable block can, the last non-empty
 * droppable block is dropped and the scan repeats. A non-droppable block is never touched, so the result can stay over the
 * cap when nothing droppable is left. Deferrals are reported in block order.
 */
export function joinBlocks(blocks: ContextBlock[], capChars: number): { text: string; deferrals: Deferral[] } {
  const parts = blocks.map((b, index) => ({ name: b.name, text: b.text, droppable: b.droppable, index }));
  const deferrals: Array<Deferral & { index: number }> = [];
  const joined = () => parts.filter((p) => p.text.length).map((p) => p.text).join(SEP);
  for (let over = joined().length - capChars; over > 0; over = joined().length - capChars) {
    const candidates = parts.filter((p) => p.droppable && p.text.length).reverse();
    if (!candidates.length) break;
    const clip = candidates.find((p) => p.text.length > over && safeKeep(p.text, p.text.length - over) > 0);
    if (clip) {
      const keep = safeKeep(clip.text, clip.text.length - over);
      deferrals.push({ block: clip.name, kind: "clipped", from: clip.text.length, to: keep, reason: "global-cap", index: clip.index });
      clip.text = clip.text.slice(0, keep);
    } else {
      const drop = candidates[0]!;
      deferrals.push({ block: drop.name, kind: "dropped", from: drop.text.length, to: 0, reason: "global-cap", index: drop.index });
      drop.text = "";
    }
  }
  return { text: joined(), deferrals: deferrals.sort((a, b) => a.index - b.index).map(({ index: _i, ...d }) => d) };
}
