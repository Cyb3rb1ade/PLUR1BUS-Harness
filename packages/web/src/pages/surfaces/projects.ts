import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import type { PageProps } from "../registry.ts";
import { Page } from "../../components/page.ts";
import { PageState } from "../../components/page-state.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n.ts";
import { Field } from "../common/field.ts";
import { useLoad, currentRole } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import { rpc, type Project, type Trace } from "./data.ts";
function TraceView({ project }: { project: string }): View {
  const { state, reload } = useLoad(
    (signal) =>
      rpc<{ traces: Trace[] }>(
        "collab.trace.list",
        { projectId: project },
        signal,
      ),
    [project],
  );
  const [error, setError] = useState(false);
  if (state.status === "fail")
    return h(FailureState, {
      failure: state.failure,
      unavailable: t("surfaces.unavailable"),
      onRetry: reload,
    });
  if (state.status === "loading") return h(PageState, { state: "loading" });
  return h(
    "section",
    {},
    h("h2", {}, t("projects.traces")),
    state.data.traces.length
      ? state.data.traces.map((trace) =>
          h(
            "details",
            { key: trace.traceId },
            h("summary", {}, trace.traceId, " · ", trace.status),
            h(
              "ol",
              { class: "trace-timeline" },
              trace.spans.map((span) =>
                h(
                  "li",
                  {
                    key: span.spanId,
                    "data-parent": span.parentSpanId ?? "",
                    style: span.parentSpanId ? "margin-inline-start:2rem" : "",
                  },
                  h("strong", {}, span.agentId, " · ", span.status),
                  h(
                    "p",
                    {},
                    new Date(span.startedAt).toISOString(),
                    " → ",
                    span.endedAt ? new Date(span.endedAt).toISOString() : "…",
                  ),
                  h(
                    "p",
                    {},
                    t("projects.tokens"),
                    ": ",
                    span.inputTokens + span.outputTokens,
                    " · ",
                    t("projects.cost"),
                    ": ",
                    span.costEstimate === null ? "?" : span.costEstimate,
                  ),
                  h(
                    "details",
                    {},
                    h("summary", {}, t("projects.input")),
                    h("pre", {}, span.inputPreview),
                  ),
                  h(
                    "details",
                    {},
                    h("summary", {}, t("projects.output")),
                    h("pre", {}, span.outputPreview),
                  ),
                ),
              ),
            ),
            currentRole() !== "viewer" && trace.status === "running"
              ? h(
                  "button",
                  {
                    class: "btn",
                    onClick: async () => {
                      try {
                        await rpc(
                          "collab.chain.cancel",
                          { traceId: trace.traceId },
                          undefined,
                          true,
                        );
                        reload();
                      } catch {
                        setError(true);
                      }
                    },
                  },
                  t("projects.cancel"),
                )
              : null,
          ),
        )
      : h(PageState, { state: "empty", title: t("surfaces.empty") }),
    error ? h("p", { role: "alert" }, t("surfaces.error")) : null,
  );
}
function Detail({
  project,
  onChange,
}: {
  project: Project;
  onChange: () => void;
}): View {
  const [user, setUser] = useState(""),
    [agent, setAgent] = useState(""),
    [role, setRole] = useState("member"),
    [error, setError] = useState(false),
    [archive, setArchive] = useState(false);
  const write = currentRole() !== "viewer";
  const mutate = async (method: string, extra: object) => {
    try {
      setError(false);
      await rpc(method, { projectId: project.id, ...extra }, undefined, true);
      onChange();
    } catch {
      setError(true);
    }
  };
  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
  ) =>
    h(
      Field,
      { id, label },
      h("input", {
        id,
        value,
        onInput: (e: Event) => set((e.currentTarget as HTMLInputElement).value),
        required: true,
      }),
    );
  const roles = (value: string, change: (value: string) => void) =>
    h(
      "select",
      {
        "aria-label": t("projects.role"),
        value,
        onChange: (e: Event) =>
          change((e.currentTarget as HTMLSelectElement).value),
      },
      h("option", { value: "member" }, t("projects.member")),
      h("option", { value: "lead" }, t("projects.lead")),
    );
  return h(
    "section",
    {},
    h("h2", {}, project.name),
    h("h3", {}, t("projects.members")),
    h(
      "ul",
      {},
      project.members.map((member) =>
        h(
          "li",
          { key: member.userId },
          member.userId,
          " ",
          write && member.userId !== project.owner
            ? roles(
                member.role,
                (value) =>
                  void mutate("project.member.role", {
                    userId: member.userId,
                    role: value,
                  }),
              )
            : t(member.role === "lead" ? "projects.lead" : "projects.member"),
          write && member.userId !== project.owner
            ? h(
                "button",
                {
                  class: "btn",
                  onClick: () =>
                    void mutate("project.member.remove", {
                      userId: member.userId,
                    }),
                },
                t("surfaces.remove"),
              )
            : null,
        ),
      ),
    ),
    write
      ? h(
          "form",
          {
            onSubmit: (e: Event) => {
              e.preventDefault();
              void mutate("project.member.add", { userId: user, role });
            },
          },
          field("member-user", t("projects.user"), user, setUser),
          roles(role, setRole),
          h("button", { class: "btn", type: "submit" }, t("surfaces.create")),
        )
      : null,
    h("h3", {}, t("projects.agents")),
    h(
      "ul",
      {},
      project.agents.map((id) =>
        h(
          "li",
          { key: id },
          id,
          write
            ? h(
                "button",
                {
                  class: "btn",
                  onClick: () =>
                    void mutate("project.agent.remove", { agentId: id }),
                },
                t("surfaces.remove"),
              )
            : null,
        ),
      ),
    ),
    write
      ? h(
          "form",
          {
            onSubmit: (e: Event) => {
              e.preventDefault();
              void mutate("project.agent.add", { agentId: agent });
            },
          },
          field("project-agent", t("surfaces.agent"), agent, setAgent),
          h("button", { class: "btn", type: "submit" }, t("surfaces.create")),
        )
      : null,
    h(TraceView, { project: project.id }),
    write && project.archivedAt === null
      ? h(
          "button",
          { class: "btn btn-danger", onClick: () => setArchive(true) },
          t("projects.archive"),
        )
      : null,
    error ? h("p", { role: "alert" }, t("surfaces.error")) : null,
    archive
      ? h(
          ConfirmDialog,
          {
            title: t("projects.archive"),
            confirmLabel: t("projects.archive"),
            danger: true,
            onClose: () => setArchive(false),
            onConfirm: async () => {
              try {
                await rpc(
                  "project.archive",
                  { projectId: project.id },
                  undefined,
                  true,
                );
                onChange();
                return { ok: true as const };
              } catch {
                return { ok: false as const, message: t("surfaces.error") };
              }
            },
          },
          project.name,
        )
      : null,
  );
}
export function ProjectsPage({ sub }: PageProps): View {
  const { state, reload } = useLoad(
    (signal) => rpc<{ projects: Project[] }>("project.list", {}, signal),
    [],
  );
  const [name, setName] = useState(""),
    [error, setError] = useState(false);
  const title = t("nav.projects");
  if (state.status === "loading")
    return h(Page, { title }, h(PageState, { state: "loading" }));
  if (state.status === "fail")
    return h(
      Page,
      { title },
      h(FailureState, {
        failure: state.failure,
        unavailable: t("surfaces.unavailable"),
        onRetry: reload,
      }),
    );
  const selected = state.data.projects.find((p) => p.id === sub);
  return h(
    Page,
    { title },
    ["owner", "admin"].includes(currentRole() ?? "")
      ? h(
          "form",
          {
            onSubmit: async (e: Event) => {
              e.preventDefault();
              try {
                await rpc("project.create", { name }, undefined, true);
                setName("");
                reload();
              } catch {
                setError(true);
              }
            },
          },
          h(
            Field,
            { id: "project-name", label: t("surfaces.name") },
            h("input", {
              id: "project-name",
              value: name,
              required: true,
              maxLength: 256,
              onInput: (e: Event) =>
                setName((e.currentTarget as HTMLInputElement).value),
            }),
          ),
          h(
            "button",
            { class: "btn btn-primary", type: "submit" },
            t("surfaces.create"),
          ),
        )
      : null,
    error ? h("p", { role: "alert" }, t("surfaces.error")) : null,
    state.data.projects.length
      ? h(
          "ul",
          {},
          state.data.projects.map((project) =>
            h(
              "li",
              { key: project.id },
              h(
                "a",
                { href: `#/projects/${encodeURIComponent(project.id)}` },
                project.name,
              ),
            ),
          ),
        )
      : h(PageState, { state: "empty", title: t("surfaces.empty") }),
    selected
      ? h(Detail, { key: selected.id, project: selected, onChange: reload })
      : null,
  );
}
