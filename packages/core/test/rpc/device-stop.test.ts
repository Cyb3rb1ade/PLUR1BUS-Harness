/** A stopping Core reports lifecycle unavailability without manufacturing device revocation. */
import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceSurface } from "../../src/rpc/device-surface.ts";
import { bindApiPrincipal } from "../../../module-api/src/api-principal.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("the aborted Core signal returns only the typed stopping reason to the private API service", async () => {
  const stop = new AbortController();
  const methods = createDeviceSurface({
    state: tempDir("device-stop-"),
    clock: Date.now,
    audit: { append() {} },
    securePath: () => {},
    signal: stop.signal,
  });
  const service = { signal: new AbortController().signal, connectionId: "verified-api", requestId: "stop" };
  bindApiPrincipal(service, null);
  stop.abort();
  await assert.rejects(
    methods["admin.api.desktop.resolve"]!({ deviceId: "unneeded-during-stop" }, service),
    (error: { error?: string; reason?: string }) =>
      error.error === "E_CORE_UNAVAILABLE" && error.reason === "core-stopping",
  );
  await assert.rejects(
    methods["admin.api.desktop.resolve"]!({}, { ...service }),
    (error: { error?: string }) => error.error === "E_DENIED",
    "public context fields cannot assert the lifecycle service authority",
  );
});
