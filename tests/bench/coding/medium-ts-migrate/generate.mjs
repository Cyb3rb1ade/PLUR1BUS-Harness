/** Original MIT B1 seeded generator; only public starting identifiers, constants and names vary. */
import { seededInstance } from "../seed.mjs";
/** Generate deterministic public identifiers, constants and entry names for one seed. */
export const generate = (seed) => seededInstance("medium-ts-migrate", "src/main.ts", seed);
