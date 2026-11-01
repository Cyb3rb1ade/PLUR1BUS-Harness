import { existsSync, readFileSync } from "node:fs";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { RpcError } from "../../rpc/errors.ts";
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
  /**
   * Agents whose tables are read for the person's user-scope cards. The engine keeps a user-scope card in the table
   * of the agent it was written through. The host passes the places such a card can be: the first agent, the requested
   * agent and the agents of the person's own import runs. Default: the principal's agent.
   */
  userScopeAgents?: string[] | undefined;
  /** The principal to read one agent's table with (its own workspace); default: the principal with that agent id. */
  principalFor?: ((agentId: string) => E.Principal) | undefined;
  sensitivityService?: MemorySensitivityService | null | undefined;
  options?: { now?: number } | undefined;
}

const USER_CONTEXT: E.AgentContext = Object.freeze({
  origin: "user",
  background: false,
});

function formatCardDate(createdAt?: number, sourceRef?: string): string {
  if (sourceRef && typeof sourceRef === "string" && sourceRef.includes("dateUnknown")) {
    return "[unknown]";
  }
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
  const seenIds = new Set<string>();
  let currentUntil: number | undefined = Number.MAX_SAFE_INTEGER;
  const HARD_CAP = 10_000;

  for (;;) {
    const query: { since: number; limit: number; until?: number } = { since: 0, limit: 100 };
    if (typeof currentUntil === "number") {
      query.until = currentUntil;
    }
    const res = await engine.memory.list(
      query,
      principal,
      USER_CONTEXT,
    );
    const items = res.items ?? [];
    let newItemsInPage = 0;
    let minCreated = Infinity;
    let maxCreated = -Infinity;

    for (const item of items) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        newItemsInPage++;
        if (item.scope === scope) {
          cards.push(item);
        }
      }
      if (typeof item.createdAt === "number") {
        if (item.createdAt < minCreated) minCreated = item.createdAt;
        if (item.createdAt > maxCreated) maxCreated = item.createdAt;
      }
    }

    if (seenIds.size > HARD_CAP) {
      throw new RpcError("E_NOT_AVAILABLE", "engine memory listing is truncated", { reason: "memory-export-truncated" });
    }

    if (!res.truncated || items.length === 0) {
      break;
    }

    if (newItemsInPage === 0 || !Number.isFinite(minCreated) || minCreated === maxCreated) {
      throw new RpcError("E_NOT_AVAILABLE", "engine memory listing is truncated", { reason: "memory-export-truncated" });
    }

    currentUntil = minCreated;
  }
  return cards;
}

export async function exportMemoriesAsText(
  opts: ExportMemoriesOptions,
): Promise<string> {
  const { principal, engine, agentId, sensitivityService } = opts;
  const asAgent = (ag: string): E.Principal => (opts.principalFor ? opts.principalFor(ag) : { ...principal, agentId: ag });
  const userScopeAgents = opts.userScopeAgents && opts.userScopeAgents.length > 0 ? opts.userScopeAgents : [principal.agentId];
  const redactor = createRedactor();

  const cardsToExport: Array<{
    category: MemoryExportCategory;
    createdAt: number;
    text: string;
    sourceRef?: string;
  }> = [];

  // 1. Fetch user-scope memories (B2: page with since: 0, limit: 100)
  // M2: read the user scope through every agent (a read that fails throws: no COMPLETE for an unread table);
  // the same text imported through several agents is exported once.
  const userItems: any[] = [];
  const seenUserText = new Set<string>();
  const unread: Array<{ agentId: string; reason: string }> = [];
  // One agent that cannot be read (not pageable, no workspace directory, ...) must not take the export down: it is
  // reported as unread and the status becomes PARTIAL; everything else is still exported in full.
  const readAgent = async (ag: string, scope: "user" | "agent-private"): Promise<any[] | null> => {
    try {
      return await fetchAllCardsForScope(engine, asAgent(ag), scope);
    } catch (err) {
      const reason = err instanceof RpcError && err.reason ? err.reason : "read-failed";
      if (!unread.some((u) => u.agentId === ag && u.reason === reason)) unread.push({ agentId: ag, reason });
      return null;
    }
  };
  for (const ag of userScopeAgents) {
    const items = await readAgent(ag, "user");
    if (!items) continue;
    for (const item of items) {
      const key = `${extractCategory(item)}\u0000${String(item.text ?? "").trim().toLowerCase()}`;
      if (seenUserText.has(key)) continue;
      seenUserText.add(key);
      userItems.push(item);
    }
  }
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
      ...(item.sourceRef !== undefined ? { sourceRef: item.sourceRef } : {}),
    });
  }

  // 2. Fetch agent-private memories if agentId specified
  if (agentId) {
    const agentItems = (await readAgent(agentId, "agent-private")) ?? [];
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
        ...(item.sourceRef !== undefined ? { sourceRef: item.sourceRef } : {}),
      });
    }
  }

  // Group by category
  const grouped = new Map<MemoryExportCategory, Array<{ createdAt: number; text: string; sourceRef?: string }>>();
  for (const cat of MEMORY_EXPORT_CATEGORIES) {
    grouped.set(cat, []);
  }

  for (const card of cardsToExport) {
    const list = grouped.get(card.category) ?? [];
    list.push({
      createdAt: card.createdAt,
      text: card.text,
      ...(card.sourceRef !== undefined ? { sourceRef: card.sourceRef } : {}),
    });
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
      const dateToken = formatCardDate(item.createdAt, item.sourceRef);
      const cleanText = redactor.text(item.text.trim().replace(/\r?\n/g, " "));
      lines.push(`${dateToken} [memory] - ${cleanText}`);
    }
  }

  if (unread.length === 0) {
    lines.push("STATUS: COMPLETE");
  } else {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
    const detail = unread.map((u) => `${safe(u.agentId)}: ${safe(u.reason)}`).join("; ");
    lines.push(`STATUS: PARTIAL (not read: ${detail})`);
  }
  return lines.join("\n") + "\n";
}
