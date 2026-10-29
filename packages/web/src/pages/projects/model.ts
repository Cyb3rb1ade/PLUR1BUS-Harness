// Core data model and pure state transforms for the Projects Kanban board.
import type {
  BoardCard,
  BoardColumn,
  BoardActor,
  Project,
} from "./rpc-types.ts";
import { t, type Key } from "../../i18n.ts";

export interface BoardFilters {
  search: string;
  assignee: string | null;
  label: string | null;
  archived: boolean;
}

export const DEFAULT_FILTERS: BoardFilters = {
  search: "",
  assignee: null,
  label: null,
  archived: false,
};

/** Resolves column display title (from titleKey if present, else title). */
export function columnTitle(col: BoardColumn): string {
  if (col.titleKey) {
    try {
      return t(col.titleKey as Key);
    } catch {
      return col.titleKey;
    }
  }
  return col.title || "Column";
}

/** Check if current role has column management rights (lead, admin, owner). */
export function canManageColumns(
  globalRole: string | null,
  projectRole: "member" | "lead" | null,
  isAgent = false,
): boolean {
  if (isAgent) return false;
  if (globalRole === "owner" || globalRole === "admin") return true;
  return projectRole === "lead";
}

/** Check if user can create, update, assign, archive cards. */
export function canWriteCards(
  globalRole: string | null,
  projectRole: "member" | "lead" | null,
  isAgent = false,
): boolean {
  if (isAgent) return false;
  if (globalRole === "viewer" || projectRole === null && globalRole !== "owner" && globalRole !== "admin") return false;
  return true;
}

/** Check if principal can move a specific card. */
export function canMoveCard(
  card: BoardCard,
  globalRole: string | null,
  projectRole: "member" | "lead" | null,
  isAgent: boolean,
  agentId: string | null,
): boolean {
  if (globalRole === "viewer") return false;
  if (isAgent) {
    if (!agentId) return false;
    return card.assignees.some((a) => a.kind === "agent" && a.id === agentId);
  }
  if (projectRole === null && globalRole !== "owner" && globalRole !== "admin") return false;
  return true;
}

/** Check if principal can comment. */
export function canComment(globalRole: string | null): boolean {
  return globalRole !== "viewer";
}

/** Filters a list of cards according to filter criteria. */
export function filterCards(
  cards: readonly BoardCard[],
  filters: BoardFilters,
): BoardCard[] {
  return cards.filter((card) => {
    if (card.archived !== filters.archived) return false;
    if (filters.assignee && !card.assignees.some((a) => a.id === filters.assignee)) {
      return false;
    }
    if (filters.label && !card.labels.includes(filters.label)) {
      return false;
    }
    if (filters.search.trim()) {
      const q = filters.search.trim().toLowerCase();
      const matchTitle = card.title.toLowerCase().includes(q);
      const matchDesc = card.description.toLowerCase().includes(q);
      if (!matchTitle && !matchDesc) return false;
    }
    return true;
  });
}

/** Counts active (non-archived) cards per column. */
export function countActiveCardsByColumn(
  cards: readonly BoardCard[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of cards) {
    if (!c.archived) {
      counts.set(c.columnId, (counts.get(c.columnId) ?? 0) + 1);
    }
  }
  return counts;
}

/** Determines if moving a card to target column would violate its WIP limit. */
export function wouldExceedWip(
  col: BoardColumn,
  currentCount: number,
  cardCurrentlyInColumn: boolean,
): boolean {
  if (col.wipLimit === null) return false;
  if (cardCurrentlyInColumn) return false;
  return currentCount + 1 > col.wipLimit;
}

/** Optimistically moves card in local array. */
export function optimisticallyMoveCard(
  cards: readonly BoardCard[],
  cardId: string,
  targetColumnId: string,
  targetPosition?: number,
): BoardCard[] {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return [...cards];

  const sameColumn = card.columnId === targetColumnId;
  const oldColumnId = card.columnId;

  // Clone list
  const next = cards.map((c) => ({ ...c }));
  const moving = next.find((c) => c.id === cardId)!;

  // Cards in target column (excluding moving card)
  const targetCards = next
    .filter((c) => c.columnId === targetColumnId && c.id !== cardId)
    .sort((a, b) => a.position - b.position);

  const insertAt =
    targetPosition === undefined
      ? targetCards.length
      : Math.max(0, Math.min(targetPosition, targetCards.length));

  targetCards.splice(insertAt, 0, moving);
  moving.columnId = targetColumnId;

  // Renumber target column
  targetCards.forEach((c, idx) => {
    c.position = idx;
  });

  // If moved from another column, renumber old column
  if (!sameColumn) {
    const oldCards = next
      .filter((c) => c.columnId === oldColumnId && c.id !== cardId)
      .sort((a, b) => a.position - b.position);
    oldCards.forEach((c, idx) => {
      c.position = idx;
    });
  }

  return next;
}

/** A card move the board has made that the server's answers may not show yet. */
export interface PendingMove {
  cardId: string;
  columnId: string;
  position: number | undefined;
  /** Set once the move succeeded: the generation of the board load started after it. Answers from that load on know the move. */
  knownFrom?: number;
}

/**
 * The board to show: the server's answer with the moves it may not know yet made again, in the order they were made (so a later
 * move of the same card wins).
 */
export function withPendingMoves(
  cards: readonly BoardCard[],
  pending: Iterable<PendingMove>,
): BoardCard[] {
  let next = [...cards];
  for (const move of pending) {
    next = optimisticallyMoveCard(next, move.cardId, move.columnId, move.position);
  }
  return next;
}

/** Calculates project card stats (open cards and overdue cards). */
export function calculateProjectStats(cards: readonly BoardCard[], now = Date.now()): {
  openCount: number;
  dueCount: number;
} {
  let openCount = 0;
  let dueCount = 0;
  for (const c of cards) {
    if (!c.archived) {
      openCount++;
      if (c.dueAt !== null && c.dueAt < now) {
        dueCount++;
      }
    }
  }
  return { openCount, dueCount };
}
