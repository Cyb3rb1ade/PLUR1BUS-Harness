// Projects & Kanban board page (`#/projects`, `#/projects/<projectId>`).
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import type { PageProps } from "../registry.ts";
import { Page } from "../../components/page.ts";
import { PageState } from "../../components/page-state.ts";
import { ListDetail } from "../../components/list-detail.ts";
import { Badge } from "../../components/card.ts";
import { Field } from "../common/field.ts";
import { t } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as projectsArea from "../../i18n/projects.ts";
import { FailureState } from "../common/states.ts";
import { currentRole, failureOf, getApi } from "../common/load.ts";
import { sessionState } from "../../session.ts";
import { navigate } from "../../router.ts";
import { calculateProjectStats } from "./model.ts";
import type {
  BoardCard,
  BoardColumn,
  Project,
} from "./rpc-types.ts";
import { BoardView } from "./board-view.ts";

import "../../styles/projects.css";

registerArea("projects", projectsArea);

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

/** All cards of a project: project.card.list is paged (limit 100), a board must not silently stop after the first page. */
async function listAllCards(projectId: string): Promise<BoardCard[]> {
  const api = getApi();
  const all: BoardCard[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await api.rpc(
      "project.card.list",
      { projectId, limit: PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : {}) },
      { write: false },
    );
    all.push(...(res.cards ?? []));
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return all;
}

/** A backend without the method (-32601) is tolerated as "nothing there"; every other failure is a failure. */
const isMissingMethod = (e: unknown): boolean => failureOf(e).kind === "unavailable";

export function ProjectsPage({ sub }: PageProps): View {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectStats, setProjectStats] = useState<
    Map<string, { openCount: number; dueCount: number }>
  >(new Map());
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectsFailure, setProjectsFailure] = useState<any>(null);

  // Selected project board data
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [boardFailure, setBoardFailure] = useState<any>(null);

  // New project inline form state
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);

  const selectedProjectId = sub ? decodeURIComponent(sub.split("/")[0]!) : null;

  // Load projects list
  const loadProjects = async () => {
    try {
      setLoadingProjects(true);
      setProjectsFailure(null);
      const api = getApi();
      const res = await api.rpc("project.list", {}, { write: false });
      const projs = res.projects ?? [];
      setProjects(projs);

      // Load stats (open/due cards) for each project in background
      const statsMap = new Map<string, { openCount: number; dueCount: number }>();
      await Promise.all(
        projs.map(async (p) => {
          try {
            statsMap.set(p.id, calculateProjectStats(await listAllCards(p.id)));
          } catch {
            // Stats optional
          }
        }),
      );
      setProjectStats(new Map(statsMap));
    } catch (err) {
      setProjectsFailure(err);
    } finally {
      setLoadingProjects(false);
    }
  };

  // Load board data for selected project
  // `background` refreshes (after a card move etc.) keep the mounted board in
  // place; swapping it for the loading state would unmount BoardView and wipe
  // its aria-live region (and focus) before assistive tech can announce it.
  const boardGen = useRef(0);
  const loadBoard = async (projId: string, background = false) => {
    // Only the newest request may apply its answer (switching projects, live updates arriving while one is in flight).
    const gen = ++boardGen.current;
    try {
      if (!background) setLoadingBoard(true);
      setBoardFailure(null);
      const api = getApi();

      let cols: BoardColumn[] = [];
      let crds: BoardCard[] = [];

      try {
        const colsRes = await api.rpc(
          "project.column.list",
          { projectId: projId },
          { write: false },
        );
        cols = colsRes.columns ?? [];
      } catch (e) {
        // Tolerant to environments/mocks that do not serve the method; anything else is a real failure.
        if (!isMissingMethod(e)) throw e;
      }

      try {
        crds = await listAllCards(projId);
      } catch (e) {
        if (!isMissingMethod(e)) throw e;
      }

      if (gen !== boardGen.current) return;
      setColumns(cols);
      setCards(crds);

      // Also update stats for this project
      setProjectStats((prev) => {
        const next = new Map(prev);
        next.set(projId, calculateProjectStats(crds));
        return next;
      });
    } catch (err) {
      if (gen !== boardGen.current) return;
      // A failed background refresh keeps the board that is shown; a failed first load is an error state.
      if (!background) setBoardFailure(err);
    } finally {
      if (gen === boardGen.current) setLoadingBoard(false);
    }
  };

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      void loadBoard(selectedProjectId);
    } else {
      setColumns([]);
      setCards([]);
    }
  }, [selectedProjectId]);

  // Live updates via /events SSE
  useEffect(() => {
    const api = getApi();
    const handle = api.events({
      onEvent: (ev) => {
        if (
          ev.event === "project.card.changed" ||
          ev.event === "project.column.changed"
        ) {
          let data: any = {};
          try {
            data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
          } catch {
            data = {};
          }
          if (data?.projectId) {
            if (data.projectId === selectedProjectId) {
              void loadBoard(data.projectId, true);
            }
            // Refresh stats
            void listAllCards(data.projectId)
              .then((all) => {
                setProjectStats((prev) => {
                  const next = new Map(prev);
                  next.set(data.projectId, calculateProjectStats(all));
                  return next;
                });
              })
              .catch(() => {});
          }
        }
      },
    });

    return () => {
      handle.close();
    };
  }, [selectedProjectId]);

  const creating = useRef(false);
  const handleCreateProject = async (e: Event) => {
    e.preventDefault();
    if (!newProjectName.trim() || creating.current) return;
    creating.current = true;
    try {
      setCreateProjectError(null);
      const api = getApi();
      const created = await api.rpc(
        "project.create",
        { name: newProjectName.trim() },
        { write: true },
      );
      setNewProjectName("");
      setCreatingProject(false);
      await loadProjects();
      if (created?.id) {
        navigate(`/projects/${encodeURIComponent(created.id)}`);
      }
    } catch (err) {
      setCreateProjectError(
        err instanceof Error ? err.message : t("projects.error.generic"),
      );
    } finally {
      creating.current = false;
    }
  };

  const role = currentRole();
  const sessionNow = sessionState.value;
  const userId = sessionNow.status === "authenticated" ? sessionNow.user.id : undefined;
  const canCreateProj = role === "owner" || role === "admin";
  const selectedProj = projects.find((p) => p.id === selectedProjectId);

  const title = t("projects.title");

  if (loadingProjects) {
    return h(Page, { title }, h(PageState, { state: "loading" }));
  }

  if (projectsFailure) {
    return h(
      Page,
      { title },
      h(FailureState, {
        failure: projectsFailure,
        unavailable: t("surfaces.unavailable"),
        onRetry: loadProjects,
      }),
    );
  }

  // Projects list in the sidebar (with open & due badges)
  const sidebarList: View = h(
    "div",
    { class: "projects-sidebar" },
    h(
      "div",
      { class: "projects-sidebar-head" },
      h("h2", { class: "sidebar-heading" }, t("projects.sidebar.title")),
      canCreateProj
        ? h(
            "button",
            {
              type: "button",
              class: "btn btn-primary btn-sm",
              onClick: () => setCreatingProject(!creatingProject),
            },
            t("projects.sidebar.newProject"),
          )
        : null,
    ),

    creatingProject
      ? h(
          "form",
          { class: "project-create-inline", onSubmit: handleCreateProject },
          createProjectError
            ? h("div", { class: "alert alert-error" }, createProjectError)
            : null,
          h(
            Field,
            { id: "new-proj-name", label: t("projects.projectName") },
            h("input", {
              id: "new-proj-name",
              required: true,
              value: newProjectName,
              onInput: (e: Event) =>
                setNewProjectName((e.currentTarget as HTMLInputElement).value),
            }),
          ),
          h(
            "div",
            { class: "btn-row" },
            h(
              "button",
              { type: "submit", class: "btn btn-primary btn-sm" },
              t("surfaces.create"),
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn btn-quiet btn-sm",
                onClick: () => setCreatingProject(false),
              },
              t("projects.cancel"),
            ),
          ),
        )
      : null,

    projects.length === 0
      ? h(
          "div",
          { class: "sidebar-empty" },
          h(PageState, { state: "empty", title: t("surfaces.empty") }),
        )
      : h(
          "ul",
          { class: "projects-nav-list" },
          projects.map((proj) => {
            const stats = projectStats.get(proj.id) ?? { openCount: 0, dueCount: 0 };
            const isCurrent = proj.id === selectedProjectId;

            return h(
              "li",
              { key: proj.id, class: "project-nav-item" },
              h(
                "a",
                {
                  class: `project-nav-link ${isCurrent ? "is-active" : ""}`,
                  href: `#/projects/${encodeURIComponent(proj.id)}`,
                  ...(isCurrent ? { "aria-current": "page" } : {}),
                },
                h("span", { class: "project-name" }, proj.name),
                h(
                  "div",
                  { class: "project-badges" },
                  stats.openCount > 0
                    ? h(
                        Badge,
                        { tone: "neutral" },
                        t("projects.sidebar.openCount", {
                          count: String(stats.openCount),
                        }),
                      )
                    : null,
                  stats.dueCount > 0
                    ? h(
                        Badge,
                        { tone: "err" },
                        t("projects.sidebar.dueCount", {
                          count: String(stats.dueCount),
                        }),
                      )
                    : null,
                ),
              ),
            );
          }),
        ),
  );

  // Detail view: BoardView or Empty/Loading state
  let detailContent: View;

  if (!selectedProjectId) {
    detailContent = h(
      "div",
      { class: "board-empty-selection" },
      h(PageState, {
        state: "empty",
        title: t("projects.board.noSelection"),
        detail: t("projects.board.emptyHint"),
      }),
    );
  } else if (loadingBoard) {
    detailContent = h(PageState, { state: "loading" });
  } else if (boardFailure) {
    detailContent = h(FailureState, {
      failure: boardFailure,
      unavailable: t("surfaces.unavailable"),
      onRetry: () => void loadBoard(selectedProjectId),
    });
  } else if (selectedProj) {
    detailContent = h(BoardView, {
      project: selectedProj,
      columns,
      cards,
      globalRole: role ?? null,
      userId: userId ?? null,
      agentId: null,
      isAgent: false,
      onRefresh: () => void loadBoard(selectedProjectId, true),
    });
  } else {
    detailContent = h(PageState, {
      state: "empty",
      title: t("projects.board.noSelection"),
    });
  }

  return h(
    Page,
    { title, width: "full" },
    h(ListDetail, {
      list: sidebarList,
      detail: detailContent,
      selected: selectedProjectId !== null,
      listLabel: t("projects.sidebar.title"),
      detailLabel: selectedProj?.name ?? t("projects.subtitle"),
      onBack: () => navigate("/projects"),
      empty: h(
        "div",
        { class: "board-empty-selection" },
        h(PageState, {
          state: "empty",
          title: t("projects.board.noSelection"),
        }),
      ),
    }),
  );
}
