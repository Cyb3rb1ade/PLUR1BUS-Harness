import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function markdownFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...markdownFiles(path));
    else if (name.endsWith(".md")) files.push(path);
  }
  return files;
}

function maskFencedCode(text) {
  const lines = text.split(/(?<=\n)/);
  let fence = null;
  return lines.map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      const masked = line.replace(/[^\r\n]/g, " ");
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return masked;
    }
    if (marker) {
      fence = marker;
      return line.replace(/[^\r\n]/g, " ");
    }
    return line;
  }).join("");
}

function maskCode(text) {
  return maskFencedCode(text).replace(/(`+)[\s\S]*?\1/g, (code) => code.replace(/[^\r\n]/g, " "));
}

function destinations(text) {
  const found = [];
  const masked = maskCode(text);
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "]" || masked[i + 1] !== "(") continue;
    let depth = 1;
    let escaped = false;
    let end = i + 2;
    for (; end < masked.length; end++) {
      const char = masked[end];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "(") depth++;
      else if (char === ")" && --depth === 0) break;
    }
    if (end >= masked.length) continue;
    const body = masked.slice(i + 2, end).trim();
    let destination = "";
    if (body.startsWith("<")) {
      const close = body.indexOf(">");
      if (close >= 0) destination = body.slice(1, close);
    } else {
      let escaped = false;
      for (const char of body) {
        if (escaped) {
          destination += char;
          escaped = false;
        } else if (char === "\\") escaped = true;
        else if (/\s/.test(char)) break;
        else destination += char;
      }
    }
    if (destination && !/^[\w$]+,\s*\{/.test(body)) found.push({ destination, offset: i });
    i = end;
  }

  for (const match of masked.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>\r\n]*>|[^\s]+).*$/gm)) {
    const destination = match[1].startsWith("<") ? match[1].slice(1, -1) : match[1];
    found.push({ destination, offset: match.index });
  }
  return found;
}

function headingAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  const lines = text.split(/\r?\n/);
  const masked = maskFencedCode(text).split(/\r?\n/);
  const add = (heading) => {
    const value = heading
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/[`*_~]/g, "")
      .replace(/\s+#*$/, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .replace(/\s+/g, "-");
    if (!value) return;
    const count = counts.get(value) ?? 0;
    counts.set(value, count + 1);
    anchors.add(count === 0 ? value : `${value}-${count}`);
  };

  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(/<(?:a|[^ >]+)\b[^>]*?\b(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
      anchors.add(match[1]);
    }
    if (/^\s{0,3}#{1,6}\s+/.test(masked[i])) {
      add(masked[i].replace(/^\s{0,3}#{1,6}\s+/, ""));
    } else if (i + 1 < masked.length && /^\s{0,3}(?:=+|-+)\s*$/.test(masked[i + 1]) && lines[i].trim()) {
      add(masked[i]);
    }
  }
  return anchors;
}

function decoded(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function checkDocLinks(root) {
  root = resolve(root);
  const docsDir = join(root, "docs");
  const files = [
    ...readdirSync(root).filter((name) => name.endsWith(".md")).map((name) => join(root, name)),
    ...markdownFiles(docsDir),
  ];
  const markdown = new Map(files.map((file) => [resolve(file), readFileSync(file, "utf8")]));
  const anchors = new Map([...markdown].map(([file, text]) => [file, headingAnchors(text)]));
  const problems = [];

  for (const [file, text] of markdown) {
    const rel = relative(root, file).split("\\").join("/");
    for (const { destination, offset } of destinations(text)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(destination)) continue;
      const [pathname, ...fragmentParts] = destination.split("#");
      const fragment = fragmentParts.join("#");
      const path = pathname ? resolve(dirname(file), decoded(pathname.split("?")[0])) : file;
      const line = text.slice(0, offset).split("\n").length;
      const display = `${rel}:${line} → broken link: ${destination}`;
      if (!existsSync(path)) {
        problems.push(`${display} (target does not exist)`);
        continue;
      }
      if (fragment && path.endsWith(".md")) {
        let targetAnchors = anchors.get(path);
        if (!targetAnchors) {
          targetAnchors = headingAnchors(readFileSync(path, "utf8"));
          anchors.set(path, targetAnchors);
        }
        if (!targetAnchors.has(decoded(fragment))) problems.push(`${display} (heading anchor does not exist)`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1] ?? "") : fileURLToPath(new URL("../", import.meta.url));
  if (rootIndex >= 0 && !process.argv[rootIndex + 1]) {
    console.error("usage: node scripts/check-doc-links.mjs [--root <directory>]");
    process.exit(2);
  }
  const problems = checkDocLinks(root);
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`\ncheck-doc-links: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("check-doc-links: ok");
}
