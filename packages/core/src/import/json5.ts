// A JSON5 parser (https://spec.json5.org) for the importer: source configuration files are JSON5, and the harness
// takes no parser dependency for a read-only detect step. Objects are built with null prototypes' semantics copied
// onto plain objects via defineProperty, so a "__proto__" key is data, never a prototype change.

// WhiteSpace (JSON5 spec 5.1: TAB, VT, FF, SP, NBSP, BOM and every Unicode Space_Separator) and LineTerminators (LF, CR, U+2028, U+2029).
const WS = new Set(["\t", "\n", "\v", "\f", "\r", " ", "\u00a0", "\u1680", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", ...Array.from({ length: 11 }, (_, k) => String.fromCharCode(0x2000 + k))]);
const ID_START = /[A-Za-z_$À-￿]/;
const ID_PART = /[A-Za-z0-9_$À-￿‌‍]/;

const isIdPart = (c: string): boolean => c !== "" && !WS.has(c) && ID_PART.test(c);

export function parseJson5(text: string): unknown {
  let i = 0;
  const fail = (what: string): never => { throw new SyntaxError(`JSON5: ${what} at offset ${i}`); };
  const skip = () => {
    for (;;) {
      const c = text[i];
      if (c !== undefined && WS.has(c)) { i++; continue; }
      if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n" && text[i] !== "\r" && text[i] !== "\u2028" && text[i] !== "\u2029") i++; continue; }
      if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); if (end < 0) fail("unterminated comment"); i = end + 2; continue; }
      return;
    }
  };
  const hex = (n: number): number => {
    const s = text.slice(i, i + n);
    if (s.length !== n || !/^[0-9a-fA-F]+$/.test(s)) fail("bad hex escape");
    i += n;
    return parseInt(s, 16);
  };
  const string = (): string => {
    const q = text[i++];
    let out = "";
    for (;;) {
      const c = text[i++];
      if (c === undefined) fail("unterminated string");
      if (c === q) return out;
      if (c === "\n" || c === "\r") fail("newline in string");
      if (c !== "\\") { out += c; continue; }
      const e = text[i++];
      switch (e) {
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "v": out += "\v"; break;
        case "0": if (/[0-9]/.test(text[i] ?? "")) fail("octal escape"); out += "\0"; break;
        case "x": out += String.fromCharCode(hex(2)); break;
        case "u": out += String.fromCharCode(hex(4)); break;
        case "\r": if (text[i] === "\n") i++; break;
        case "\n": case " ": case " ": break;
        case undefined: fail("unterminated string"); break;
        default: if (/[1-9]/.test(e)) fail("bad escape"); out += e;
      }
    }
  };
  const identifier = (): string => {
    let out = "";
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\" && text[i + 1] === "u") { i += 2; out += String.fromCharCode(hex(4)); continue; }
      if (WS.has(c) || (out === "" ? !ID_START.test(c) : !ID_PART.test(c))) break;
      out += c; i++;
    }
    if (out === "") fail("expected a key");
    return out;
  };
  const number = (): number => {
    const m = /^[+-]?(Infinity|NaN|0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) fail("bad number");
    if (/^[+-]?0[0-9]/.test(m![0])) fail("leading zero in number");
    i += m![0].length;
    const s = m![0];
    const sign = s.startsWith("-") ? -1 : 1;
    const body = s.replace(/^[+-]/, "");
    if (body === "Infinity") return sign * Infinity;
    if (body === "NaN") return NaN;
    if (/^0[xX]/.test(body)) return sign * parseInt(body.slice(2), 16);
    return sign * Number(body);
  };
  const word = (w: string, v: unknown): unknown => {
    if (text.startsWith(w, i) && !isIdPart(text[i + w.length] ?? "")) { i += w.length; return v; }
    return fail("unexpected token");
  };
  const value = (depth: number): unknown => {
    if (depth > 200) fail("nesting too deep");
    skip();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      skip();
      if (text[i] === "}") { i++; return obj; }
      for (;;) {
        skip();
        const k = text[i] === '"' || text[i] === "'" ? string() : identifier();
        skip();
        if (text[i++] !== ":") fail("expected ':'");
        Object.defineProperty(obj, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        skip();
        if (text[i] === ",") { i++; skip(); if (text[i] === "}") { i++; return obj; } continue; }
        if (text[i] === "}") { i++; return obj; }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      skip();
      if (text[i] === "]") { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        skip();
        if (text[i] === ",") { i++; skip(); if (text[i] === "]") { i++; return arr; } continue; }
        if (text[i] === "]") { i++; return arr; }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"' || c === "'") return string();
    if (c === "t") return word("true", true);
    if (c === "f") return word("false", false);
    if (c === "n") return word("null", null);
    if (c !== undefined && /[-+.0-9IN]/.test(c)) return number();
    return fail(c === undefined ? "unexpected end" : "unexpected token");
  };
  const v = value(0);
  skip();
  if (i < text.length) fail("trailing content");
  return v;
}
