import type { ServerResponse } from "node:http";
import { validateNotification } from "@plur1bus/rpc-schema";
import { ApiError, errors } from "./errors.ts";
import type { ImportMaintenanceContext, ImportMaintenancePort, MaintenanceAdmission } from "./import-maintenance.ts";
import type { ImportProgress } from "../../rpc-schema/generated/types.ts";

/** During Core maintenance this stream can contain only the initiating cookie's bounded run checkpoints. */
export function createMaintenanceEvents(context: ImportMaintenanceContext, port: ImportMaintenancePort) {
  const streams = new Set<{ entry: MaintenanceAdmission; end(): void }>();
  return {
    close(): void {
      for (const stream of streams) stream.end();
    },
    async open(res: ServerResponse, entry: MaintenanceAdmission, headers: Record<string, string>): Promise<void> {
      if (!port.subscribe) throw new ApiError(503, "E_NOT_AVAILABLE", "maintenance progress unavailable");
      if ([...streams].filter((stream) => stream.entry.session === entry.session).length >= 4)
        throw errors.rateLimited(5);
      let opened = false,
        stopped = false,
        dispose: (() => void) | undefined,
        timer: NodeJS.Timeout | undefined,
        pending: ImportProgress | undefined;
      const stream = {
        entry,
        end(): void {
          if (stopped) return;
          stopped = true;
          streams.delete(stream);
          clearInterval(timer);
          dispose?.();
          offEnd();
          res.end();
        },
      };
      const offEnd = context.options.sessions.onEnd((session) => {
        if (session === entry.session) stream.end();
      });
      streams.add(stream);
      res.once("close", stream.end);
      const progress = (value: ImportProgress): void => {
        if (
          stopped ||
          value.runId !== entry.runId ||
          !context.valid(entry) ||
          !validateNotification("import.progress", value).ok
        )
          return;
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json) > 4096) {
          stream.end();
          return;
        }
        if (!opened) {
          pending = value;
          return;
        }
        res.write(`event: import.progress\ndata: ${json}\n\n`);
        if (res.writableLength > 65536) stream.end();
      };
      try {
        dispose = await port.subscribe(entry, progress, stream.end);
        if (stopped || !context.valid(entry)) {
          dispose();
          stream.end();
          return;
        }
        res.writeHead(200, {
          ...headers,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        opened = true;
        res.write(": maintenance\n\n");
        if (pending) progress(pending);
        else if (entry.status?.run.progress) progress(entry.status.run.progress);
        timer = setInterval(() => {
          if (!context.valid(entry)) stream.end();
          else if (!stopped) res.write(": heartbeat\n\n");
        }, 1000);
        timer.unref();
      } catch {
        streams.delete(stream);
        offEnd();
        res.off("close", stream.end);
        dispose?.();
        throw new ApiError(503, "E_NOT_AVAILABLE", "maintenance progress unavailable");
      }
    },
  };
}
