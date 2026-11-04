// Injected loggers receive the same live exact-value policy as the default writer, including child context and Errors.
import { serializeError, type HarnessLogger, type Level } from "@plur1bus/module-api";
import type { Redactor } from "./redact.ts";

/** Keep target levels, rotation and lifecycle while masking every message and structured field before delivery. */
export function withRedaction(target: HarnessLogger, redactor: Redactor): HarnessLogger {
  const make = (base: Record<string, unknown>): HarnessLogger => {
    const emit = (level: Level, message: string, fields: Record<string, unknown> = {}): void => {
      try {
        const merged = Object.fromEntries(Object.entries({ ...base, ...fields })
          .map(([key, value]) => [key, serializeError(value)]));
        target[level](redactor.text(message), redactor.value(merged));
      } catch {
        try {
          target.error("log redaction failed; the payload was withheld");
        } catch { /* A log sink cannot stop Core. */ }
      }
    };
    return {
      debug: (message, fields) => emit("debug", message, fields),
      info: (message, fields) => emit("info", message, fields),
      warn: (message, fields) => emit("warn", message, fields),
      error: (message, fields) => emit("error", message, fields),
      child: (fields) => make({ ...base, ...fields }),
      setLevel: (level) => target.setLevel(level),
      setRotation: (options) => target.setRotation(options),
      close: () => target.close(),
    };
  };
  return make({});
}
