// Production pool expectations from the immutable create-engine composition.
export function productionPool(modules, layout, width, active, routes) {
  const identityForStore = ({ basePath, agentId }) => {
    const match = routes.find(
      (route) =>
        (!route.agentId || route.agentId === agentId) &&
        (!route.namespace || basePath.split(/[\\/]/).at(-1) === route.namespace),
    );
    return match?.identity ?? active;
  };
  const AgentPool = modules.AgentDbPool.withOptions({ identityForStore });
  return new modules.MultiNamespacePool(layout, width, AgentPool);
}

export async function captureIdentityFailureFacade(modules, pool, scratch, agentId, query) {
  const logger = { info() {}, warn() {}, debug() {} };
  const scheduler = {
    config: { recallTimeoutMs: 600 },
    runRecall: async ({ signal, phaseTimer }, work) => {
      try {
        return { ok: true, value: await work(signal, phaseTimer), fromCache: false };
      } catch (error) {
        return { ok: false, error };
      }
    },
  };
  const assembler = modules.createPromptContextAssembler({
    cfg: {},
    host: { stateDir: scratch, logger },
    pool,
    neoEnabled: false,
    gcEnabled: false,
    runtimeScheduler: scheduler,
    automaticWorkspacePolicyDecision: () => ({ allowed: true }),
    workspacePolicyGuard: { automatic: () => ({ allowed: true }) },
  });
  const result = await assembler(
    { prompt: query },
    { agentId },
    {
      signal: new AbortController().signal,
      agentContext: { origin: "user", background: false },
      memoryCtx: { agentId, workspaceIdentity: "", userPrincipal: "" },
    },
  );
  return { blocks: result.blocks, degraded: result.degraded };
}
