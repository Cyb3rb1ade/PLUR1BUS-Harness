// This private helper is launched through an inherited IPC channel, never an RPC endpoint.
import { createSecurePath } from "@plur1bus/module-api";
import { createFileBackend } from "./secrets/file-backend.ts";
import { createKeyringBackend } from "./secrets/keyring-backend.ts";
import { serveIsolatedBackend } from "./secrets/isolated-server.ts";

if (!process.send) throw new Error("secret backend helper requires private IPC");
serveIsolatedBackend(description => description.kind === "keyring"
  ? createKeyringBackend({ service: description.service })
  : createFileBackend({ dir: description.dir, secure: createSecurePath() }));
