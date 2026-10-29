import { h, type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge } from "../../components/card.ts";
import { icon } from "../../icons.ts";
import { formatDateTime, t } from "../../i18n.ts";
import { getApi } from "../common/load.ts";
import { HandoffContent } from "./handoff-card.ts";
import { canComment, canWriteCards } from "./model.ts";
import { isSafeUrl } from "./markdown.ts";
import type {
  BoardActivity,
  BoardActor,
  BoardCard,
  BoardColumn,
  BoardComment,
  Project,
} from "./rpc-types.ts";
import "../../styles/projects.css";

export interface CardDrawerProps {
  card: BoardCard;
  project: Project;
  columns: readonly BoardColumn[];
  globalRole: string | null;
  projectRole: "member" | "lead" | null;
  isAgent: boolean;
  onClose: () => void;
  onUpdate: () => void;
  onAnnounce: (msg: string) => void;
}

export function CardDrawer({
  card,
  project,
  columns,
  globalRole,
  projectRole,
  isAgent,
  onClose,
  onUpdate,
  onAnnounce,
}: CardDrawerProps): View {
  const [comments, setComments] = useState<BoardComment[]>([]);
  const [activity, setActivity] = useState<BoardActivity[]>([]);
  const [commentText, setCommentText] = useState("");
  const [loadingComments, setLoadingComments] = useState(true);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canWrite = canWriteCards(globalRole, projectRole, isAgent);
  const allowComment = canComment(globalRole);

  // Load comments and activity
  const loadComments = async () => {
    try {
      setLoadingComments(true);
      const api = getApi();
      const res = await api.rpc(
        "project.card.comment.list",
        { projectId: card.projectId, cardId: card.id },
        { write: false },
      );
      setComments(res.items ?? []);
    } catch {
      // Ignore comment load failure
    } finally {
      setLoadingComments(false);
    }
  };

  const loadActivity = async () => {
    try {
      setLoadingActivity(true);
      const api = getApi();
      const res = await api.rpc(
        "project.card.activity.list",
        { projectId: card.projectId, cardId: card.id },
        { write: false },
      );
      setActivity(res.items ?? []);
    } catch {
      // Ignore activity load failure
    } finally {
      setLoadingActivity(false);
    }
  };

  useEffect(() => {
    void loadComments();
    void loadActivity();
  }, [card.id]);

  // A modal drawer takes the focus when it opens and gives it back to the card that opened it.
  const drawerEl = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerEl.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  // Esc closes the drawer. The listener is attached in a layout effect, i.e. in the commit that shows the drawer and moves the
  // focus into it (above): a passive `useEffect` runs after the next paint, so an Esc pressed right after opening (a fast
  // keyboard user, a test driver) used to reach no listener and the drawer stayed open.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const handleAddComment = async (e: Event) => {
    e.preventDefault();
    if (!commentText.trim() || submittingComment) return;
    try {
      setSubmittingComment(true);
      setError(null);
      const api = getApi();
      await api.rpc(
        "project.card.comment.add",
        {
          projectId: card.projectId,
          cardId: card.id,
          text: commentText.trim(),
        },
        { write: true },
      );
      setCommentText("");
      await loadComments();
      await loadActivity();
      onAnnounce(t("projects.activity.commented"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.error.generic"));
    } finally {
      setSubmittingComment(false);
    }
  };

  const handlePriorityChange = async (priority: BoardCard["priority"]) => {
    if (priority === card.priority) return;
    try {
      setError(null);
      await getApi().rpc(
        "project.card.update",
        { projectId: card.projectId, cardId: card.id, priority },
        { write: true },
      );
      onAnnounce(t("projects.activity.updated"));
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.error.generic"));
    }
  };

  const handleArchiveToggle = async () => {
    try {
      setError(null);
      const api = getApi();
      if (card.archived) {
        await api.rpc(
          "project.card.unarchive",
          { projectId: card.projectId, cardId: card.id },
          { write: true },
        );
        onAnnounce(t("projects.activity.unarchived"));
      } else {
        await api.rpc(
          "project.card.archive",
          { projectId: card.projectId, cardId: card.id },
          { write: true },
        );
        onAnnounce(t("projects.activity.archived"));
      }
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.error.generic"));
    }
  };

  const handleAssign = async (assignee: BoardActor, isAssigned: boolean) => {
    if (!canWrite) return;
    try {
      setError(null);
      const api = getApi();
      if (isAssigned) {
        await api.rpc(
          "project.card.unassign",
          { projectId: card.projectId, cardId: card.id, assignee },
          { write: true },
        );
      } else {
        await api.rpc(
          "project.card.assign",
          { projectId: card.projectId, cardId: card.id, assignee },
          { write: true },
        );
      }
      onUpdate();
      await loadActivity();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.error.generic"));
    }
  };

  const priorityTone =
    card.priority === "urgent"
      ? "err"
      : card.priority === "high"
        ? "warn"
        : card.priority === "normal"
          ? "info"
          : "neutral";

  const col = columns.find((c) => c.id === card.columnId);
  const colName = col ? (col.titleKey ? t(col.titleKey as any) : col.title) : "";

  // Available unassigned members and agents
  const unassignedMembers = project.members.filter(
    (m) => !card.assignees.some((a) => a.kind === "person" && a.id === m.userId),
  );
  const unassignedAgents = project.agents.filter(
    (agentId) => !card.assignees.some((a) => a.kind === "agent" && a.id === agentId),
  );

  return h(
    "div",
    { class: "card-drawer-backdrop", onClick: onClose },
    h(
      "aside",
      {
        class: "card-drawer",
        ref: drawerEl,
        tabIndex: -1,
        role: "dialog",
        "aria-modal": "true",
        "aria-label": card.title,
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
        },
      },
      // Header
      h(
        "header",
        { class: "drawer-head" },
        h(
          "div",
          { class: "drawer-title-row" },
          h("h2", { class: "drawer-title" }, card.title),
          h(
            "button",
            {
              type: "button",
              class: "icon-btn drawer-close",
              "aria-label": t("projects.card.close"),
              onClick: onClose,
            },
            icon("close"),
          ),
        ),
        h(
          "div",
          { class: "drawer-meta" },
          colName ? h(Badge, { tone: "neutral" }, colName) : null,
          card.priority !== "none"
            ? h(
                Badge,
                { tone: priorityTone },
                t(`projects.card.priority${card.priority.charAt(0).toUpperCase() + card.priority.slice(1)}` as any),
              )
            : null,
          card.dueAt !== null
            ? h(
                Badge,
                {
                  tone: card.dueAt < Date.now() ? "err" : "neutral",
                },
                `${t("projects.card.dueAt")}: ${formatDateTime(new Date(card.dueAt))}`,
              )
            : null,
          card.archived ? h(Badge, { tone: "warn" }, t("projects.card.archived")) : null,
        ),
      ),

      // Body
      h(
        "div",
        { class: "drawer-body" },
        error ? h("div", { class: "alert alert-error", role: "alert" }, error) : null,

        // Labels
        card.labels.length > 0
          ? h(
              "section",
              { class: "drawer-section" },
              h("h3", {}, t("projects.card.labels")),
              h(
                "div",
                { class: "card-labels" },
                card.labels.map((l) =>
                  h("span", { key: l, class: "label-chip" }, l),
                ),
              ),
            )
          : null,

        // Description (Safe Markdown without HTML)
        h(
          "section",
          { class: "drawer-section" },
          h("h3", {}, t("projects.card.description")),
          h(HandoffContent, {
            content: card.description,
            fallback: t("projects.card.noDescription"),
          }),
        ),

        // Assignees
        h(
          "section",
          { class: "drawer-section" },
          h("h3", {}, t("projects.card.assignees")),
          h(
            "div",
            { class: "assignees-list" },
            card.assignees.length === 0
              ? h("p", { class: "meta-empty" }, "—")
              : card.assignees.map((a) =>
                  h(
                    "span",
                    { key: `${a.kind}:${a.id}`, class: "assignee-pill" },
                    a.kind === "agent" ? icon("agents", 16) : null,
                    h("span", {}, a.id),
                    canWrite
                      ? h(
                          "button",
                          {
                            type: "button",
                            class: "btn-quiet unassign-btn",
                            "aria-label": `${t("projects.card.unassign")} ${a.id}`,
                            onClick: () => handleAssign(a, true),
                          },
                          "×",
                        )
                      : null,
                  ),
                ),
          ),
          canWrite && (unassignedMembers.length > 0 || unassignedAgents.length > 0)
            ? h(
                "div",
                { class: "assign-controls" },
                unassignedMembers.length > 0
                  ? h(
                      "select",
                      {
                        "aria-label": t("projects.card.assignPerson"),
                        onChange: (e: Event) => {
                          const val = (e.currentTarget as HTMLSelectElement).value;
                          if (val) {
                            void handleAssign({ kind: "person", id: val }, false);
                            (e.currentTarget as HTMLSelectElement).value = "";
                          }
                        },
                      },
                      h("option", { value: "" }, `+ ${t("projects.card.assignPerson")}`),
                      unassignedMembers.map((m) =>
                        h("option", { key: m.userId, value: m.userId }, m.userId),
                      ),
                    )
                  : null,
                unassignedAgents.length > 0
                  ? h(
                      "select",
                      {
                        "aria-label": t("projects.card.assignAgent"),
                        onChange: (e: Event) => {
                          const val = (e.currentTarget as HTMLSelectElement).value;
                          if (val) {
                            void handleAssign({ kind: "agent", id: val }, false);
                            (e.currentTarget as HTMLSelectElement).value = "";
                          }
                        },
                      },
                      h("option", { value: "" }, `+ ${t("projects.card.assignAgent")}`),
                      unassignedAgents.map((agentId) =>
                        h("option", { key: agentId, value: agentId }, agentId),
                      ),
                    )
                  : null,
              )
            : null,
        ),

        // Links
        card.links.length > 0
          ? h(
              "section",
              { class: "drawer-section" },
              h("h3", {}, t("projects.card.links")),
              h(
                "ul",
                { class: "links-list" },
                card.links.map((link, idx) =>
                  h(
                    "li",
                    { key: idx, class: "link-item" },
                    h("span", { class: "link-kind" }, link.kind),
                    ": ",
                    link.kind === "url" && isSafeUrl(link.id)
                      ? h(
                          "a",
                          {
                            href: link.id,
                            target: "_blank",
                            rel: "noopener noreferrer",
                            class: "markdown-link",
                          },
                          link.id,
                        )
                      : h("span", { class: "link-ref" }, link.id),
                  ),
                ),
              ),
            )
          : null,

        // Comments
        h(
          "section",
          { class: "drawer-section" },
          h("h3", {}, t("projects.card.comments")),
          loadingComments
            ? h("p", { class: "loading-hint" }, "…")
            : comments.length === 0
              ? h("p", { class: "meta-empty" }, "—")
              : h(
                  "div",
                  { class: "comments-feed" },
                  comments.map((cmt) =>
                    h(
                      "article",
                      { key: cmt.id, class: "comment-bubble" },
                      h(
                        "header",
                        { class: "comment-head" },
                        h(
                          "span",
                          { class: "comment-author" },
                          cmt.author.kind === "agent" ? icon("agents", 14) : null,
                          cmt.author.id,
                        ),
                        h(
                          "time",
                          { class: "comment-time" },
                          formatDateTime(new Date(cmt.createdAt)),
                        ),
                      ),
                      h(HandoffContent, { content: cmt.text }),
                    ),
                  ),
                ),
          allowComment
            ? h(
                "form",
                { class: "comment-form", onSubmit: handleAddComment },
                h("textarea", {
                  class: "comment-textarea",
                  rows: 2,
                  placeholder: t("projects.card.commentPlaceholder"),
                  value: commentText,
                  onInput: (e: Event) =>
                    setCommentText((e.currentTarget as HTMLTextAreaElement).value),
                }),
                h(
                  "button",
                  {
                    type: "submit",
                    class: "btn btn-primary",
                    disabled: submittingComment || !commentText.trim(),
                  },
                  t("projects.card.addComment"),
                ),
              )
            : null,
        ),

        // Activity Log
        h(
          "section",
          { class: "drawer-section" },
          h("h3", {}, t("projects.card.activity")),
          loadingActivity
            ? h("p", { class: "loading-hint" }, "…")
            : activity.length === 0
              ? h("p", { class: "meta-empty" }, "—")
              : h(
                  "ol",
                  { class: "activity-list" },
                  activity.map((act) =>
                    h(
                      "li",
                      { key: act.id, class: "activity-item" },
                      h("span", { class: "activity-actor" }, act.actor.id),
                      " ",
                      h(
                        "span",
                        { class: "activity-kind" },
                        t(`projects.activity.${act.kind}` as any),
                      ),
                      " · ",
                      h(
                        "time",
                        { class: "activity-time" },
                        formatDateTime(new Date(act.at)),
                      ),
                    ),
                  ),
                ),
        ),

        // Archive / Unarchive Action
        canWrite
          ? h(
              "footer",
              { class: "drawer-footer" },
              h(
                "label",
                { class: "drawer-priority", for: `priority-${card.id}` },
                t("projects.card.priorityChange"),
                h(
                  "select",
                  {
                    id: `priority-${card.id}`,
                    value: card.priority,
                    onChange: (e: Event) =>
                      void handlePriorityChange(
                        (e.currentTarget as HTMLSelectElement).value as BoardCard["priority"],
                      ),
                  },
                  (["none", "low", "normal", "high", "urgent"] as const).map((p) =>
                    h(
                      "option",
                      { key: p, value: p },
                      t(`projects.card.priority${p.charAt(0).toUpperCase() + p.slice(1)}` as any),
                    ),
                  ),
                ),
              ),
              h(
                "button",
                {
                  type: "button",
                  class: card.archived ? "btn btn-quiet" : "btn btn-danger",
                  onClick: handleArchiveToggle,
                },
                card.archived
                  ? t("projects.card.unarchiveAction")
                  : t("projects.card.archiveAction"),
              ),
            )
          : null,
      ),
    ),
  );
}
