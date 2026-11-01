/** Original MIT B1 seeded generator; only public starting identifiers, constants and names vary. */
import { seededInstance } from "../seed.mjs";
/** Generate deterministic public identifiers, constants and entry names for one seed. */
export const generate = (seed) => seededInstance("hard-rust-intervals", "src/solution.rs", seed);
