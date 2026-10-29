import { DatabaseSync } from "node:sqlite";
import type { MemorySensitivityRecord, SensitivityCategory, SensitivitySource } from "./types.ts";

export interface MemorySensitivityStoreOptions {
  path: string;
}

export class MemorySensitivityStore {
  readonly #db: DatabaseSync;

  constructor(options: MemorySensitivityStoreOptions) {
    this.#db = new DatabaseSync(options.path);
    this.#init();
  }

  #init(): void {
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec("PRAGMA busy_timeout = 5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS card_sensitivity (
        card_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        categories TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('rule', 'manual', 'model')),
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_card_sensitivity_hash ON card_sensitivity(content_hash);
    `);
  }

  get(cardId: string): MemorySensitivityRecord | null {
    const row = this.#db
      .prepare("SELECT card_id, content_hash, categories, source, updated_at FROM card_sensitivity WHERE card_id = ?")
      .get(cardId) as { card_id: string; content_hash: string; categories: string; source: string; updated_at: number } | undefined;
    if (!row) return null;
    return {
      cardId: row.card_id,
      contentHash: row.content_hash,
      categories: JSON.parse(row.categories) as SensitivityCategory[],
      source: row.source as SensitivitySource,
      updatedAt: row.updated_at,
    };
  }

  getByHash(contentHash: string): MemorySensitivityRecord | null {
    if (!contentHash) return null;
    const row = this.#db
      .prepare("SELECT card_id, content_hash, categories, source, updated_at FROM card_sensitivity WHERE content_hash = ? ORDER BY updated_at DESC LIMIT 1")
      .get(contentHash) as { card_id: string; content_hash: string; categories: string; source: string; updated_at: number } | undefined;
    if (!row) return null;
    return {
      cardId: row.card_id,
      contentHash: row.content_hash,
      categories: JSON.parse(row.categories) as SensitivityCategory[],
      source: row.source as SensitivitySource,
      updatedAt: row.updated_at,
    };
  }

  set(
    cardId: string,
    categories: readonly SensitivityCategory[],
    source: SensitivitySource,
    contentHash: string,
    nowMs: number = Date.now(),
  ): MemorySensitivityRecord {
    const existing = this.get(cardId);
    if (existing && existing.source === "manual" && source !== "manual") {
      return existing;
    }
    const cats = [...new Set(categories)].sort() as SensitivityCategory[];
    this.#db.prepare(`
      INSERT INTO card_sensitivity (card_id, content_hash, categories, source, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(card_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        categories = excluded.categories,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(cardId, contentHash, JSON.stringify(cats), source, nowMs);

    return {
      cardId,
      contentHash,
      categories: cats,
      source,
      updatedAt: nowMs,
    };
  }

  clear(cardId: string, category?: SensitivityCategory, nowMs: number = Date.now()): { cleared: boolean; remaining: SensitivityCategory[] } {
    const existing = this.get(cardId);
    if (!existing) return { cleared: false, remaining: [] };

    if (!category) {
      this.#db.prepare("DELETE FROM card_sensitivity WHERE card_id = ?").run(cardId);
      return { cleared: true, remaining: [] };
    }

    const remaining = existing.categories.filter((c) => c !== category);
    if (remaining.length === 0) {
      this.#db.prepare("DELETE FROM card_sensitivity WHERE card_id = ?").run(cardId);
      return { cleared: true, remaining: [] };
    }

    this.#db.prepare(`
      UPDATE card_sensitivity
      SET categories = ?, updated_at = ?
      WHERE card_id = ?
    `).run(JSON.stringify(remaining), nowMs, cardId);

    return { cleared: true, remaining };
  }

  close(): void {
    this.#db.close();
  }
}
