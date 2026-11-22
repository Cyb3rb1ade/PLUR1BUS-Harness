import { fileURLToPath } from "node:url";
import { buildAgentCard, validateAgentCard } from "../../packages/core/src/a2a/card.ts";
import { exporterMain } from "./lib.mjs";

export function recordCards() {
  const cases = [
    { id: "example", base: "https://agents.example.invalid", version: "2.0", info: { optIn: true } },
    {
      id: "fixture-a",
      base: "https://agents.example.invalid/public///",
      version: "2.1",
      features: { streaming: false, pushNotifications: true },
      info: {
        optIn: true,
        displayName: "  Field\tNotes  ",
        description: "    ",
        defaultInputModes: ["", "text/markdown", ...Array.from({ length: 10 }, (_, i) => `fixture/${i}`)],
        defaultOutputModes: [""],
        skills: [{
          id: "convert",
          name: " ".repeat(2) + "X".repeat(82),
          tags: ["  ", ...Array.from({ length: 9 }, (_, i) => `t${i}`)],
          inputModes: ["text/plain", "  application/json"],
          outputModes: [""],
        }],
        internalNote: "synthetic-private-card-marker",
      },
    },
    {
      id: "books",
      base: "https://agents.example.invalid/catalog/",
      version: "2.1",
      features: { streaming: true, pushNotifications: false },
      info: {
        optIn: true,
        displayName: "📚".repeat(40) + "A",
        skills: Array.from({ length: 33 }, (_, i) => ({ id: `s${i}`, name: `Skill ${i}` })),
      },
    },
  ];
  return { cards: { source: "packages/core/src/a2a/card.ts", cases: cases.map(input => {
    const expected = buildAgentCard(input.id, input.info, input.base, input.version, input.features);
    if (validateAgentCard(expected).length !== 0) throw new Error("invalid recorded Agent Card");
    return { input, expected };
  }) } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "a2a", build: recordCards });
}
