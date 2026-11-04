// A real inherited-process backend channel with a synchronously blocking native-method stand-in.
import { createKeyringBackend } from "../../../src/secrets/keyring-backend.ts";
import { serveIsolatedBackend } from "../../../src/secrets/isolated-server.ts";

serveIsolatedBackend(description => {
  if (description.kind !== "keyring") throw Error("unexpected backend");
  return createKeyringBackend({ service: description.service, load: async () => ({ Entry: class {
    getPassword(): string | null {
      process.send?.({ entered: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return null;
    }
    setPassword() {}
    deletePassword() { return false; }
  } }) });
});
