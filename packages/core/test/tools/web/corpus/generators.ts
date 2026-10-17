// Deterministic generators for the corpus entries that are too big (or too binary) to be checked in. Everything here is
// synthetic: prose is assembled from a small word list by arithmetic, binaries are built byte by byte. No randomness,
// so the golden SHA-256 recorded in `fixtures/web-fetch/goldens/*.json` is stable.
import { crc32, gzipSync } from "node:zlib";

const NOUNS = ["lantern", "harbour", "bearing", "gasket", "manifold", "valve", "spindle", "flange", "gauge", "rotor", "bracket", "coupling", "piston", "sensor", "filter", "bellows"];
const VERBS = ["inspect", "tighten", "replace", "calibrate", "lubricate", "drain", "align", "torque", "isolate", "bleed", "measure", "reseat"];
const ADJ = ["primary", "secondary", "outer", "inner", "left", "right", "forward", "aft", "upper", "lower", "spare", "worn"];

function sentence(seed: number): string {
  const n = (k: number, list: string[]): string => list[(seed * 7 + k * 13 + Math.floor(seed / 5)) % list.length]!;
  return `Always ${n(1, VERBS)} the ${n(2, ADJ)} ${n(3, NOUNS)} before you ${n(4, VERBS)} the ${n(5, ADJ)} ${n(6, NOUNS)}, and note the reading of the ${n(7, NOUNS)} in the log.`;
}

function paragraph(seed: number, sentences: number): string {
  return Array.from({ length: sentences }, (_, i) => sentence(seed * 31 + i)).join(" ");
}

export const MANUAL = { chapters: 25, pagesPerChapter: 20 } as const;

/** A 500-"page" service manual: 25 chapters of 20 pages, each page ~1 250 characters, a table every 10th page, a code block every 7th and a list every 5th. */
export function manual500(): { html: string; markdown: string; headings: number } {
  const html: string[] = [`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Rotorworks service manual</title></head><body><header><nav><a href="/">Home</a><a href="/manuals">Manuals</a></nav></header><main>`];
  const md: string[] = [];
  let headings = 0;
  for (let c = 1; c <= MANUAL.chapters; c++) {
    html.push(`<h1>Chapter ${c}: ${ADJ[c % ADJ.length]} ${NOUNS[c % NOUNS.length]} systems</h1>`);
    md.push(`# Chapter ${c}: ${ADJ[c % ADJ.length]} ${NOUNS[c % NOUNS.length]} systems`);
    headings++;
    for (let p = 1; p <= MANUAL.pagesPerChapter; p++) {
      const page = (c - 1) * MANUAL.pagesPerChapter + p;
      const title = `Page ${page}: ${VERBS[page % VERBS.length]} the ${NOUNS[(page * 3) % NOUNS.length]}`;
      html.push(`<h2>${title}</h2>`);
      md.push(`## ${title}`);
      headings++;
      const body = paragraph(page, 4);
      html.push(`<p>${body}</p>`);
      md.push(body);
      const more = paragraph(page + 1000, 3);
      html.push(`<p>${more}</p>`);
      md.push(more);
      if (page % 10 === 0) {
        html.push(`<table><thead><tr><th>Part</th><th>Torque (Nm)</th></tr></thead><tbody><tr><td>${NOUNS[page % NOUNS.length]}</td><td>${page % 90 + 10}</td></tr><tr><td>${NOUNS[(page + 1) % NOUNS.length]}</td><td>${page % 70 + 12}</td></tr></tbody></table>`);
        md.push(`| Part | Torque (Nm) |\n| --- | --- |\n| ${NOUNS[page % NOUNS.length]} | ${page % 90 + 10} |\n| ${NOUNS[(page + 1) % NOUNS.length]} | ${page % 70 + 12} |`);
      }
      if (page % 7 === 0) {
        html.push(`<pre><code class="language-sh">service-tool check --page ${page}\nservice-tool log --page ${page}</code></pre>`);
        md.push(`\`\`\`sh\nservice-tool check --page ${page}\nservice-tool log --page ${page}\n\`\`\``);
      }
      if (page % 5 === 0) {
        html.push(`<ul><li>Record the date of page ${page}.</li><li>Initial the checklist.</li></ul>`);
        md.push(`- Record the date of page ${page}.\n- Initial the checklist.`);
      }
    }
  }
  html.push(`</main><footer><p>Rotorworks documentation. Page footers are boilerplate.</p></footer></body></html>`);
  return { html: html.join("\n"), markdown: md.join("\n\n") + "\n", headings };
}

/** One 300 000-character paragraph on a single source line, then a 100 000-character unbroken token (a hostile URL-like string). */
export function longLine(): { html: string; markdown: string } {
  const words: string[] = [];
  for (let i = 0; i < 40000; i++) words.push(`w${String(i).padStart(5, "0")}`);
  const long = words.join(" "); // 40 000 * 7 = 280 000 chars
  const token = "x".repeat(100_000);
  return {
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Long lines</title></head><body><main><h1>Long lines</h1><p>${long}</p><h2>One enormous token</h2><p>${token}</p></main></body></html>`,
    markdown: `# Long lines\n\n${long}\n\n## One enormous token\n\n${token}\n`,
  };
}

// ---------------------------------------------------------------- binaries

const text = (s: string): Buffer => Buffer.from(s, "latin1");

/** A minimal valid single-page PDF with a text layer. */
export function pdfText(): Buffer {
  const stream = "BT /F1 18 Tf 72 720 Td (Synthetic service notice for the corpus) Tj ET";
  return assemblePdf([`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`]);
}

/** A PDF whose only content is an image XObject: no text operators, nothing to extract without OCR. */
export function pdfScanned(): Buffer {
  const pixels = "\x00\xff\x00\xff\x00\xff\x00\xff";
  const draw = "q 612 0 0 792 0 0 cm /Im0 Do Q";
  return assemblePdf([
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`,
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 4 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`,
  ]);
}

function assemblePdf(objects: string[]): Buffer {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return text(out);
}

/** A ZIP archive with stored (uncompressed) entries: enough to be a real OOXML container. */
export function zip(entries: Array<[name: string, data: string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, "utf8");
    const d = Buffer.from(data, "utf8");
    const crc = crc32(d);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(d.length, 18);
    local.writeUInt32LE(d.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, d);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(d.length, 20);
    central.writeUInt32LE(d.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + d.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

export const docx = (): Buffer =>
  zip([
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic meeting minutes for the corpus.</w:t></w:r></w:p></w:body></w:document>`],
  ]);

export const xlsx = (): Buffer =>
  zip([
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`],
    ["xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Totals" sheetId="1"/></sheets></workbook>`],
  ]);

/** A valid 1x1 PNG. */
export const png = (): Buffer =>
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

/** Bytes with NULs and no text structure. */
export const blob = (): Buffer => Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37 + (i >> 3)) % 256));

/** `bytes` of ASCII that compress to almost nothing. */
export const gzipBomb = (bytes: number): Buffer => gzipSync(Buffer.alloc(bytes, 0x61));
export const plainBytes = (bytes: number): Buffer => Buffer.alloc(bytes, 0x61);

export const GENERATED_BINARY: Record<string, () => Buffer> = {
  "pdf-text": pdfText,
  "pdf-scanned": pdfScanned,
  docx,
  xlsx,
  png,
  blob,
};
