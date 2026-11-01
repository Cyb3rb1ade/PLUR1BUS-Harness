/** Pure managed-provider and model-role policy; no socket, credential or host-setting access. */
export const MIN_CONTEXT_AGENT_ROLE = 16_384;
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

function references(ref: unknown, profiles: Record<string, unknown>): string[] {
  if (typeof ref !== "string") return [];
  if (!Object.hasOwn(profiles, ref)) return [ref];
  const candidates = object(profiles[ref]).candidates;
  return Array.isArray(candidates) ? candidates.flatMap(candidate => {
    const model = object(candidate).model;
    return typeof model === "string" ? [model] : [];
  }) : [];
}

function contextWindow(ref: string, catalog: unknown): number | undefined {
  if (ref === "apple-fm/system") return 4096;
  const models = object(catalog).models;
  if (!Array.isArray(models)) return undefined;
  const model = models.map(object).find(model => `${model.provider}/${model.id}` === ref);
  const window = model?.contextWindow;
  return typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : undefined;
}

function roleError(path: string, ref: unknown, profiles: Record<string, unknown>, catalog: unknown): string[] {
  const windows = references(ref, profiles).flatMap(model => {
    const window = contextWindow(model, catalog);
    return window !== undefined && window < MIN_CONTEXT_AGENT_ROLE ? [window] : [];
  });
  return windows.length ? [`${path} context-too-small: window ${Math.min(...windows)} is below the ${MIN_CONTEXT_AGENT_ROLE} agent-role floor`] : [];
}

/** Fixed messages identify policy and window; arbitrary configuration values never enter the error. */
export function appleFmConfigErrors(value: unknown, catalog?: unknown): string[] {
  const cfg = object(value);
  if (Object.hasOwn(object(cfg.providers), "apple-fm")) {
    return ["/providers/apple-fm reserved-provider-id: apple-fm is synthesized by the core"];
  }
  const profiles = object(cfg.modelProfiles), roles = object(cfg.modelRoles), agents = object(cfg.agents);
  const classes = Object.values(object(object(cfg.decision).classProfiles));
  const refs = [...classes, ...Object.values(roles), ...Object.keys(profiles), ...Object.values(agents).map(agent => object(agent).model)]
    .flatMap(ref => references(ref, profiles));
  if (refs.some(ref => ref.startsWith("apple-fm/") && ref !== "apple-fm/system")) {
    return ["/modelRoles model_not_allowed: apple-fm only allows system"];
  }
  for (const role of ["chat", "reasoning", "capture", "dream"]) {
    const errors = roleError(`/modelRoles/${role}`, roles[role], profiles, catalog);
    if (errors.length) return errors;
  }
  for (const ref of classes) {
    const errors = roleError("/decision/classProfiles", ref, profiles, catalog);
    if (errors.length) return errors;
  }
  const implicit = ["default", ...Object.values(agents).map(agent => object(agent).model)];
  for (const ref of implicit) {
    const errors = roleError("/modelProfiles", ref, profiles, catalog);
    if (errors.length) return errors;
  }
  return [];
}
