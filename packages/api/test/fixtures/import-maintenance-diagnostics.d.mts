export interface ReportSummary {
  status: "read";
  errors: number | null;
  reasons: Record<string, number>;
  reasonsTruncated: boolean;
  agentsRejected: number | null;
  memoryCardsImported: number | null;
  memoryCardsRejected: number | null;
  skillsFailed: number | null;
}
export function summarizeReport(report: unknown): ReportSummary;
export function failureReports(home: string, runId: string): Promise<{
  import: ReportSummary | { status: "unavailable" };
  skills: ReportSummary | { status: "unavailable" };
}>;
