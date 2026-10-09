import { MODEL_CLASSES, type ModelClass, type ClassDistribution } from './classes.ts';
export * from './classes.ts';
export type CostPreference = 'economy' | 'balanced' | 'quality';
export interface TriageTask { id: string; summary: string; start: number; end: number; categories: Record<string, number>; modelClass: ClassDistribution; chosenClass: ModelClass; effort: 'low' | 'medium' | 'high'; dependsOn: string[]; confidence: number; reason: string }
export interface TriageDecision { schema: 'plur1bus.triage/1'; shape: 'chat' | 'single' | 'multi' | 'followup'; tasks: TriageTask[] }
export interface ClassifierInput { message: string; cost: CostPreference }
export type ClassifierPort = (input: ClassifierInput) => TriageDecision;
const THRESHOLD = { economy: .35, balanced: .2, quality: .1 };
export function chooseClass(distribution: ClassDistribution, cost: CostPreference = 'balanced', confidence = 1): ModelClass {
  const values = MODEL_CLASSES.map(c => distribution[c]);
  if (values.some(p => !Number.isFinite(p) || p < 0) || Math.abs(values.reduce((n, p) => n + p, 0) - 1) > 1e-6) throw Error('invalid model class distribution');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw Error('invalid confidence');
  const index = MODEL_CLASSES.findIndex((_, i) => values.slice(i + 1).reduce((n, p) => n + p, 0) <= THRESHOLD[cost] + 1e-10);
  return MODEL_CLASSES[Math.min(3, index + (confidence < .5 ? 1 : 0))]!;
}
export function escalate(current: ModelClass, alreadyEscalated: boolean): ModelClass { return alreadyEscalated ? current : MODEL_CLASSES[Math.min(3, MODEL_CLASSES.indexOf(current) + 1)]!; }
export function applyAtBoundary(current: ModelClass, recommended: ModelClass, atTaskBoundary: boolean): ModelClass { return atTaskBoundary ? recommended : current; }
const RULES: readonly [RegExp, string][] = [
  [/\b(search|research|reviews?|find online|suche|recherch|bewertungen)\w*/i, 'web.research'],
  [/\b(browser|browse|scroll|navigate|website|webseite|scrolle|navigiere)\w*/i, 'web.browse'],
  [/\b(report|pdf|document|bericht|dokument|write|schreibe|erstelle)\w*/i, 'docs.create'],
  [/\b(debug|code|implement|fix|test|fehler|programmiere)\w*/i, 'code.edit'],
  [/\b(review|audit|prüfe)\b/i, 'code.review'],
  [/\b(file|files|datei|ordner|move|verschiebe)\w*/i, 'files.manage'],
  [/\b(system|disk|process|install|speicher|prozess)\w*/i, 'ops.system'],
  [/\b(data|analyse|analyze|daten)\w*/i, 'data.analyse'],
  [/\b(email|mail|message|nachricht)\w*/i, 'comm.email'],
  [/\b(image|photo|bild|foto)\w*/i, 'media.image'],
  [/\b(memory|remember|recall|erinnere|gedächtnis)\w*/i, 'memory.manage'],
];
/** Conservative rule baseline; explicit task connectors split, ordinary "and" inside a task does not. */
export function ruleClassifier({ message, cost }: ClassifierInput): TriageDecision {
  if (!message.trim() || /^(hi|hello|hallo|danke|thanks)[!.\s]*$/i.test(message.trim())) return { schema: 'plur1bus.triage/1', shape: 'chat', tasks: [] };
  const parts: { text: string; start: number; end: number; dependent: boolean }[] = [];
  const separator = /;\s*(?:(?:then|danach|anschließend)\s+)?|\n+(?:[-*]\s*|\d+[.)]\s*)?|\s+(?:and then|und danach|then|danach)\s+/gi;
  let start = 0, dependent = false;
  for (const match of message.matchAll(separator)) { add(start, match.index!, dependent); start = match.index! + match[0].length; dependent = /then|danach|anschließend/i.test(match[0]); }
  add(start, message.length, dependent);
  function add(a: number, b: number, dep: boolean) { const text = message.slice(a, b).trim(); if (text) { const offset = message.slice(a, b).indexOf(text); parts.push({ text, start: a + offset, end: a + offset + text.length, dependent: dep }); } }
  const tasks = parts.map((p, i): TriageTask => {
    const specific = RULES.filter(([, category]) => category === 'code.review' || category === 'media.image');
    const category = [...specific, ...RULES].find(([rule]) => rule.test(p.text))?.[1] ?? 'general.chat';
    const complex = /\b(architecture|architect|security|proof|distributed|sicherheit|architektur|beweis)\w*/i.test(p.text);
    const medium = /^(code|data|web)\./.test(category);
    const modelClass: ClassDistribution = complex ? { small: 0, medium: .1, large: .85, frontier: .05 } : medium ? { small: .1, medium: .75, large: .12, frontier: .03 } : { small: .85, medium: .1, large: .04, frontier: .01 };
    const confidence = category === 'general.chat' ? .4 : .85;
    return { id: `k${i + 1}`, summary: p.text, start: p.start, end: p.end, categories: { [category]: 1 }, modelClass, chosenClass: chooseClass(modelClass, cost, confidence), effort: complex ? 'high' : medium ? 'medium' : 'low', dependsOn: p.dependent && i > 0 ? [`k${i}`] : [], confidence, reason: `rule:${category}; smallest class above-tail <= ${THRESHOLD[cost]}` };
  });
  return { schema: 'plur1bus.triage/1', shape: tasks.length > 1 ? 'multi' : 'single', tasks };
}
export function triage(message: string, options: { classifier?: ClassifierPort; cost?: CostPreference; activeTask?: string; currentClass?: ModelClass } = {}): TriageDecision {
  if (options.activeTask && /^(yes|no|ok|continue|ja|nein|weiter|genau)[!.\s]*$/i.test(message.trim())) return { schema: 'plur1bus.triage/1', shape: 'followup', tasks: [] };
  const cost = options.cost ?? 'balanced'; const result = structuredClone((options.classifier ?? ruleClassifier)({ message, cost }));
  if (result.schema !== 'plur1bus.triage/1' || !['chat', 'single', 'multi', 'followup'].includes(result.shape)) throw Error('invalid triage decision');
  const ids = new Set<string>(); let previousEnd = 0;
  for (const t of result.tasks) {
    if (!t.id || ids.has(t.id) || t.start < previousEnd || t.end <= t.start || t.end > message.length || !t.summary || t.dependsOn.some(id => !ids.has(id))) throw Error('invalid task segmentation or dependency');
    if (!Object.keys(t.categories).length || Object.keys(t.categories).length > 3 || Object.values(t.categories).some(p => !Number.isFinite(p) || p < 0) || Math.abs(Object.values(t.categories).reduce((a, b) => a + b, 0) - 1) > 1e-6) throw Error('invalid category distribution');
    t.chosenClass = chooseClass(t.modelClass, cost, t.confidence); ids.add(t.id); previousEnd = t.end;
  }
  return structuredClone(result);
}
/** Async decision port for an LLM classifier; followups skip it just like the synchronous baseline. */
export async function triageWithClassifier(message: string, classifier: (input: ClassifierInput) => Promise<TriageDecision>, options: { cost?: CostPreference; activeTask?: string } = {}): Promise<TriageDecision> {
  if (options.activeTask && triage(message, options).shape === 'followup') return triage(message, options);
  const result = await classifier({ message, cost: options.cost ?? 'balanced' }); return triage(message, { ...options, classifier: () => result });
}
