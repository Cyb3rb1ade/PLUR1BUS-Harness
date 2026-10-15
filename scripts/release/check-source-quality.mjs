import ts from 'typescript';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
// The retired bridge names are recorded in ADR-004; shared generic CSS names
// are not evidence of derivation and must not be banned by coincidence.
export function checkTheme(text) {
  return [...new Set(text.match(/--oc-[a-zA-Z0-9_-]+/g) || [])];
}
export function checkQuality() {
  const errors = [];
  function configs(at) {
    for (const f of readdirSync(at, { withFileTypes: true })) {
      if (f.isDirectory() && !['node_modules', 'dist', 'target', '.git'].includes(f.name)) configs(join(at, f.name));
      if (f.isFile() && /^tsconfig(?:\.[^.]+)?\.json$/.test(f.name)) {
        const path = join(at, f.name), read = ts.readConfigFile(path, ts.sys.readFile);
        const config = ts.parseJsonConfigFileContent(read.config, ts.sys, at);
        if (read.error || config.errors.length || config.options.strict !== true || ["noImplicitAny", "noImplicitThis", "strictNullChecks", "strictFunctionTypes", "strictBindCallApply", "strictPropertyInitialization", "alwaysStrict", "useUnknownInCatchVariables", "strictBuiltinIteratorReturn"].some(key => config.options[key] === false)) errors.push(`${path.slice(root.length)} must resolve to TypeScript strict`);
      }
    }
  }
  configs(root);
  for (const path of ['packages/web/src/styles/tokens.css', 'apps/desktop/ui/src/theme/tokens.css']) {
    for (const token of checkTheme(readFileSync(join(root, path), 'utf8'))) errors.push(`${path}: retired theme bridge ${token}`);
  }
  return errors;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const errors = checkQuality(); for (const e of errors) console.error(e); process.exitCode = errors.length ? 1 : 0;
}
