import { createKeyringBackend } from "../../../src/secrets/keyring-backend.ts";
import { serveIsolatedBackend } from "../../../src/secrets/isolated-server.ts";
import { createFileBackend } from "../../../src/secrets/file-backend.ts";
import { createSecurePath } from "@plur1bus/module-api";

const items = new Map<string, string>();
let failIndex = false;
serveIsolatedBackend(description => {
  if (description.kind === "file") return createFileBackend({ dir: description.dir, secure: createSecurePath() });
  return createKeyringBackend({ service: description.service, load: async () => ({ Entry: class {
    key: string; user: string;
    constructor(service: string, user: string) { this.key = `${service}\0${user}`; this.user = user; }
    getPassword() { return items.get(this.key) ?? null; }
    setPassword(value: string) {
      if (this.user === "__plur1bus-index__" && failIndex) { failIndex = false; throw Error(value); }
      items.set(this.key, value);
      if (this.user === "rollback") failIndex = true;
    }
    deletePassword() { return items.delete(this.key); }
  } }) });
});
