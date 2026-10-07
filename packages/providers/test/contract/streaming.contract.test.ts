// Shared streaming contract: see ./harness.ts. Every adapter in ADAPTERS runs every scenario in SCENARIOS, over
// synthetic recorded wire bytes (./fixtures, see its README) served by a loopback stub. Add a new adapter to
// ADAPTERS in the harness; the completeness test at the end fails until it runs the whole contract.
import { registerContract } from "./harness.ts";

registerContract();
