import { ProviderError } from "../errors.ts";
import type { StreamingAdapter } from "../router/types.ts";
import type { CallOptions, ChatRequest, ChatStreamEvent } from "../types.ts";
import type { LocalEndpointMonitor } from "./monitor.ts";

/**
 * Wraps a local chat adapter so a dead endpoint fails fast and the router falls back instead of waiting on a socket.
 * RULING: the error is kind `network` (so the router may fall back) but `retryable: false` (so it does not retry the
 * dead endpoint). A fresh unavailable status costs no network; an unknown or stale one is refreshed once (bounded by
 * the discovery deadline). A refresh that itself failed (status still unknown) does not block the chat: delegate.
 */
export function guardLocalAdapter(monitor: LocalEndpointMonitor, label: string, inner: StreamingAdapter): StreamingAdapter {
  if (monitor.status(label) === undefined) throw new TypeError(`unknown local endpoint "${label}"`);
  const unavailable = () => {
    const reason = monitor.status(label)?.availability?.reason ?? "unreachable";
    return new ProviderError("network", `local provider "${label}" is unavailable (${reason})`, { retryable: false, code: "unavailable" });
  };
  return {
    async *stream(request: ChatRequest, options?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void> {
      if (!monitor.isFresh(label)) await monitor.refresh(options?.signal ? { signal: options.signal } : {});
      if (monitor.status(label)?.status === "unavailable") throw unavailable();
      try {
        yield* inner.stream(request, options);
      } catch (e) {
        if (e instanceof ProviderError && e.kind === "network") monitor.reportFailure(label);
        throw e;
      }
    },
  };
}
