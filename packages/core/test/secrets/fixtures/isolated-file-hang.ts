import { createFileBackend } from "../../../src/secrets/file-backend.ts";
import { serveIsolatedBackend } from "../../../src/secrets/isolated-server.ts";

serveIsolatedBackend(description => {
  if (description.kind !== "file") throw Error("unexpected backend");
  return createFileBackend({ dir: description.dir, secure() {
    process.send?.({ entered: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return { applied: false };
  } });
});
