import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateLearning, type LearnEvalCase } from '../../packages/core/src/dreams/learn/eval.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2), live = args.includes('--live'), fake = args.includes('--fake');
  const out = args.indexOf('--out');
  if (live && fake || out >= 0 && (!args[out + 1] || args[out + 1]!.startsWith('--')) || args.some((a, i) => !(out >= 0 && i === out + 1) && !['--live', '--fake', '--dry-run', '--out'].includes(a))) throw Error('invalid arguments');
  if (live && (args.includes('--dry-run') || process.env.PLUR1BUS_LEARN_EVAL_LIVE !== '1')) throw Error('explicit live consent required');
  const cases = JSON.parse(readFileSync(new URL('../../tests/eval/learn/cases.json', import.meta.url), 'utf8')) as LearnEvalCase[];
  let report: unknown;
  if (live) {
    const { composeTurnEvalProviders, parseTurnEvalModels, openTurnEvalSecrets, turnEvalHome } = await import('../../packages/core/src/toolcall/turn-eval-live.ts');
    const { learningModel } = await import('../../packages/core/src/dreams/learn/provider.ts');
    const { ToolRegistry } = await import('../../packages/core/src/tools/registry.ts');
    const { createCallBudget } = await import('../../packages/core/src/budget/calls.ts');
    const models = parseTurnEvalModels(process.env.PLUR1BUS_LEARN_EVAL_MODELS);
    const providers = composeTurnEvalProviders(models, { secrets: openTurnEvalSecrets(turnEvalHome()) });
    const dir = mkdtempSync(join(tmpdir(), 'learn-eval-budget-')), reports: unknown[] = [];
    try {
      for (const [index, spec] of models.entries()) {
        const budget = createCallBudget({ path: join(dir, `budget-${index}.sqlite`), clock: { now: Date.now } });
        try {
          const candidate = { provider: spec.provider, model: spec.model, adapter: providers.adapters[index]! };
          const model = learningModel({ registry: new ToolRegistry(), budget, profiles: { evaluation: [candidate] }, profileForClass: () => 'evaluation',
            grants: { get: () => undefined, list: () => [] }, approval: { request: async () => ({ approved: false }) }, log: () => {},
            resultStore: { async put() { throw Error('tools unavailable'); } }, router: { retry: { maxRetries: 0 } }, isLocalProvider: () => spec.local === true }, () => false);
          reports.push({ provider: spec.provider, model: spec.model, report: await evaluateLearning(cases, model) });
        } finally { budget.close(); }
      }
      report = { schema: 'plur1bus.learn-eval-models/1', reports };
    } finally { providers.close(); rmSync(dir, { recursive: true, force: true }); }
  } else if (fake) {
    report = await evaluateLearning(cases);
    if ((report as Awaited<ReturnType<typeof evaluateLearning>>).results.some(r => !r.passed)) process.exitCode = 1;
  } else report = { schema: 'plur1bus.learn-eval-plan/1', mode: 'dry-run', cases: cases.length, live: false };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (out >= 0) { const file = resolve(args[out + 1]!); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text, { mode: 0o600 }); }
  process.stdout.write(text);
}
main().catch(() => { process.stderr.write('learn-eval refused or failed; verify explicit consent, model configuration and local prerequisites.\n'); process.exitCode = 1; });
