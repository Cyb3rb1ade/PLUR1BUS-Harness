// A `node:module` customization hook: records every URL the core process resolves while
// starting, so the import-hygiene test can assert none of them is a forbidden host-adapter
// module (spec criterion 6).
import { appendFileSync } from "node:fs";

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (process.env.PLUR1BUS_TRACE_FILE) appendFileSync(process.env.PLUR1BUS_TRACE_FILE, `${r.url}\n`);
  return r;
}
