// SPDX-License-Identifier: MIT
/** Input-only sandbox bridge using K2's private {code, stdout, stderr} capture frame and an owned child group. */
import { readFile } from "node:fs/promises";
import { runOwnedCommand } from "./process.mjs";

const request = JSON.parse(await readFile(process.argv[2], "utf8"));
const result = await runOwnedCommand({
  ...request,
  stdin: Buffer.from(request.stdin, "base64").toString("utf8"),
  maxOutputBytes: request.maxOutputBytes ?? 65536,
});
const frame = {
  code: result.reason ? null : result.code,
  stdout: Buffer.from(result.stdout).toString("base64"),
  stderr: Buffer.from(result.stderr).toString("base64"),
};
process.stdout.write(JSON.stringify(frame));
