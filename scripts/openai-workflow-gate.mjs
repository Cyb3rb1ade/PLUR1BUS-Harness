// D110 §5.8: OpenAI credentials may appear only in the explicit owner-gated live job.
// Keep the job and gate exact. Workflow/global env and reusable secret inheritance cannot bypass it.
export function openaiWorkflowFindings(path, text) {
  const lines = text.split(/\r?\n/), findings = [];
  let inJobs = false, job = null, block = [];
  const flush = () => {
    if (!block.length) return;
    const body = block.map(x => x.text).join("\n");
    const gated = path === ".github/workflows/nightly.yml" && job === "openai-live" &&
      /^    environment: provider-live\s*$/m.test(body) &&
      /^    if: (?:\$\{\{\s*)?github\.event_name == 'workflow_dispatch' && vars\.PLUR1BUS_OPENAI_LIVE == '1'(?:\s*\}\})?\s*$/m.test(body);
    for (const { text: line, at } of block) if (!gated && (/secrets(?:\.[A-Za-z0-9_]*openai[A-Za-z0-9_]*|\s*\[\s*["'][^"']*openai[^"']*["']\s*\])/i.test(line) || /secrets:\s*inherit\b/.test(line))) findings.push({ line: at, job });
    block = [];
  };
  lines.forEach((line, i) => {
    if (/^jobs:\s*$/.test(line)) { flush(); inJobs = true; job = null; }
    else if (/^\S/.test(line) && !line.startsWith("#")) { flush(); inJobs = false; job = null; }
    if (inJobs && /^  [\w-]+:\s*$/.test(line)) { flush(); job = line.trim().slice(0, -1); }
    block.push({ text: line, at: i + 1 });
  });
  flush(); return findings;
}
