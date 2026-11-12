import { assertNoMarkers } from "./diff.ts";

export interface Outcome {
  scenario: string;
  node: string;
  rust: string;
  ok: boolean;
}

export function renderReport(outcomes: readonly Outcome[]): string {
  const cell = (value: string) => value.replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
  const report = [
    "# Engine parity",
    "",
    "| Scenario | Node | Rust |",
    "| --- | --- | --- |",
    ...outcomes.map(row => `| ${cell(row.scenario)} | ${cell(row.node)} | ${cell(row.rust)} |`),
    "",
    `${outcomes.filter(row => row.ok).length}/${outcomes.length} scenarios passed in the selected mode.`,
    "",
  ].join("\n");
  assertNoMarkers(report, "parity report");
  return report;
}
