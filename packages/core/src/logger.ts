// The harness's JSON-lines logger lives in @plur1bus/module-api (H3B-R12: module processes log the same way); the
// engine adapter stays here, with the engine.
import { serializeError, type HarnessLogger } from "@plur1bus/module-api";

export { createLogger, type HarnessLogger, type Level } from "@plur1bus/module-api";

/** Adapter to the engine's Logger shape (message + rest args). */
export function engineLoggerFrom(log: HarnessLogger) {
  const fields = (rest: unknown[]) => (rest.length ? { rest: rest.map(serializeError) } : undefined);
  return {
    info: (m: string, ...r: unknown[]) => log.info(m, fields(r)), warn: (m: string, ...r: unknown[]) => log.warn(m, fields(r)),
    error: (m: string, ...r: unknown[]) => log.error(m, fields(r)), debug: (m: string, ...r: unknown[]) => log.debug(m, fields(r)),
  };
}
