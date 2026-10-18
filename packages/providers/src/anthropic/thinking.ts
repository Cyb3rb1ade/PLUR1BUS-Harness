// Opaque signed blocks are turn-local transport state. WeakMap metadata never enters JSON, logs or session storage.
export type ThinkingBlock = {type: "thinking"; thinking: string; signature: string} | {type: "redacted_thinking"; data: string};
const blocks = new WeakMap<object, {model: string; blocks: readonly ThinkingBlock[]}>();
export function keepThinking(target: object, model: string, value: readonly ThinkingBlock[]): void {
  if (value.length) blocks.set(target, {model, blocks:value.map(b=>Object.freeze({...b}))});
}
export function thinkingFor(target: object, model: string): readonly ThinkingBlock[] {
  const held=blocks.get(target);return held?.model===model?held.blocks:[];
}
export function carryThinking<T extends object>(from: object, to: T): T {
  const held=blocks.get(from);if(held)blocks.set(to,held);return to;
}

/** Bind aliases to the requested model identity, so signatures cannot cross a fallback model. */
export function bindThinkingModel<T extends object>(result: T, model: string): T {
 const held=blocks.get(result);if(held)blocks.set(result,{...held,model});return result;
}

export function hasThinking(target: object): boolean {return blocks.has(target);}
