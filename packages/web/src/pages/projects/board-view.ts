import { h, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { icon } from "../../icons.ts";
import { formatDateTime, t } from "../../i18n.ts";
import { getApi } from "../common/load.ts";
import {
  canManageColumns,
  canMoveCard,
  canWriteCards,
  columnTitle,
  countActiveCardsByColumn,
  filterCards,
  optimisticallyMoveCard,
  wouldExceedWip,
  type BoardFilters,
} from "./model.ts";
import type {
  BoardCard,
  BoardColumn,
  Project,
} from "./rpc-types.ts";
import { lazySection } from "../common/lazy-section.ts";
import type { CardDrawerProps } from "./card-drawer.ts";
import { ColumnDialog } from "./column-dialog.ts";
import { CardDialog } from "./card-dialog.ts";

const CardDrawer = lazySection<CardDrawerProps>(() =>
  import("./card-drawer.ts").then((m) => m.CardDrawer),
);

export interface BoardViewProps {
  project: Project;
  columns: BoardColumn[];
  cards: BoardCard[];
  globalRole: string | null;
  agentId: string | null;
  isAgent: boolean;
  onRefresh: () => void;
}

let activeDraggedCardId: string | null = null;

export function BoardView({
  project,
  columns,
  cards,
  globalRole,
  agentId,
  isAgent,
  onRefresh,
}: BoardViewProps): View {
  const [filters, setFilters] = useState<BoardFilters>({
    search: "",
    assignee: null,
    label: null,
    archived: false,
  });

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [createCardOpen, setCreateCardOpen] = useState(false);
  const [createCardColId, setCreateCardColId] = useState<string | undefined>(undefined);
  const [manageColumnsOpen, setManageColumnsOpen] = useState(false);

  // Local optimistic state for cards
  const [localCards, setLocalCards] = useState<BoardCard[]>(cards);
  useEffect(() => {
    setLocalCards(cards);
  }, [cards]);

  // Live region for a11y announcements
  const [announcement, setAnnouncement] = useState("");
  const announce = (msg: string) => {
    setAnnouncement(msg);
  };

  // Toast / error banner
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Collaboration traces for test compatibility
  const [traces, setTraces] = useState<any[]>([]);
  useEffect(() => {
    let active = true;
    const loadTraces = async () => {
      try {
        const api = getApi();
        const res: any = await api.rpc(
          "collab.trace.list",
          { projectId: project.id },
          { write: false },
        );
        if (active && res?.traces) {
          setTraces(res.traces);
        }
      } catch {
        // Traces optional
      }
    };
    void loadTraces();
    return () => {
      active = false;
    };
  }, [project.id]);

  const projectMember = project.members.find((m) => m.userId === (agentId ?? ""));
  const projectRole = projectMember?.role ?? null;
  const canManage = canManageColumns(globalRole, projectRole, isAgent);
  const canWrite = canWriteCards(globalRole, projectRole, isAgent);

  // Filtered cards
  const activeCardsByCol = countActiveCardsByColumn(localCards);
  const displayedCards = filterCards(localCards, filters);

  // Unique labels for filter dropdown
  const allLabels = Array.from(
    new Set(localCards.flatMap((c) => c.labels)),
  ).sort();

  // Optimistic Move Handler with Rollback
  const handleMove = async (
    cardId: string,
    targetColId: string,
    targetPosition?: number,
  ) => {
    const card = localCards.find((c) => c.id === cardId);
    if (!card) return;

    if (!canMoveCard(card, globalRole, projectRole, isAgent, agentId)) {
      const msg = isAgent
        ? t("projects.error.agentOnlyOwn")
        : t("projects.error.permissionDenied");
      setErrorBanner(msg);
      announce(msg);
      return;
    }

    const targetCol = columns.find((c) => c.id === targetColId);
    if (!targetCol) return;

    // Snapshot for rollback
    const snapshot = [...localCards];

    // Optimistic update
    const updated = optimisticallyMoveCard(
      localCards,
      cardId,
      targetColId,
      targetPosition,
    );
    setLocalCards(updated);
    setErrorBanner(null);

    const cardMovedMsg = t("projects.a11y.cardMoved", {
      card: card.title,
      column: columnTitle(targetCol),
    });
    announce(cardMovedMsg);

    try {
      const api = getApi();
      await api.rpc(
        "project.card.move",
        {
          projectId: project.id,
          cardId,
          columnId: targetColId,
          ...(targetPosition !== undefined ? { position: targetPosition } : {}),
        },
        { write: true },
      );
      // Success: refresh in background
      onRefresh();
    } catch (err: any) {
      // Rollback on failure
      setLocalCards(snapshot);
      let errorMsg = t("projects.error.generic");
      if (err?.errorCode === "E_PROJECT_WIP_LIMIT") {
        errorMsg = t("projects.error.wipLimit", {
          column: columnTitle(targetCol),
          limit: String(targetCol.wipLimit ?? "?"),
        });
        announce(
          t("projects.a11y.wipError", { column: columnTitle(targetCol) }),
        );
      } else if (err?.message) {
        errorMsg = err.message;
      }
      setErrorBanner(
        t("projects.error.rollback", { message: errorMsg }),
      );
    }
  };

  // Keyboard navigation for card
  const handleCardKeyDown = (e: KeyboardEvent, card: BoardCard) => {
    const currentColIdx = columns.findIndex((c) => c.id === card.columnId);
    if (currentColIdx === -1) return;

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelectedCardId(card.id);
      return;
    }

    if (e.key === "ArrowLeft" || e.key === "[") {
      if (currentColIdx > 0) {
        e.preventDefault();
        const prevCol = columns[currentColIdx - 1]!;
        void handleMove(card.id, prevCol.id);
      }
      return;
    }

    if (e.key === "ArrowRight" || e.key === "]") {
      if (currentColIdx < columns.length - 1) {
        e.preventDefault();
        const nextCol = columns[currentColIdx + 1]!;
        void handleMove(card.id, nextCol.id);
      }
      return;
    }

    if (e.key === "ArrowUp" || e.key === "{") {
      e.preventDefault();
      if (card.position > 0) {
        void handleMove(card.id, card.columnId, card.position - 1);
      }
      return;
    }

    if (e.key === "ArrowDown" || e.key === "}") {
      e.preventDefault();
      void handleMove(card.id, card.columnId, card.position + 1);
      return;
    }
  };

  // Drag and Drop
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);

  const handleDragStart = (e: DragEvent, cId: string) => {
    activeDraggedCardId = cId;
    setDraggedCardId(cId);
    if (e.dataTransfer) {
      e.dataTransfer.setData("text/plain", cId);
      e.dataTransfer.effectAllowed = "move";
    }
  };

  const handleDragOver = (e: DragEvent, colId: string) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    setDragOverColId(colId);
  };

  const handleDragLeave = (_e: DragEvent, colId: string) => {
    if (dragOverColId === colId) {
      setDragOverColId(null);
    }
  };

  const handleDrop = (e: DragEvent, colId: string) => {
    e.preventDefault();
    setDragOverColId(null);
    const cardId = activeDraggedCardId || draggedCardId || e.dataTransfer?.getData("text/plain");
    activeDraggedCardId = null;
    setDraggedCardId(null);
    if (cardId) {
      void handleMove(cardId, colId);
    }
  };

  const selectedCard = localCards.find((c) => c.id === selectedCardId);

  return h(
    "div",
    { class: "board-view" },

    // ARIA Live region for polite screen reader announcements
    h("div", {
      class: "sr-only board-live-region",
      "aria-live": "polite",
      "aria-atomic": "true",
      role: "status",
    }, announcement),

    // Subhead: project name under section name (no duplicate h1!)
    h(
      "div",
      { class: "project-subhead" },
      h("span", { class: "project-name-small" }, project.name),
    ),

    // Error banner
    errorBanner
      ? h(
          "div",
          { class: "alert alert-error board-alert", role: "alert" },
          errorBanner,
          h(
            "button",
            {
              type: "button",
              class: "icon-btn alert-dismiss",
              "aria-label": t("projects.card.close"),
              onClick: () => setErrorBanner(null),
            },
            icon("close", 16),
          ),
        )
      : null,

    // Filter toolbar
    h(
      "div",
      { class: "board-toolbar", role: "toolbar", "aria-label": "Filters" },
      h(
        "div",
        { class: "search-box" },
        icon("search", 16),
        h("input", {
          type: "search",
          class: "filter-input",
          placeholder: t("projects.filter.search"),
          "aria-label": t("projects.filter.search"),
          value: filters.search,
          onInput: (e: Event) =>
            setFilters({
              ...filters,
              search: (e.currentTarget as HTMLInputElement).value,
            }),
        }),
      ),

      // Assignee filter
      h(
        "select",
        {
          class: "filter-select",
          "aria-label": t("projects.card.assignees"),
          value: filters.assignee ?? "",
          onChange: (e: Event) => {
            const v = (e.currentTarget as HTMLSelectElement).value;
            setFilters({ ...filters, assignee: v ? v : null });
          },
        },
        h("option", { value: "" }, t("projects.filter.allAssignees")),
        project.members.map((m) =>
          h("option", { key: m.userId, value: m.userId }, m.userId),
        ),
        project.agents.map((ag) =>
          h("option", { key: ag, value: ag }, `${ag} (agent)`),
        ),
      ),

      // Label filter
      allLabels.length > 0
        ? h(
            "select",
            {
              class: "filter-select",
              "aria-label": t("projects.card.labels"),
              value: filters.label ?? "",
              onChange: (e: Event) => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                setFilters({ ...filters, label: v ? v : null });
              },
            },
            h("option", { value: "" }, t("projects.filter.allLabels")),
            allLabels.map((l) => h("option", { key: l, value: l }, l)),
          )
        : null,

      // Archived toggle
      h(
        "label",
        { class: "filter-checkbox-label" },
        h("input", {
          type: "checkbox",
          checked: filters.archived,
          onChange: (e: Event) =>
            setFilters({
              ...filters,
              archived: (e.currentTarget as HTMLInputElement).checked,
            }),
        }),
        h("span", {}, t("projects.filter.showArchived")),
      ),

      // Toolbar Actions
      h(
        "div",
        { class: "toolbar-actions" },
        canWrite
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-primary",
                onClick: () => {
                  setCreateCardColId(undefined);
                  setCreateCardOpen(true);
                },
              },
              t("projects.column.addCard"),
            )
          : null,
        canManage
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet",
                onClick: () => setManageColumnsOpen(true),
              },
              t("projects.column.manage"),
            )
          : null,
      ),
    ),

    // Columns Kanban Board
    h(
      "div",
      { class: "kanban-board", role: "region", "aria-label": "Kanban board" },
      columns.map((col, colIdx) => {
        const colCards = displayedCards
          .filter((c) => c.columnId === col.id)
          .sort((a, b) => a.position - b.position);
        const activeCount = activeCardsByCol.get(col.id) ?? 0;
        const limitReached =
          col.wipLimit !== null && activeCount >= col.wipLimit;

        return h(
          "section",
          {
            key: col.id,
            class: `kanban-column ${dragOverColId === col.id ? "drag-over" : ""}`,
            "data-column-id": col.id,
            onDragOver: (e: DragEvent) => handleDragOver(e, col.id),
            onDragLeave: (e: DragEvent) => handleDragLeave(e, col.id),
            onDrop: (e: DragEvent) => handleDrop(e, col.id),
          },
          // Column Header
          h(
            "header",
            { class: "column-head" },
            h(
              "div",
              { class: "column-title-wrap" },
              h("h2", { class: "column-title" }, columnTitle(col)),
              col.wipLimit !== null
                ? h(
                    Badge,
                    {
                      tone: limitReached ? "err" : "neutral",
                    },
                    t("projects.column.wipLimit", {
                      current: String(activeCount),
                      limit: String(col.wipLimit),
                    }),
                  )
                : h("span", { class: "card-count-badge" }, String(colCards.length)),
            ),
            canWrite
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "icon-btn column-add-btn",
                    "aria-label": `${t("projects.column.addCard")} (${columnTitle(col)})`,
                    onClick: () => {
                      setCreateCardColId(col.id);
                      setCreateCardOpen(true);
                    },
                  },
                  "+",
                )
              : null,
          ),

          // Cards List
          h(
            "div",
            { class: "cards-container", role: "list" },
            colCards.map((card) => {
              const priorityTone =
                card.priority === "urgent"
                  ? "err"
                  : card.priority === "high"
                    ? "warn"
                    : card.priority === "normal"
                      ? "info"
                      : "neutral";
              const canMove = canMoveCard(
                card,
                globalRole,
                projectRole,
                isAgent,
                agentId,
              );
              const isOverdue =
                card.dueAt !== null && card.dueAt < Date.now();

              return h(
                "article",
                {
                  key: card.id,
                  class: `board-card priority-${card.priority} ${card.archived ? "card-archived" : ""}`,
                  tabIndex: 0,
                  role: "button",
                  "data-card-id": card.id,
                  "aria-label": `${card.title}, ${card.priority} priority`,
                  draggable: canMove,
                  onDragStart: (e: DragEvent) => handleDragStart(e, card.id),
                  onKeyDown: (e: KeyboardEvent) => handleCardKeyDown(e, card),
                  onClick: () => setSelectedCardId(card.id),
                },
                // Card header: Title and Priority
                h(
                  "div",
                  { class: "card-head-row" },
                  h("h3", { class: "card-title" }, card.title),
                  card.priority !== "none"
                    ? h(
                        Badge,
                        { tone: priorityTone },
                        card.priority,
                      )
                    : null,
                ),

                // Labels
                card.labels.length > 0
                  ? h(
                      "div",
                      { class: "card-labels" },
                      card.labels.map((lbl) =>
                        h("span", { key: lbl, class: "label-chip" }, lbl),
                      ),
                    )
                  : null,

                // Metadata Footer: Due Date, Links, Assignees
                h(
                  "div",
                  { class: "card-foot-row" },
                  h(
                    "div",
                    { class: "card-indicators" },
                    card.dueAt !== null
                      ? h(
                          "span",
                          {
                            class: `due-indicator ${isOverdue ? "is-overdue" : ""}`,
                            title: formatDateTime(new Date(card.dueAt)),
                          },
                          isOverdue ? "⚠️ " : "📅 ",
                          new Date(card.dueAt).toLocaleDateString(),
                        )
                      : null,
                    card.links.length > 0
                      ? h(
                          "span",
                          { class: "links-indicator", title: `${card.links.length} links` },
                          "🔗 ",
                          String(card.links.length),
                        )
                      : null,
                  ),
                  h(
                    "div",
                    { class: "card-assignees" },
                    card.assignees.map((a) =>
                      h(
                        "span",
                        {
                          key: `${a.kind}:${a.id}`,
                          class: `assignee-avatar ${a.kind === "agent" ? "is-agent" : ""}`,
                          title: `${a.kind}: ${a.id}`,
                        },
                        a.kind === "agent"
                          ? icon("agents", 12)
                          : a.id.slice(0, 2).toUpperCase(),
                      ),
                    ),
                  ),
                ),

                // a11y Keyboard Move Buttons for Assistive Tech
                canMove
                  ? h(
                      "div",
                      {
                        class: "card-a11y-actions",
                        onClick: (e: MouseEvent) => e.stopPropagation(),
                      },
                      colIdx > 0
                        ? h(
                            "button",
                            {
                              type: "button",
                              class: "sr-only-focusable a11y-move-btn",
                              "aria-label": `${t("projects.a11y.moveLeft")}: ${card.title}`,
                              onClick: () =>
                                handleMove(card.id, columns[colIdx - 1]!.id),
                            },
                            "←",
                          )
                        : null,
                      colIdx < columns.length - 1
                        ? h(
                            "button",
                            {
                              type: "button",
                              class: "sr-only-focusable a11y-move-btn",
                              "aria-label": `${t("projects.a11y.moveRight")}: ${card.title}`,
                              onClick: () =>
                                handleMove(card.id, columns[colIdx + 1]!.id),
                            },
                            "→",
                          )
                        : null,
                    )
                  : null,
              );
            }),
          ),
        );
      }),
    ),

    // Collaboration Traces Section (for compatibility with existing surfaces tests)
    traces.length > 0
      ? h(
          "section",
          { class: "traces-section" },
          h("h2", {}, t("projects.traces")),
          traces.map((trace) =>
            h(
              "details",
              { key: trace.traceId },
              h("summary", {}, trace.traceId, " · ", trace.status),
              h(
                "ol",
                { class: "trace-timeline" },
                (trace.spans ?? []).map((span: any) =>
                  h(
                    "li",
                    {
                      key: span.spanId,
                      "data-parent": span.parentSpanId ?? "",
                    },
                    h("strong", {}, span.agentId, " · ", span.status),
                    h(
                      "p",
                      {},
                      t("projects.tokens"),
                      ": ",
                      (span.inputTokens ?? 0) + (span.outputTokens ?? 0),
                      " · ",
                      t("projects.cost"),
                      ": ",
                      span.costEstimate === null ? "?" : span.costEstimate,
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,

    // Modals & Drawers
    selectedCard
      ? h(CardDrawer, {
          card: selectedCard,
          project,
          columns,
          globalRole,
          projectRole,
          isAgent,
          onClose: () => setSelectedCardId(null),
          onUpdate: onRefresh,
          onAnnounce: announce,
        })
      : null,

    createCardOpen
      ? h(CardDialog, {
          projectId: project.id,
          columns,
          defaultColumnId: createCardColId,
          onClose: () => setCreateCardOpen(false),
          onCreated: () => {
            setCreateCardOpen(false);
            onRefresh();
          },
          onAnnounce: announce,
        })
      : null,

    manageColumnsOpen
      ? h(ColumnDialog, {
          projectId: project.id,
          columns,
          onClose: () => setManageColumnsOpen(false),
          onUpdate: () => {
            onRefresh();
          },
        })
      : null,
  );
}
