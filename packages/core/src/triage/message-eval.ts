import { triage, MODEL_CLASSES, type TriageDecision, type ModelClass } from './index.ts';
export interface MessageEvalCase { id: string; message: string; gold: { start: number; end: number; category: string; minimumClass: ModelClass }[] }
/** Independent from toolcall/eval.ts and its gate. Missing predictions count as under-provisioned. */
export async function evaluateMessages(cases: readonly MessageEvalCase[], classify: (row: MessageEvalCase) => Promise<TriageDecision>) {
  let expected = 0, predicted = 0, matched = 0, under = 0, categories = 0, failed = 0;
  for (const row of cases) {
    let tasks: TriageDecision['tasks'] = [];
    try { const raw = await classify(row); tasks = triage(row.message, { classifier: () => raw }).tasks; } catch { failed++; }
    expected += row.gold.length; predicted += tasks.length;
    for (const gold of row.gold) {
      const task = tasks.find(t => t.start === gold.start && t.end === gold.end);
      if (task) { matched++; if (Object.hasOwn(task.categories, gold.category)) categories++; }
      if (!task || MODEL_CLASSES.indexOf(task.chosenClass) < MODEL_CLASSES.indexOf(gold.minimumClass)) under++;
    }
  }
  const segmentationF1 = expected + predicted ? 2 * matched / (expected + predicted) : 1;
  const underProvisioning = expected ? under / expected : 0;
  return { messages: cases.length, expected, predicted, matched, under, categories, failed, segmentationF1, underProvisioning, passed: cases.length >= 60 && !failed && segmentationF1 >= .9 && underProvisioning <= .05 };
}
