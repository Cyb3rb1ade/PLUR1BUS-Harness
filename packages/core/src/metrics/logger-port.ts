/** The part of the harness logger the metrics server uses (a seam for tests). */
export interface HarnessLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
