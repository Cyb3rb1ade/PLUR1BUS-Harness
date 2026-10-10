// A minimal metrics registry for the Prometheus text exposition format 0.0.4.
//
// Cardinality is bounded by construction: every label has a closed enumeration of allowed values, a value outside it
// is folded into `other` (never stored as given), and a metric whose label space could exceed MAX_SERIES_PER_METRIC
// is refused when it is declared. So no caller-supplied string (agent name, user, path, error text) can ever become
// a label value or grow the number of series.

export const MAX_SERIES_PER_METRIC = 1024;
/** Hard ceiling even for a metric that declares its own bound (see CounterOptions.maxSeries): a runaway enumeration still fails at declaration. */
export const MAX_SERIES_HARD_LIMIT = 16384;
const OTHER = "other";
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Label name → its closed enumeration of values. `other` is always allowed (the fold target). */
export type LabelSpec = Readonly<Record<string, readonly string[]>>;
export type LabelValues = Readonly<Record<string, string>>;

interface Family { name: string; help: string; type: "counter" | "gauge" | "histogram"; lines(): string[] }

const escapeHelp = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const escapeLabel = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
function fmt(n: number): string { return n === Infinity ? "+Inf" : n === -Infinity ? "-Inf" : Number.isNaN(n) ? "NaN" : String(n); }

class Labels {
  readonly names: string[]; readonly allowed: Set<string>[];
  constructor(spec: LabelSpec, extraSeriesFactor: number, metric: string, cap = MAX_SERIES_PER_METRIC) {
    this.names = Object.keys(spec);
    this.allowed = this.names.map((n) => {
      if (!LABEL_NAME.test(n) || n.startsWith("__") || n === "le") throw new Error(`invalid label name ${JSON.stringify(n)} on ${metric}`);
      return new Set([...(spec[n] ?? []), OTHER]);
    });
    const combos = this.allowed.reduce((a, s) => a * s.size, 1);
    if (combos * extraSeriesFactor > cap) throw new Error(`${metric}: label space of ${combos * extraSeriesFactor} series exceeds the cap of ${cap}`);
  }
  /** The normalised values in declaration order. */
  values(given: LabelValues): string[] {
    return this.names.map((n, i) => { const v = given[n]; return typeof v === "string" && this.allowed[i]!.has(v) ? v : OTHER; });
  }
  render(values: readonly string[], extra?: [string, string]): string {
    const parts = this.names.map((n, i) => `${n}="${escapeLabel(values[i]!)}"`);
    if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
    return parts.length ? `{${parts.join(",")}}` : "";
  }
  /** Every combination of allowed values. */
  *all(): Generator<string[]> {
    const lists = this.allowed.map((s) => [...s]);
    const rec = function* (i: number, acc: string[]): Generator<string[]> { if (i === lists.length) { yield [...acc]; return; } for (const v of lists[i]!) { acc.push(v); yield* rec(i + 1, acc); acc.pop(); } };
    yield* rec(0, []);
  }
}

export interface CounterOptions {
  /**
   * An explicit series bound for a metric whose label enumerations are closed sets derived from a generated source (the RPC
   * method list), so the bound grows with the schema instead of silently breaking core start. Must not exceed MAX_SERIES_HARD_LIMIT;
   * the metric is still refused at declaration if its label space exceeds it. Omit for hand-written enumerations (cap 1024).
   */
  readonly maxSeries?: number;
}
export interface Counter { inc(labels?: LabelValues, by?: number): void; initAll(): void }
export interface Gauge { set(labels: LabelValues, value: number): void }
export interface Histogram { observe(labels: LabelValues, value: number): void; initAll(): void }
export interface Registry {
  counter(name: string, help: string, labels: LabelSpec, options?: CounterOptions): Counter;
  gauge(name: string, help: string, labels: LabelSpec): Gauge;
  /** An unlabelled gauge computed at render time; a throwing or non-finite callback is skipped. */
  gaugeFn(name: string, help: string, fn: () => number): void;
  histogram(name: string, help: string, labels: LabelSpec, buckets: readonly number[]): Histogram;
  render(): string;
}

export function createRegistry(): Registry {
  const families = new Map<string, Family>();
  function declare(name: string, help: string, type: Family["type"], lines: () => string[]): void {
    if (!METRIC_NAME.test(name)) throw new Error(`invalid metric name ${JSON.stringify(name)}`);
    if (families.has(name)) throw new Error(`metric ${name} is already registered`);
    families.set(name, { name, help, type, lines });
  }
  const key = (v: readonly string[]) => v.join("\u0000");

  return {
    counter(name, help, spec, options = {}) {
      const max = options.maxSeries;
      if (max !== undefined && !(Number.isInteger(max) && max >= 1 && max <= MAX_SERIES_HARD_LIMIT)) throw new Error(`${name}: maxSeries must be an integer in 1..${MAX_SERIES_HARD_LIMIT}`);
      const labels = new Labels(spec, 1, name, max);
      const series = new Map<string, { v: string[]; n: number }>();
      const bump = (v: string[], by: number) => { const k = key(v); const s = series.get(k) ?? { v, n: 0 }; s.n += by; series.set(k, s); };
      declare(name, help, "counter", () => [...series.values()].sort((a, b) => key(a.v).localeCompare(key(b.v))).map((s) => `${name}${labels.render(s.v)} ${fmt(s.n)}`));
      return {
        inc(given = {}, by = 1) { if (!Number.isFinite(by) || by < 0) return; bump(labels.values(given), by); },
        initAll() { for (const v of labels.all()) bump(v, 0); },
      };
    },
    gauge(name, help, spec) {
      const labels = new Labels(spec, 1, name);
      const series = new Map<string, { v: string[]; n: number }>();
      declare(name, help, "gauge", () => [...series.values()].sort((a, b) => key(a.v).localeCompare(key(b.v))).map((s) => `${name}${labels.render(s.v)} ${fmt(s.n)}`));
      return { set(given, value) { if (!Number.isFinite(value)) return; const v = labels.values(given); series.set(key(v), { v, n: value }); } };
    },
    gaugeFn(name, help, fn) {
      declare(name, help, "gauge", () => {
        try { const n = fn(); return Number.isFinite(n) ? [`${name} ${fmt(n)}`] : []; } catch { return []; }
      });
    },
    histogram(name, help, spec, buckets) {
      const bs = [...buckets];
      if (bs.length === 0 || bs.some((b, i) => !Number.isFinite(b) || (i > 0 && b <= bs[i - 1]!))) throw new Error(`${name}: buckets must be finite and strictly ascending`);
      const labels = new Labels(spec, bs.length + 3, name);
      const series = new Map<string, { v: string[]; counts: number[]; sum: number; count: number }>();
      const get = (v: string[]) => { const k = key(v); let s = series.get(k); if (!s) { s = { v, counts: bs.map(() => 0), sum: 0, count: 0 }; series.set(k, s); } return s; };
      declare(name, help, "histogram", () => [...series.values()].sort((a, b) => key(a.v).localeCompare(key(b.v))).flatMap((s) => [
        ...bs.map((b, i) => `${name}_bucket${labels.render(s.v, ["le", fmt(b)])} ${s.counts[i]}`),
        `${name}_bucket${labels.render(s.v, ["le", "+Inf"])} ${s.count}`,
        `${name}_sum${labels.render(s.v)} ${fmt(s.sum)}`,
        `${name}_count${labels.render(s.v)} ${s.count}`,
      ]));
      return {
        observe(given, value) {
          if (!Number.isFinite(value) || value < 0) return;
          const s = get(labels.values(given));
          s.count++; s.sum += value;
          bs.forEach((b, i) => { if (value <= b) s.counts[i]!++; }); // cumulative buckets
        },
        initAll() { for (const v of labels.all()) get(v); },
      };
    },
    render() {
      const out: string[] = [];
      for (const f of families.values()) {
        out.push(`# HELP ${f.name} ${escapeHelp(f.help)}`, `# TYPE ${f.name} ${f.type}`, ...f.lines());
      }
      return out.length ? `${out.join("\n")}\n` : "";
    },
  };
}
