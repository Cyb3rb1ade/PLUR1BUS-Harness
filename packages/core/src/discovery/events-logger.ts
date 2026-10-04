import type { ScanErrorInfo, ScanResultCode } from "./types.ts";
import type { DiscoveryEvents } from "./ports.ts";

export interface LoggerLike {
  debug(msg: string, fields?: object): void;
  info(msg: string, fields?: object): void;
  warn(msg: string, fields?: object): void;
  error(msg: string, fields?: object): void;
}

export function createLoggerEvents(logger: LoggerLike): DiscoveryEvents {
  return {
    discovered(e: {
      provider: string;
      count: number;
      models: string[];
      reappeared: string[];
      truncated: boolean;
      traceId: string;
    }): void {
      logger.info("model.discovered", {
        source: `provider:${e.provider}`,
        trace_id: e.traceId,
        provider: e.provider,
        count: e.count,
        models: e.models,
        reappeared: e.reappeared,
        truncated: e.truncated,
      });
    },

    unavailable(e: {
      provider: string;
      count: number;
      models: string[];
      roles: string[];
      truncated: boolean;
      traceId: string;
    }): void {
      const level = e.roles.length > 0 ? "warn" : "info";
      logger[level]("model.unavailable", {
        source: `provider:${e.provider}`,
        trace_id: e.traceId,
        provider: e.provider,
        count: e.count,
        models: e.models,
        roles: e.roles,
        truncated: e.truncated,
      });
    },

    scanFailed(e: {
      provider: string;
      result: ScanResultCode;
      httpStatus?: number;
      retryAfterS?: number;
      nextScanAt: string;
      consecutiveFailures: number;
      err: ScanErrorInfo;
      traceId: string;
    }): void {
      const isError = e.result === "failed:auth" || e.result === "failed:invalid";
      const level = isError ? "error" : "warn";
      logger[level]("model.scan.failed", {
        source: `provider:${e.provider}`,
        trace_id: e.traceId,
        provider: e.provider,
        result: e.result,
        ...(e.httpStatus !== undefined ? { http_status: e.httpStatus } : {}),
        ...(e.retryAfterS !== undefined ? { retry_after_s: e.retryAfterS } : {}),
        next_scan_at: e.nextScanAt,
        consecutive_failures: e.consecutiveFailures,
        err: e.err,
      });
    },

    scanCompleted(e: {
      provider: string;
      result: ScanResultCode;
      durationMs: number;
      counts: {
        new: number;
        reappeared: number;
        unavailable: number;
        unchanged: number;
        duplicates: number;
      };
      traceId: string;
    }): void {
      logger.debug("model.scan.completed", {
        source: `provider:${e.provider}`,
        trace_id: e.traceId,
        provider: e.provider,
        result: e.result,
        duration_ms: e.durationMs,
        counts: e.counts,
      });
    },
  };
}
