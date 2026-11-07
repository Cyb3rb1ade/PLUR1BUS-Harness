// Original MIT benchmark fixture; the generated README states the contract.
/** Inputs, outputs and failure behavior follow the generated README contract. */
export function BENCH_FN(nodes: readonly string[], edges: readonly [string, string][]): string[] {
  const indegree = new Map<string, number>(),
    outgoing = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (indegree.has(node)) throw new Error("duplicate node");
    indegree.set(node, 0);
    outgoing.set(node, new Set());
  }
  for (const [before, after] of edges) {
    if (!indegree.has(before) || !indegree.has(after)) throw new Error("missing node");
    if (!outgoing.get(before)!.has(after)) {
      outgoing.get(before)!.add(after);
      indegree.set(after, indegree.get(after)! + 1);
    }
  }
  const result: string[] = [],
    emitted = new Set<string>();
  while (result.length < nodes.length) {
    const next = nodes.find((node) => !emitted.has(node) && indegree.get(node) === 0);
    if (next === undefined) throw new Error("cycle");
    emitted.add(next);
    result.push(next);
    for (const after of outgoing.get(next)!) indegree.set(after, indegree.get(after)! - 1);
  }
  return result;
}
