# Agent creation and model licences

The Agents wizard sends one creation key per attempt. Retry after a connection failure: the server returns the same agent rather than creating another one. An incomplete creation is rolled back on restart; unavailable recovery is reported before agents can run. The German version of this page is [../de/agent-provisioning.md](../de/agent-provisioning.md).

The Memory wizard records your model licence confirmation with your account, server time, model, licence and pinned revision. Confirm again when choosing another NC model or revision. Administrators can query the acceptance history with `model.licence.list`. A confirmed non-commercial model is loaded only while the use class is not commercial. Non-interactive installation uses multilingual E5-small when no embedding selection exists. Rerunning setup preserves an existing embedding configuration; changing its model or dimensions requires the migration workflow.

Agents → Agent isolation shows what belongs to each agent and what shares the daemon process. Agent runtime storage refuses a missing or mismatched context. The operating-system account remains the trusted boundary.

Archive and export an agent before deletion. Hard deletion remains unavailable with “Erasure-API fehlt” / “Engine erasure API unavailable” until the engine supports it.

The Memory step comes before the first agent is created, because creating an agent creates its memory table in the active embedding model. While the memory holds no data, the step writes the chosen embedding model and reranker into `engine.embedding` and `engine.reranker`, and the memory engine uses them from its restart on ([memories.md](memories.md#embedding-model-and-reranker)). Once there is data, the step keeps the embedding model in use and changes only the reranker; another embedding model then needs the migration workflow ([reembed.md](reembed.md)). The step never reports a model as chosen that the engine does not run.
