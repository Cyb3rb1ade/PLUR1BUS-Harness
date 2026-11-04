// Decode one syntactic JSON-escape layer while retaining sparse source offsets; public text is never rewritten by decoding alone.
const ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const SIMPLE: Readonly<Record<string, string>> = {
  '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
};

export interface JsonEscapeView {
  text: string;
  sourceOffset(offset: number): number;
}

/** Only legal escape sequences change the view. Invalid escapes and every unmatched source byte remain intact. */
export function jsonEscapeView(input: string): JsonEscapeView | undefined {
  if (!input.includes("\\")) return undefined;
  const pieces: string[] = [], ends: number[] = [], deltas: number[] = [];
  let last = 0, delta = 0;
  for (const match of input.matchAll(ESCAPE)) {
    const decoded = match[1] === undefined ? SIMPLE[match[2]!]! : String.fromCharCode(Number.parseInt(match[1], 16));
    pieces.push(input.slice(last, match.index), decoded);
    ends.push(match.index - delta + 1);
    delta += match[0].length - 1;
    deltas.push(delta);
    last = match.index + match[0].length;
  }
  if (last === 0) return undefined;
  pieces.push(input.slice(last));
  return {
    text: pieces.join(""),
    sourceOffset(offset) {
      let low = 0, high = ends.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (ends[middle]! <= offset) low = middle + 1;
        else high = middle;
      }
      return offset + (low === 0 ? 0 : deltas[low - 1]!);
    },
  };
}

const STRING_TOKEN = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/g;

/** Inspect decoded payloads and one nested escape layer only inside strings/keys; structural punctuation is not secret text. */
export function jsonSecretViews(json: string): readonly string[] {
  if (!json.includes("\\")) return [];
  const views: string[] = [];
  const retain = (text: string): void => {
    views.push(text);
    if (!text.isWellFormed()) views.push(text.toWellFormed());
  };
  for (const token of json.matchAll(STRING_TOKEN)) {
    if (!token[0].includes("\\")) continue;
    const payload = jsonEscapeView(token[0].slice(1, -1));
    if (payload) retain(payload.text);
    const nested = payload && jsonEscapeView(payload.text);
    if (nested) retain(nested.text);
  }
  return views;
}
