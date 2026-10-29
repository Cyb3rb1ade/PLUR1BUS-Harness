import { computeContentHash, SensitivityScanner } from "./scanner.ts";
import { MemorySensitivityStore } from "./store.ts";
import type { MemorySensitivityRecord, SensitivityCategory } from "./types.ts";

export interface MemorySensitivityServiceOptions {
  store: MemorySensitivityStore;
  scanner?: SensitivityScanner;
  localModelClassifier?: (text: string, summary?: string) => Promise<SensitivityCategory[]>;
}

export class MemorySensitivityService {
  readonly store: MemorySensitivityStore;
  readonly scanner: SensitivityScanner;
  readonly #localModelClassifier?: (text: string, summary?: string) => Promise<SensitivityCategory[]>;

  constructor(options: MemorySensitivityServiceOptions) {
    this.store = options.store;
    this.scanner = options.scanner ?? new SensitivityScanner();
    this.#localModelClassifier = options.localModelClassifier;
  }

  async assessCard(card: { id: string; text: string; summary?: string }): Promise<SensitivityCategory[]> {
    const hash = computeContentHash(card.text, card.summary);

    // 1. Check if card ID already has a record with matching content hash
    const existing = this.store.get(card.id);
    if (existing) {
      if (existing.source === "manual" || existing.contentHash === hash) {
        return existing.categories;
      }
    }

    // 2. Check identical content hash in other cards
    const cachedByHash = this.store.getByHash(hash);
    if (cachedByHash) {
      this.store.set(card.id, cachedByHash.categories, cachedByHash.source, hash);
      return cachedByHash.categories;
    }

    // 3. Scan by rules
    const detected = this.scanner.scan(card.text, card.summary);

    // 4. If local model classifier is configured, combine with its predictions
    if (this.#localModelClassifier) {
      try {
        const fromModel = await this.#localModelClassifier(card.text, card.summary);
        for (const cat of fromModel) {
          if (!detected.includes(cat)) {
            detected.push(cat);
          }
        }
      } catch {
        // Fallback to rules on local model failure
      }
    }

    detected.sort();
    this.store.set(card.id, detected, "rule", hash);
    return detected;
  }

  setSensitivity(
    cardId: string,
    categories: readonly SensitivityCategory[],
    card?: { text: string; summary?: string },
  ): MemorySensitivityRecord {
    const hash = card ? computeContentHash(card.text, card.summary) : (this.store.get(cardId)?.contentHash ?? "");
    return this.store.set(cardId, categories, "manual", hash);
  }

  clearSensitivity(
    cardId: string,
    category?: SensitivityCategory,
  ): { cleared: boolean; remaining: SensitivityCategory[] } {
    return this.store.clear(cardId, category);
  }

  getSensitivity(cardId: string): MemorySensitivityRecord | null {
    return this.store.get(cardId);
  }

  close(): void {
    this.store.close();
  }
}
