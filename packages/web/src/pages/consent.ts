import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { PreferenceControls } from "../components/controls.ts";
import { registerArea } from "../i18n/index.ts";
import * as oauthCatalog from "../i18n/oauth.ts";
import { t } from "../i18n.ts";
import { passkeyLogin } from "../passkeys.ts";
import { query as routeQuery, type Route } from "../router.ts";
import { readAgents, type Agent } from "./agents/model.ts";
import type { View } from "../view.ts";

registerArea("oauth", oauthCatalog);

function scopeDescription(scope: string): string {
  switch (scope) {
    case "mcp.read": return t("oauth.scope.mcpRead");
    case "mcp.write": return t("oauth.scope.mcpWrite");
    case "agent.use": return t("oauth.scope.agentUse");
    case "agent.manage": return t("oauth.scope.agentManage");
    case "memory.read":
    case "memory.workspace.read":
    case "memory.user.read":
    case "memory.agent-private.read":
      return t("oauth.scope.memoryRead");
    case "memory.write":
    case "memory.workspace.write":
    case "memory.user.write":
    case "memory.agent-private.write":
      return t("oauth.scope.memoryWrite");
    case "a2a.task": return t("oauth.scope.a2aTask");
    default: return scope;
  }
}

export function ConsentPage(): View {
  const currentParams = routeQuery.value;
  const clientId = currentParams.get("client_id") ?? "";
  const redirectUri = currentParams.get("redirect_uri") ?? "";
  const rawScope = currentParams.get("scope") ?? "mcp.read agent.use";
  const state = currentParams.get("state") ?? undefined;
  const codeChallenge = currentParams.get("code_challenge") ?? undefined;
  const codeChallengeMethod = currentParams.get("code_challenge_method") ?? "S256";
  const resource = currentParams.get("resource") ?? undefined;
  const requestedAgentId = currentParams.get("agent_id") ?? undefined;
  const projectId = currentParams.get("project_id") ?? undefined;

  const [clientName, setClientName] = useState(clientId);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState(requestedAgentId ?? "main");
  const [availableScopes, setAvailableScopes] = useState<string[]>(() =>
    rawScope.split(/[\s,]+/).filter(Boolean)
  );
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(() =>
    new Set(rawScope.split(/[\s,]+/).filter(Boolean))
  );
  const [secondFactorRequired, setSecondFactorRequired] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      // 1. Load agent list
      try {
        const agentData = await readAgents();
        if (!cancelled && agentData.agents.length > 0) {
          setAgents(agentData.agents);
          if (!requestedAgentId || !agentData.agents.some((a) => a.id === requestedAgentId)) {
            setSelectedAgent(agentData.agents[0]!.id);
          }
        }
      } catch {
        // Fallback default agent
        if (!cancelled && agents.length === 0) {
          setAgents([{ id: "main", name: "Main Agent", createdAt: null, skills: [], state: "active" }]);
        }
      }

      // 2. Fetch authorize endpoint to resolve client metadata
      if (clientId && redirectUri) {
        try {
          const checkUrl = "/oauth/authorize?" + currentParams.toString();
          const res = await fetch(checkUrl, {
            headers: { Accept: "application/json" },
            credentials: "same-origin",
          });
          if (res.status === 403) {
            const body = await res.json().catch(() => ({})) as { error?: string; reason?: string };
            if (body.error === "second-factor-required" || body.reason === "second-factor-required") {
              if (!cancelled) setSecondFactorRequired(true);
            }
          } else if (res.ok) {
            const data = await res.json() as {
              client_name?: string;
              scopes?: string[];
              second_factor_required?: boolean;
            };
            if (!cancelled) {
              if (data.client_name) setClientName(data.client_name);
              if (Array.isArray(data.scopes) && data.scopes.length > 0) {
                setAvailableScopes(data.scopes);
                setSelectedScopes(new Set(data.scopes));
              }
              if (data.second_factor_required) {
                setSecondFactorRequired(true);
              }
            }
          }
        } catch {
          // ignore network failure on probe
        }
      }
    }

    void loadData();
    return () => { cancelled = true; };
  }, [clientId, redirectUri]);

  let redirectHost = "";
  try {
    if (redirectUri) redirectHost = new URL(redirectUri).host;
  } catch {
    redirectHost = redirectUri;
  }

  async function fetchCsrfToken(): Promise<string | undefined> {
    try {
      const res = await fetch("/api/v1/csrf", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!res.ok) return undefined;
      const data = await res.json().catch(() => ({})) as { token?: string };
      return data.token;
    } catch {
      return undefined;
    }
  }

  const handleApprove = async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    setStatusMessage(t("oauth.redirecting"));

    try {
      const csrf = await fetchCsrfToken();
      const res = await fetch("/oauth/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        credentials: "same-origin",
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          state,
          resource,
          approve: true,
          agent_id: selectedAgent,
          project_id: projectId,
          scope: Array.from(selectedScopes).join(" "),
          ...(totpCode ? { totp_code: totpCode } : {}),
        }),
      });

      const body = await res.json().catch(() => ({})) as { redirect_uri?: string; error?: string; reason?: string };
      if (res.ok && body.redirect_uri) {
        globalThis.location.assign(body.redirect_uri);
        return;
      }

      if (body.error === "second-factor-required" || body.reason === "second-factor-required") {
        setSecondFactorRequired(true);
        setStatusMessage(null);
        setSubmitting(false);
        return;
      }

      setError(body.error ?? t("oauth.error.failed"));
      setStatusMessage(null);
      setSubmitting(false);
    } catch {
      setError(t("oauth.error.failed"));
      setStatusMessage(null);
      setSubmitting(false);
    }
  };

  const handleDeny = async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    setStatusMessage(t("oauth.redirecting"));

    try {
      const csrf = await fetchCsrfToken();
      const res = await fetch("/oauth/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        credentials: "same-origin",
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
          approve: false,
        }),
      });

      const body = await res.json().catch(() => ({})) as { redirect_uri?: string };
      if (res.ok && body.redirect_uri) {
        globalThis.location.assign(body.redirect_uri);
        return;
      }

      setError(t("oauth.error.rejected"));
      setStatusMessage(null);
      setSubmitting(false);
    } catch {
      setError(t("oauth.error.rejected"));
      setStatusMessage(null);
      setSubmitting(false);
    }
  };

  return h("div", { class: "login" },
    h("header", { class: "login-tools" }, h(PreferenceControls, { idPrefix: "consent" })),
    h("main", { class: "login-card consent-card", id: "main" },
      h("p", { class: "wordmark big", "aria-hidden": "true" }, "PLUR", h("span", { class: "one" }, "1"), "BUS"),
      h("h1", { tabIndex: -1 }, t("oauth.title")),
      h("p", { class: "lead" }, t("oauth.lead")),

      h("div", { class: "field consent-client" },
        h("p", { style: "font-weight: 600; margin: 0 0 4px;" }, clientName),
        h("p", { style: "font-size: 0.85em; opacity: 0.8; margin: 0;" },
          t("oauth.clientId"), ": ", h("code", null, clientId),
          redirectHost ? ` · ${t("oauth.redirectUri")}: ${redirectHost}` : null,
        ),
      ),

      h("div", { class: "field" },
        h("label", { for: "consent-agent" }, t("oauth.agent")),
        h("select", {
          id: "consent-agent",
          value: selectedAgent,
          disabled: submitting,
          onChange: (e: Event) => setSelectedAgent((e.target as HTMLSelectElement).value),
        },
          agents.map((a) =>
            h("option", { key: a.id, value: a.id }, a.name !== a.id ? `${a.name} (${a.id})` : a.id)
          ),
        ),
      ),

      availableScopes.length > 0 ? h("fieldset", { class: "field consent-scopes", style: "border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;" },
        h("legend", { style: "font-weight: 500; font-size: 0.9em; padding: 0 4px;" }, t("oauth.scopes")),
        availableScopes.map((sc) =>
          h("div", { key: sc, style: "display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px;" },
            h("input", {
              id: `scope-${sc}`,
              type: "checkbox",
              checked: selectedScopes.has(sc),
              disabled: submitting,
              onChange: (e: Event) => {
                const checked = (e.target as HTMLInputElement).checked;
                const next = new Set(selectedScopes);
                if (checked) next.add(sc); else next.delete(sc);
                setSelectedScopes(next);
              },
            }),
            h("label", { for: `scope-${sc}`, style: "cursor: pointer;" },
              h("span", { style: "font-weight: 600; display: block;" }, sc),
              h("span", { style: "font-size: 0.85em; opacity: 0.75;" }, scopeDescription(sc)),
            ),
          )
        ),
      ) : null,

      secondFactorRequired ? h("div", { class: "field", role: "alert", style: "background: var(--warn-bg); padding: 12px; border-radius: 8px;" },
        h("p", { style: "margin: 0 0 8px; font-size: 0.9em;" }, t("oauth.mfa.required")),
        h("label", { for: "consent-totp" }, t("oauth.mfa.code")),
        h("input", {
          id: "consent-totp",
          type: "text",
          value: totpCode,
          autocomplete: "one-time-code",
          disabled: submitting,
          onInput: (e: Event) => setTotpCode((e.target as HTMLInputElement).value),
        }),
      ) : null,

      error ? h("p", { class: "form-notice", role: "alert" }, error) : null,
      statusMessage ? h("p", { class: "form-notice", role: "status" }, statusMessage) : null,

      h("div", { class: "actions", style: "display: flex; gap: 10px; margin-top: 20px;" },
        h("button", {
          type: "button",
          class: "btn btn-primary",
          style: "flex: 1;",
          disabled: submitting || !clientId || !redirectUri,
          onClick: handleApprove,
        }, t("oauth.approve")),
        h("button", {
          type: "button",
          class: "btn btn-quiet",
          disabled: submitting,
          onClick: handleDeny,
        }, t("oauth.deny")),
      ),
    ),
  );
}
