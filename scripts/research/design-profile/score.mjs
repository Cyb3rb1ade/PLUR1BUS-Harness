// Compare a pinned Dembrandt 0.39.2 JSON extraction with Glow's authored
// declarations and, optionally, an independent rendered DOM inventory.
// Usage: node score.mjs tokens.css extraction.json light|dark [dom-reference.json]
import { readFile } from "node:fs/promises";

const [, , cssPath, extractionPath, theme, domPath, ...extra] = process.argv;
if (!cssPath || !extractionPath || !["light", "dark"].includes(theme) || extra.length) {
  process.stderr.write("Usage: node score.mjs tokens.css extraction.json light|dark [dom-reference.json]\n");
  process.exit(2);
}

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const extraction = await json(extractionPath);
if (extraction.error || !extraction.colors?.cssVariables || !extraction.colors?.semantic ||
    !Array.isArray(extraction.typography?.styles) || !Array.isArray(extraction.borderRadius?.values) ||
    !Array.isArray(extraction.spacing?.commonValues)) {
  throw new Error("Expected a complete Dembrandt 0.39.2 extraction");
}
if (extraction.meta?.context?.colorScheme !== theme) {
  throw new Error("The extraction must start in the requested theme. The --dark-mode merge is not a dark-only extraction.");
}

const css = (await readFile(cssPath, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
function declarations(rule) {
  const block = css.match(rule)?.[1];
  if (block === undefined) throw new Error("Missing expected Glow rule " + rule);
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.trim()]));
}
const root = declarations(/^\s*:root\s*\{([^}]*)}/);
const explicitLight = declarations(/:root\[data-theme="light"\]\s*\{([^}]*)}/);
const systemLight = declarations(/:root:not\(\[data-theme\]\)\s*\{([^}]*)}/);
if (JSON.stringify(explicitLight) !== JSON.stringify(systemLight)) {
  throw new Error("Explicit light and system light declarations differ");
}
const tokens = theme === "light" ? { ...root, ...explicitLight } : root;
const density = declarations(/:root,\s*:root\[data-density="comfortable"\]\s*\{([^}]*)}/);

function color(value) {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().match(/^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((v) => v + v).join("") : hex;
    const bytes = expanded.match(/../g).map((v) => Number.parseInt(v, 16));
    const [r, g, b, a = 255] = bytes;
    return [r, g, b, +(a / 255).toFixed(3)].join(",");
  }
  const components = value.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (!components) return undefined;
  const [, r, g, b, a = "1"] = components;
  return [+r, +g, +b, +Number(a).toFixed(3)].join(",");
}

const family = (value) => typeof value === "string"
  ? value.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase()
  : undefined;
function pixels(value) {
  const number = typeof value === "string" ? value.match(/^(-?(?:\d+\.?\d*|\.\d+))px(?:\s|$)/)?.[1] : undefined;
  return number === undefined ? undefined : String(Number(number));
}
const dimension = (value) => pixels(value) ?? (typeof value === "string" && value.endsWith("%") ? value : undefined);
function weight(value) {
  if (value === "normal") return "400";
  if (value === "bold") return "700";
  return /^\d+$/.test(String(value)) ? String(value) : undefined;
}

function setScore(truth, found) {
  const expected = new Set(truth.filter((value) => value !== undefined));
  const observed = new Set(found.filter((value) => value !== undefined));
  const matches = [...expected].filter((value) => observed.has(value));
  return {
    matches: matches.length,
    expected: expected.size,
    observed: observed.size,
    recall: expected.size ? matches.length / expected.size : null,
    precision: expected.size && observed.size ? matches.length / observed.size : null,
    missing: [...expected].filter((value) => !observed.has(value)),
    extra: [...observed].filter((value) => !expected.has(value)),
  };
}
function rolePairs(values, getValue) {
  return Object.entries(values).flatMap(([role, raw]) => {
    const value = color(getValue(raw));
    return value === undefined ? [] : [role + "=" + value];
  });
}
const roleAliases = { background: "--bg", text: "--ink", primary: "--primary-bg", accent: "--accent" };
const roleValues = Object.fromEntries(Object.entries(roleAliases).map(([role, token]) => [role, tokens[token]]));
const styles = extraction.typography.styles;
const found = {
  fontFamilies: styles.map((row) => family(row.family)),
  fontSizes: styles.map((row) => pixels(row.size)),
  fontWeights: styles.map((row) => weight(row.weight)),
  radii: extraction.borderRadius.values.map((row) => dimension(row.value)),
  spacing: extraction.spacing.commonValues.map((row) => pixels(row.px)),
};
const result = {
  theme,
  context: extraction.meta.context,
  glow: {
    namedColors: setScore(rolePairs(tokens, (value) => value),
      rolePairs(extraction.colors.cssVariables, (entry) => entry.value)),
    inferredColorRoles: setScore(rolePairs(roleValues, (value) => value),
      rolePairs(extraction.colors.semantic, (value) => value)),
    fontFamilies: setScore(Object.entries(tokens).filter(([key]) => key.startsWith("--font-"))
      .map(([, value]) => family(value)), found.fontFamilies),
    fontSizes: setScore([], found.fontSizes),
    fontWeights: setScore([], found.fontWeights),
    radii: setScore([], found.radii),
    spacing: setScore([pixels(density["--gap"])], found.spacing),
  },
};
if (domPath) {
  const dom = await json(domPath);
  const { width, height } = extraction.meta.context.viewport;
  if (dom.scheme !== theme || dom.viewport?.[0] !== width || dom.viewport?.[1] !== height) {
    throw new Error("DOM reference theme or viewport does not match the extraction");
  }
  if (dom.location !== new URL(extraction.url).hash) {
    throw new Error("DOM reference route does not match the extraction");
  }
  const formats = { fontFamilies: family, fontSizes: pixels, fontWeights: weight, radii: dimension, spacing: pixels };
  result.rendered = Object.fromEntries(Object.entries(formats).map(([category, format]) =>
    [category, setScore(dom.values[category].map(format), found[category])]));
}
console.log(JSON.stringify(result, null, 2));
