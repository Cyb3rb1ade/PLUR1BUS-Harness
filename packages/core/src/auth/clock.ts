/** Time port: the engine never reads the wall clock directly, so cooldown and expiry tests run on a fake. */
export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };
