// A strict parser for the Prometheus text exposition format 0.0.4, used only by the metrics tests: it throws on
// anything a scraper (and Zabbix's own Prometheus preprocessing) would reject.
export interface Sample { name: string; labels: Record<string, string>; value: number }
export interface Family { name: string; help: string; type: string; samples: Sample[] }

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function parseLabels(src: string, line: string): { labels: Record<string, string>; rest: string } {
  const labels: Record<string, string> = {};
  let i = 1; // after "{"
  for (;;) {
    if (src[i] === "}") { i++; break; }
    const eq = src.indexOf("=", i);
    if (eq < 0) throw new Error(`bad labels: ${line}`);
    const k = src.slice(i, eq);
    if (!LABEL_NAME.test(k)) throw new Error(`bad label name ${k}: ${line}`);
    if (src[eq + 1] !== '"') throw new Error(`label value not quoted: ${line}`);
    let j = eq + 2; let v = "";
    for (;; j++) {
      const ch = src[j];
      if (ch === undefined) throw new Error(`unterminated label value: ${line}`);
      if (ch === "\\") { const n = src[++j]; v += n === "n" ? "\n" : n === "\\" ? "\\" : n === '"' ? '"' : (() => { throw new Error(`bad escape: ${line}`); })(); continue; }
      if (ch === '"') break;
      v += ch;
    }
    if (k in labels) throw new Error(`duplicate label ${k}: ${line}`);
    labels[k] = v;
    i = j + 1;
    if (src[i] === ",") i++;
  }
  return { labels, rest: src.slice(i) };
}

export function parseExposition(text: string): Family[] {
  if (!text.endsWith("\n")) throw new Error("exposition must end with a newline");
  const families = new Map<string, Family>();
  let current: Family | null = null;
  const seen = new Set<string>();
  for (const line of text.slice(0, -1).split("\n")) {
    if (line === "") throw new Error("empty line");
    if (line.startsWith("# HELP ")) {
      const [, , name, ...help] = line.split(" ");
      if (!name || !NAME.test(name)) throw new Error(`bad HELP: ${line}`);
      if (families.has(name)) throw new Error(`family ${name} repeated`);
      current = { name, help: help.join(" "), type: "untyped", samples: [] }; families.set(name, current);
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const [, , name, type] = line.split(" ");
      if (!current || current.name !== name) throw new Error(`TYPE without HELP: ${line}`);
      if (!["counter", "gauge", "histogram", "summary", "untyped"].includes(type ?? "")) throw new Error(`bad type: ${line}`);
      current.type = type!; continue;
    }
    if (line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(line);
    if (!m || !current) throw new Error(`bad sample: ${line}`);
    let rest = line.slice(m[1]!.length); let labels: Record<string, string> = {};
    if (rest.startsWith("{")) { const p = parseLabels(rest, line); labels = p.labels; rest = p.rest; }
    const parts = rest.trim().split(" ");
    if (parts.length !== 1 || !/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|\+Inf|-Inf|NaN)$/.test(parts[0]!)) throw new Error(`bad value: ${line}`);
    const base = current.type === "histogram" ? m[1]!.replace(/_(bucket|sum|count)$/, "") : m[1]!;
    if (base !== current.name) throw new Error(`sample ${m[1]} outside its family ${current.name}`);
    const key = `${m[1]}{${Object.entries(labels).sort().join(",")}}`;
    if (seen.has(key)) throw new Error(`duplicate series ${key}`);
    seen.add(key);
    current.samples.push({ name: m[1]!, labels, value: parts[0] === "+Inf" ? Infinity : Number(parts[0]) });
  }
  return [...families.values()];
}
