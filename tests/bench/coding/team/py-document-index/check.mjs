// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";
import { checkerCli } from "../_shared/check.mjs";
await checkerCli(fileURLToPath(new URL("./", import.meta.url)));
