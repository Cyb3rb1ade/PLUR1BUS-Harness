import { existsSync, readFileSync } from "node:fs";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { createRedactor } from "../../logs/redact.ts";
import { MEMORY_EXPORT_CATEGORIES, type MemoryExportCategory } from "./types.ts";

function findExportPromptText(): string {
  const candidates = [
    new URL("./export-prompt.md", import.meta.url),
    new URL("../src/import/prompt/export-prompt.md", import.meta.url),
    new URL("../../src/import/prompt/export-prompt.md", import.meta.url),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return readFileSync(c, "utf8");
    } catch {
      // ignore
    }
  }
  return "";
}

export const EXPORT_PROMPT_TEXT = findExportPromptText();

export interface ExportMemoriesOptions {
  principal: E.Principal;
  engine: E.Engine;
  agentId?: string | undefined;
  options?: { now?: number } | undefined;
}

const USER_CONTEXT: E.AgentContext = Object.freeze({
  origin: "user",
  background: false,
});

function formatCardDate(createdAt?: number): string {
  if (!createdAt || createdAt <= 0) return "[unknown]";
  const d = new Date(createdAt);
  if (isNaN(d.getTime())) return "[unknown]";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `[${yyyy}-${mm}-${dd}]`;
}

function normalizeCategory(kind?: string): MemoryExportCategory {
  if (!kind) return "Other";
  const lower = kind.trim().toLowerCase();
  for (const cat of MEMORY_EXPORT_CATEGORIES) {
    if (cat.toLowerCase() === lower) return cat;
  }
  return "Other";
}

export async function exportMemoriesAsText(
  opts: ExportMemoriesOptions,
): Promise<string> {
  const { principal, engine, agentId } = opts;
  const redactor = createRedactor();

  const cardsToExport: Array<{
    category: MemoryExportCategory;
    createdAt: number;
    text: string;
  }> = [];

  // 1. Fetch user-scope memories
  try {
    const listRes = await engine.memory.list(
      { limit: 5000 },
      principal,
      USER_CONTEXT,
    );
    for (const item of listRes.items ?? []) {
      // Filter out tombstones/deleted if any marked
      if (item.scope === "user") {
        cardsToExport.push({
          category: normalizeCategory((item as any).kind ?? (item as any).category),
          createdAt: item.createdAt ?? 0,
          text: item.text,
        });
      }
    }
  } catch {
    // If listing fails or empty, continue
  }

  // 2. Fetch agent-private memories if agentId specified
  if (agentId) {
    try {
      const agentRes = await engine.memory.list(
        { limit: 5000 },
        { ...principal, agentId },
        USER_CONTEXT,
      );
      for (const item of agentRes.items ?? []) {
        if (item.scope === "agent-private") {
          cardsToExport.push({
            category: normalizeCategory((item as any).kind ?? (item as any).category),
            createdAt: item.createdAt ?? 0,
            text: item.text,
          });
        }
      }
    } catch {
      // Continue
    }
  }

  // Group by category
  const grouped = new Map<MemoryExportCategory, Array<{ createdAt: number; text: string }>>();
  for (const cat of MEMORY_EXPORT_CATEGORIES) {
    grouped.set(cat, []);
  }

  for (const card of cardsToExport) {
    const list = grouped.get(card.category) ?? [];
    list.push({ createdAt: card.createdAt, text: card.text });
    grouped.set(card.category, list);
  }

  // Build text output
  const lines: string[] = ["PLUR1BUS-MEMORY-EXPORT v1"];

  for (const cat of MEMORY_EXPORT_CATEGORIES) {
    lines.push(`## ${cat}`);
    const items = grouped.get(cat) ?? [];
    // Sort oldest first (ascending createdAt)
    items.sort((a, b) => a.createdAt - b.createdAt);

    for (const item of items) {
      const dateToken = formatCardDate(item.createdAt);
      const cleanText = redactor.text(item.text.trim().replace(/\r?\n/g, " "));
      lines.push(`${dateToken} [memory] - ${cleanText}`);
    }
  }

  lines.push("STATUS: COMPLETE");
  return lines.join("\n") + "\n";
}
