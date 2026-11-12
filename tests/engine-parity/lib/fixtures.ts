import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertNoMarkers, isRecord } from "./diff.ts";

type Prompt = { role: string; content: string }[];

export function promptHash(messages: Prompt): string {
  return createHash("sha256").update(JSON.stringify(messages.map(({ role, content }) => [role, content]))).digest("hex");
}

/** Missing answers are sticky because an engine can degrade and catch the port error. */
export function fixtureLlm(file: string) {
  const answers: unknown = JSON.parse(readFileSync(file, "utf8"));
  assertNoMarkers(answers, "LLM fixture");
  if (!isRecord(answers)) throw new Error("LLM fixture must map prompt hashes to responses");
  for (const [hash, value] of Object.entries(answers)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !isRecord(value) || typeof value.text !== "string") {
      throw new Error("invalid LLM fixture entry");
    }
  }
  let failure: Error | undefined;
  return {
    async complete({ messages }: { messages: Prompt }): Promise<{ text: string }> {
      assertNoMarkers(messages, "LLM prompt");
      const hash = promptHash(messages);
      const answer = answers[hash];
      if (isRecord(answer) && typeof answer.text === "string") return { text: answer.text };
      const excerpt = messages.map(message => message.content).join("\n").slice(0, 80);
      failure ??= new Error(`missing LLM fixture ${hash} for ${JSON.stringify(excerpt)}`);
      throw failure;
    },
    check(): void {
      if (failure) throw failure;
    },
  };
}
