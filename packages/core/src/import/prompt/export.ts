import { existsSync, readFileSync } from "node:fs";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { createRedactor } from "../../logs/redact.ts";
import type { MemorySensitivityService } from "../../memory-sensitivity/service.ts";
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
  sensitivityService?: MemorySensitivityService | null | undefined;
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

export function normalizeCategory(kind?: string): MemoryExportCategory {
  if (!kind) return "Other";
  const lower = kind.trim().toLowerCase();
  for (const cat of MEMORY_EXPORT_CATEGORIES) {
    if (cat.toLowerCase() === lower) return cat;
  }
  return "Other";
}

function extractCategory(card: any): MemoryExportCategory {
  if (card.sourceRef && typeof card.sourceRef === "string") {
    const m = /category=([A-Za-z]+)/.exec(card.sourceRef);
    if (m && m[1]) {
      const norm = normalizeCategory(m[1]);
      if (norm !== "Other") return norm;
    }
  }
  if (card.kind) {
    const norm = normalizeCategory(card.kind);
    if (norm !== "Other") return norm;
  }
  if (card.category) {
    const norm = normalizeCategory(card.category);
    if (norm !== "Other") return norm;
  }
  const textLower = (card.text || "").toLowerCase();
  if (textLower.includes("prefer") || textLower.includes("likes") || textLower.includes("vorliebe") || textLower.includes("mag ")) {
    return "Preferences";
  }
  if (textLower.includes("project") || textLower.includes("projekt") || textLower.includes("repo")) {
    return "Projects";
  }
  if (card.scope === "user") {
    return "Identity";
  }
  return "Other";
}

async function fetchAllCardsForScope(
  engine: E.Engine,
  principal: E.Principal,
  scope: "user" | "agent-private",
): Promise<Array<any>> {
  const cards: any[] = [];
  let currentSince = 0;
  for (;;) {
    const res = await engine.memory.list(
      { since: currentSince, limit: 100 },
      principal,
      USER_CONTEXT,
    );
    for (const item of res.items ?? []) {
      if (item.scope === scope) {
        cards.push(item);
      }
    }
    if (!res.truncated || !res.items || res.items.length === 0) {
      break;
    }
    let maxCreated = currentSince;
    for (const it of res.items) {
      if (typeof it.createdAt === "number" && it.createdAt > maxCreated) {
        maxCreated = it.createdAt;
      }
    }
    if (maxCreated <= currentSince) {
      currentSince = currentSince + 1;
    } else {
      currentSince = maxCreated + 1;
    }
  }
  return cards;
}

export async function exportMemoriesAsText(
  opts: ExportMemoriesOptions,
): Promise<string> {
  const { principal, engine, agentId, sensitivityService } = opts;
  const redactor = createRedactor();

  const cardsToExport: Array<{
    category: MemoryExportCategory;
    createdAt: number;
    text: string;
  }> = [];

  // 1. Fetch user-scope memories (B2: page with since: 0, limit: 100)
  const userItems = await fetchAllCardsForScope(engine, principal, "user");
  for (const item of userItems) {
    if (sensitivityService) {
      const cats = await sensitivityService.assessCard({ id: item.id, text: item.text, summary: item.summary });
      if (cats && cats.length > 0) {
        continue; // M9: exclude sensitivity-marked cards from portable export
      }
    }
    cardsToExport.push({
      category: extractCategory(item),
      createdAt: item.createdAt ?? 0,
      text: item.text,
    });
  }

  // 2. Fetch agent-private memories if agentId specified
  if (agentId) {
    const agentPrincipal: E.Principal = {
      ...principal,
      agentId,
    };
    const agentItems = await fetchAllCardsForScope(engine, agentPrincipal, "agent-private");
    for (const item of agentItems) {
      if (sensitivityService) {
        const cats = await sensitivityService.assessCard({ id: item.id, text: item.text, summary: item.summary });
        if (cats && cats.length > 0) {
          continue; // M9: exclude sensitivity-marked cards from portable export
        }
      }
      cardsToExport.push({
        category: extractCategory(item),
        createdAt: item.createdAt ?? 0,
        text: item.text,
      });
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
