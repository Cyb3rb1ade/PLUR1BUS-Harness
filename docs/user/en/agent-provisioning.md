# Agent creation and model licences

The Agents wizard sends one creation key per attempt. Retry after a connection failure: the server returns the same agent rather than creating another one. An incomplete creation is rolled back on restart; unavailable recovery is reported before agents can run. The German version of this page is [../de/agent-provisioning.md](../de/agent-provisioning.md).

The Memory wizard records your model licence confirmation with your account, server time, model, licence and pinned revision. Confirm again when choosing another NC model or revision. Administrators can query the acceptance history with `model.licence.list`. Non-interactive installation uses multilingual E5-small when no embedding selection exists. Rerunning setup preserves an existing embedding configuration; changing its model or dimensions requires the migration workflow.

Agents → Agent isolation shows what belongs to each agent and what shares the daemon process. Agent runtime storage refuses a missing or mismatched context. The operating-system account remains the trusted boundary.

Archive and export an agent before deletion. Hard deletion remains unavailable with “Erasure-API fehlt” / “Engine erasure API unavailable” until the engine supports it.

The Memory step stays unfinished when the selected model is unsupported or safe migration is unavailable. Choose the active multilingual E5-small explicitly, or update the engine and complete the embedding migration; setup never silently keeps another model.
