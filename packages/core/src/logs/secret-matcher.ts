// One immutable automaton per secret-set generation. Queries keep their own state and never enumerate suffix output chains.
import { REDACTION } from "@plur1bus/log-schema";

export interface SecretSpan { readonly start: number; readonly end: number }
export interface SecretTextProjection { readonly text: string; readonly spans: readonly SecretSpan[] }
export interface JsonSecretScan { readonly found: boolean; readonly matches: Uint8Array; readonly operations: number }
interface Node { next: Map<number, number>; fail: number; textMax: number; wireMax: number; text: number[]; wire: number[] }
interface Sink { put(code: number, start: number, end: number): void; finish(): void; reset(): void }
const MASK: string = REDACTION.replacementTemplate.replace("{rule}", "secret");
const MASK_BYTES = Buffer.from(MASK);
const high = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const low = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const hex = (code: number): number => code >= 48 && code <= 57 ? code - 48 : code >= 65 && code <= 70 ? code - 55 : code >= 97 && code <= 102 ? code - 87 : -1;
const SIMPLE = new Map([[34, 34], [92, 92], [47, 47], [98, 8], [102, 12], [110, 10], [114, 13], [116, 9]]);

/** Feed both original UTF-16 and its well-formed spelling without changing source coordinates. */
function spellingSink(put: (code: number, start: number, end: number, normalized: boolean) => void): Sink {
  let pending = -1, begin = 0, finish = 0;
  return {
    put(code, start, end) {
      put(code, start, end, false);
      if (pending >= 0) {
        if (low(code)) { put(pending, begin, finish, true); put(code, start, end, true); pending = -1; return; }
        put(0xfffd, begin, finish, true); pending = -1;
      }
      if (high(code)) { pending = code; begin = start; finish = end; }
      else put(low(code) ? 0xfffd : code, start, end, true);
    },
    finish() { if (pending >= 0) put(0xfffd, begin, finish, true); pending = -1; },
    reset() { pending = -1; },
  };
}

/** Decode one legal JSON-escape layer. At most six pending units; invalid spellings stay literal. */
function escapeSink(target: Sink): Sink {
  let codes: number[] = [], starts: number[] = [], ends: number[] = [];
  const clear = (): void => { codes = []; starts = []; ends = []; };
  const put = (code: number, start: number, end: number): void => {
    if (!codes.length) {
      if (code === 92) { codes.push(code); starts.push(start); ends.push(end); }
      else target.put(code, start, end);
      return;
    }
    codes.push(code); starts.push(start); ends.push(end);
    if (codes.length === 2 && SIMPLE.has(code)) { target.put(SIMPLE.get(code)!, starts[0]!, end); clear(); return; }
    if (codes[1] === 117 && (codes.length === 2 || hex(code) >= 0)) {
      if (codes.length < 6) return;
      let decoded = 0; for (let at = 2; at < 6; at++) decoded = decoded * 16 + hex(codes[at]!);
      target.put(decoded, starts[0]!, end); clear(); return;
    }
    const oldCodes = codes, oldStarts = starts, oldEnds = ends; clear();
    target.put(oldCodes[0]!, oldStarts[0]!, oldEnds[0]!);
    for (let at = 1; at < oldCodes.length; at++) put(oldCodes[at]!, oldStarts[at]!, oldEnds[at]!);
  };
  return {
    put,
    finish() { for (let at = 0; at < codes.length; at++) target.put(codes[at]!, starts[at]!, ends[at]!); clear(); target.finish(); },
    reset() { clear(); target.reset(); },
  };
}

function union(ends: Int32Array | undefined): SecretSpan[] {
  if (!ends) return [];
  const spans: SecretSpan[] = [];
  for (let start = 0; start < ends.length; start++) {
    if (!ends[start]) continue;
    let end = ends[start]!;
    for (let at = start + 1; at < end; at++) end = Math.max(end, ends[at]!);
    spans.push({ start, end }); start = end - 1; // Adjacent matches retain separate markers.
  }
  return spans;
}

function windowBounds(length: number, begin: number, end: number): void {
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin || end > length) throw new RangeError("invalid source window");
}

/** A source window may bisect a public code point; omit its incomplete half rather than introduce a new replacement spelling. */
function sourceTextSlice(input: string, begin: number, end: number): string {
  if (begin < end && begin > 0 && low(input.charCodeAt(begin)) && high(input.charCodeAt(begin - 1))) begin++;
  if (end > begin && end < input.length && high(input.charCodeAt(end - 1)) && low(input.charCodeAt(end))) end--;
  return input.slice(begin, Math.max(begin, end));
}

export class SecretMatcher {
  readonly forms: readonly string[];
  readonly maxFormUnits: number;
  readonly maxSourceBytes: number;
  readonly #minFormUnits: number;
  readonly #nodes: Node[] = [];
  readonly #order: number[] = [];
  readonly #wellFormed: readonly boolean[];

  constructor(forms: readonly string[]) {
    this.forms = Object.freeze([...new Set(forms)].filter(form => form.length > 0));
    this.#wellFormed = this.forms.map(form => form.isWellFormed());
    let max = 0, bytes = 0, min = Infinity;
    const node = (): number => { this.#nodes.push({ next: new Map(), fail: 0, textMax: 0, wireMax: 0, text: [], wire: [] }); return this.#nodes.length - 1; };
    node();
    const add = (text: string, id: number, lane: "text" | "wire"): void => {
      let state = 0;
      for (let at = 0; at < text.length; at++) {
        const code = text.charCodeAt(at); let next = this.#nodes[state]!.next.get(code);
        if (next === undefined) { next = node(); this.#nodes[state]!.next.set(code, next); }
        state = next;
      }
      this.#nodes[state]![lane].push(id);
      if (lane === "text") this.#nodes[state]!.textMax = Math.max(this.#nodes[state]!.textMax, text.length);
      else this.#nodes[state]!.wireMax = Math.max(this.#nodes[state]!.wireMax, text.length);
    };
    this.forms.forEach((form, id) => {
      max = Math.max(max, form.length); min = Math.min(min, form.length); bytes = Math.max(bytes, Buffer.byteLength(form));
      add(form, id, "text"); add(JSON.stringify(form).slice(1, -1), id, "wire");
      if (!this.#wellFormed[id]) add(form, id, "wire");
    });
    // A match can begin/end in half a code point. Include its paired neighbour at both edges, even in a fully escaped view.
    this.maxFormUnits = max; this.maxSourceBytes = max === 0 ? 0 : Math.max(bytes, (max + 2) * 6); this.#minFormUnits = min;
    this.#order.push(...this.#nodes[0]!.next.values());
    for (let at = 0; at < this.#order.length; at++) {
      const state = this.#order[at]!, current = this.#nodes[state]!;
      const fallback = this.#nodes[current.fail]!;
      current.textMax = Math.max(current.textMax, fallback.textMax); current.wireMax = Math.max(current.wireMax, fallback.wireMax);
      for (const [code, next] of current.next) {
        let fail = current.fail;
        while (fail && !this.#nodes[fail]!.next.has(code)) fail = this.#nodes[fail]!.fail;
        this.#nodes[next]!.fail = this.#nodes[fail]!.next.get(code) ?? 0; this.#order.push(next);
      }
    }
    Object.freeze(this);
  }

  #advance(state: number, code: number): number {
    while (state && !this.#nodes[state]!.next.has(code)) state = this.#nodes[state]!.fail;
    return this.#nodes[state]!.next.get(code) ?? 0;
  }

  #sourceSpans(length: number, feed: (sink: Sink) => void): SecretSpan[] {
    if (!this.forms.length || length < this.#minFormUnits) return [];
    let ends: Int32Array | undefined;
    const capacity = Math.min(length + 1, this.maxFormUnits + 1);
    const collect = (begin: number, end: number): void => { ends ??= new Int32Array(length); ends[begin] = Math.max(ends[begin]!, end); };
    const lane = (): Sink => {
      const starts = new Int32Array(capacity), codes = new Int32Array(capacity);
      let state = 0, position = 0, pendingStart = -1, pendingEnd = 0;
      return {
        put: (code, start, end) => {
          // Wait one unit after a high surrogate, so no replacement can orphan the low half that follows it.
          if (pendingStart >= 0) { collect(pendingStart, low(code) ? end : pendingEnd); pendingStart = -1; }
          starts[position % capacity] = start; codes[position % capacity] = code;
          position++; state = this.#advance(state, code);
          const matched = this.#nodes[state]!.textMax;
          if (!matched) return;
          const first = position - matched;
          let begin = starts[first % capacity]!;
          if (first > 0 && low(codes[first % capacity]!) && high(codes[(first - 1) % capacity]!)) begin = starts[(first - 1) % capacity]!;
          if (high(code)) { pendingStart = begin; pendingEnd = end; }
          else collect(begin, end);
        },
        finish() { if (pendingStart >= 0) collect(pendingStart, pendingEnd); pendingStart = -1; },
        reset() { state = position = 0; pendingStart = -1; },
      };
    };
    const direct = lane(), normalized = lane(), decoded = lane(), decodedNormalized = lane();
    const raw = spellingSink((code, start, end, norm) => (norm ? normalized : direct).put(code, start, end));
    const escaped = escapeSink(spellingSink((code, start, end, norm) => (norm ? decodedNormalized : decoded).put(code, start, end)));
    feed({
      put(code, start, end) { raw.put(code, start, end); escaped.put(code, start, end); },
      finish() { raw.finish(); escaped.finish(); direct.finish(); normalized.finish(); decoded.finish(); decodedNormalized.finish(); },
      reset() { raw.reset(); escaped.reset(); direct.reset(); normalized.reset(); decoded.reset(); decodedNormalized.reset(); },
    });
    return union(ends);
  }

  findTextSpans(input: string): readonly SecretSpan[] {
    return this.#sourceSpans(input.length, sink => { for (let at = 0; at < input.length; at++) sink.put(input.charCodeAt(at), at, at + 1); sink.finish(); });
  }

  #renderTextWindow(input: string, spans: readonly SecretSpan[], sourceBegin: number, sourceEnd: number): string {
    const pieces: string[] = []; let last = sourceBegin;
    for (const span of spans) {
      if (span.end <= sourceBegin || span.start >= sourceEnd) continue;
      pieces.push(sourceTextSlice(input, last, Math.max(sourceBegin, span.start)), MASK); last = Math.min(sourceEnd, span.end);
    }
    pieces.push(sourceTextSlice(input, last, sourceEnd)); return pieces.join("").toWellFormed();
  }

  /** Final text and every replacement's original coordinates come from the same pair-complete source projection. */
  projectText(input: string): SecretTextProjection {
    const spans = this.findTextSpans(input);
    return { spans, text: this.#renderTextWindow(input, spans, 0, input.length) };
  }

  maskTextWindow(input: string, sourceBegin: number, sourceEnd: number): string {
    windowBounds(input.length, sourceBegin, sourceEnd);
    if (sourceBegin === sourceEnd) return "";
    return this.#renderTextWindow(input, this.findTextSpans(input), sourceBegin, sourceEnd);
  }

  maskText(input: string): string {
    return this.projectText(input).text;
  }

  findByteSpans(input: Uint8Array): readonly SecretSpan[] {
    return this.#sourceSpans(input.length, sink => {
      for (let at = 0; at < input.length;) {
        const start = at, first = input[at++]!;
        let code = first, remaining = 0, minimum = 0;
        if (first >= 0xc2 && first <= 0xdf) { code = first & 31; remaining = 1; minimum = 0x80; }
        else if (first >= 0xe0 && first <= 0xef) { code = first & 15; remaining = 2; minimum = 0x800; }
        else if (first >= 0xf0 && first <= 0xf4) { code = first & 7; remaining = 3; minimum = 0x10000; }
        else if (first >= 0x80) { sink.put(-1, start, at); continue; }
        let valid = at + remaining <= input.length;
        for (let i = 0; valid && i < remaining; i++) { const next = input[at + i]!; if ((next & 0xc0) !== 0x80) valid = false; else code = code * 64 + (next & 63); }
        if (!valid || code < minimum || code > 0x10ffff || high(code) || low(code)) { sink.put(-1, start, at); continue; }
        at += remaining;
        if (code > 0xffff) { const pair = code - 0x10000; sink.put(0xd800 + (pair >>> 10), start, at); sink.put(0xdc00 + (pair & 1023), start, at); }
        else sink.put(code, start, at);
      }
      sink.finish();
    });
  }

  maskBytesWindow(input: Uint8Array, sourceBegin: number, sourceEnd: number): Buffer {
    windowBounds(input.length, sourceBegin, sourceEnd);
    if (sourceBegin === sourceEnd) return Buffer.alloc(0);
    const pieces: Uint8Array[] = []; let last = sourceBegin;
    for (const span of this.findByteSpans(input)) {
      if (span.end <= sourceBegin || span.start >= sourceEnd) continue;
      pieces.push(input.subarray(last, Math.max(sourceBegin, span.start)), MASK_BYTES); last = Math.min(sourceEnd, span.end);
    }
    pieces.push(input.subarray(last, sourceEnd)); return Buffer.concat(pieces);
  }

  maskBytes(input: Uint8Array): Buffer { return this.maskBytesWindow(input, 0, input.length); }

  /** Scan JSON wire text and each decoded string/key plus one embedded escape layer, without retaining token views. */
  scanJson(json: string): JsonSecretScan {
    const matches = new Uint8Array(this.forms.length);
    if (!this.forms.length) return { found: false, matches, operations: 0 };
    const visited = new Uint8Array(this.#nodes.length); let operations = 0, found = false;
    const advance = (state: number, code: number, lane: 1 | 2): number => {
      operations++;
      while (state && !this.#nodes[state]!.next.has(code)) { operations++; state = this.#nodes[state]!.fail; }
      state = this.#nodes[state]!.next.get(code) ?? 0; visited[state] = visited[state]! | lane;
      if (lane === 1 ? this.#nodes[state]!.textMax : this.#nodes[state]!.wireMax) found = true;
      return state;
    };
    let wire = 0;
    for (let at = 0; at < json.length; at++) wire = advance(wire, json.charCodeAt(at), 2);
    let direct = 0, normalized = 0, nested = 0, nestedNormalized = 0;
    const payload = spellingSink((code, _start, _end, norm) => { if (norm) normalized = advance(normalized, code, 1); else direct = advance(direct, code, 1); });
    const embedded = escapeSink(spellingSink((code, _start, _end, norm) => { if (norm) nestedNormalized = advance(nestedNormalized, code, 1); else nested = advance(nested, code, 1); }));
    for (let at = 0; at < json.length; at++) {
      if (json.charCodeAt(at) !== 34) continue;
      direct = normalized = nested = nestedNormalized = 0; payload.reset(); embedded.reset();
      for (at++; at < json.length && json.charCodeAt(at) !== 34; at++) {
        const start = at; let code = json.charCodeAt(at);
        if (code === 92 && at + 1 < json.length) {
          const next = json.charCodeAt(at + 1);
          if (SIMPLE.has(next)) { code = SIMPLE.get(next)!; at++; }
          else if (next === 117 && at + 5 < json.length) {
            let decoded = 0, valid = true;
            for (let i = 2; i < 6; i++) { const digit = hex(json.charCodeAt(at + i)); if (digit < 0) { valid = false; break; } decoded = decoded * 16 + digit; }
            if (valid) { code = decoded; at += 5; }
          }
        }
        payload.put(code, start, at + 1); embedded.put(code, start, at + 1);
      }
      payload.finish(); embedded.finish();
    }
    if (found) {
      // Mark terminal ancestors once per automaton state, rather than once per match (periodic inputs have enormous hit sets).
      for (let at = this.#order.length - 1; at >= 0; at--) {
        const state = this.#order[at]!, fail = this.#nodes[state]!.fail;
        visited[fail] = visited[fail]! | visited[state]!; operations++;
      }
      for (let state = 0; state < this.#nodes.length; state++) {
        if (visited[state]! & 1) for (const id of this.#nodes[state]!.text) { matches[id] = 1; operations++; }
        if (visited[state]! & 2) for (const id of this.#nodes[state]!.wire) { matches[id] = 1; operations++; }
      }
    }
    return { found, matches, operations };
  }

  hasResidual(before: JsonSecretScan, after: JsonSecretScan): boolean {
    return this.#wellFormed.some((wellFormed, id) => wellFormed && before.matches[id] === 1 && after.matches[id] === 1);
  }
}

export const createSecretMatcher = (forms: readonly string[]): SecretMatcher => new SecretMatcher(forms);
