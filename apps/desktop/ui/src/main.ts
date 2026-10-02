import { createShell } from "./shell.ts";
import { nativeTransport } from "./ipc.ts";

createShell(document.body, nativeTransport);
