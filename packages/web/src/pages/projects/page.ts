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
import { currentRole, getApi } from "../common/load.ts";
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
            const cardRes = await api.rpc(
              "project.card.list",
              { projectId: p.id },
              { write: false },
            );
            statsMap.set(p.id, calculateProjectStats(cardRes.cards ?? []));
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
  const loadBoard = async (projId: string) => {
    try {
      setLoadingBoard(true);
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
      } catch {
        // Tolerant to environments/mocks without column list
      }

      try {
        const cardsRes = await api.rpc(
          "project.card.list",
          { projectId: projId },
          { write: false },
        );
        crds = cardsRes.cards ?? [];
      } catch {
        // Tolerant to environments/mocks without card list
      }

      setColumns(cols);
      setCards(crds);

      // Also update stats for this project
      setProjectStats((prev) => {
        const next = new Map(prev);
        next.set(projId, calculateProjectStats(crds));
        return next;
      });
    } catch (err) {
      setBoardFailure(err);
    } finally {
      setLoadingBoard(false);
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
              void loadBoard(data.projectId);
            }
            // Refresh stats
            void api
              .rpc("project.card.list", { projectId: data.projectId }, { write: false })
              .then((res) => {
                setProjectStats((prev) => {
                  const next = new Map(prev);
                  next.set(data.projectId, calculateProjectStats(res.cards ?? []));
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

  const handleCreateProject = async (e: Event) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;
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
    }
  };

  const role = currentRole();
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
      agentId: null,
      isAgent: false,
      onRefresh: () => void loadBoard(selectedProjectId),
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
