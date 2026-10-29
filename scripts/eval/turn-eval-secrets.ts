/**
 * N-G2 setup step of the live turn eval: put the provider keys into the harness secret store of the short-lived eval home.
 * It is the only step that sees the key variables; scripts/eval/turn-eval.ts then resolves credentials from the store
 * alone. Why not `plur1bus login <provider> --api-key`: that stores through a running core, which the nightly would have to
 * build (Rust CLI, supervisor, core) just for this; this writes through the same store API the core's `secret.set` uses,
 * under the same secret name (`<provider>/api-key`).
 */
import {
  openTurnEvalSecrets, parseTurnEvalModels, storeTurnEvalCredentials, turnEvalHome,
} from "../../packages/core/src/toolcall/turn-eval-live.ts";

if (process.argv.length > 2) throw new Error("unknown turn eval secrets argument");
const models = parseTurnEvalModels(process.env.PLUR1BUS_TURN_EVAL_MODELS);
const stored = await storeTurnEvalCredentials(models, process.env, openTurnEvalSecrets(turnEvalHome()));
console.log(JSON.stringify({ stored }));
