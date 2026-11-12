// RE-05/T5 neo-names recordings from verified pinned Node sources.
// PLUR1BUS_ENGINE_SRC=<pin archive> PLUR1BUS_ENGINE_GIT=<read-only repository> node <this-file>
// No model, network, credentials or derived model output is used by this recorder.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PIN = "b097045b6f115275baa8b15016321c3ba080c812";
const root = process.env.PLUR1BUS_ENGINE_SRC;
const git = process.env.PLUR1BUS_ENGINE_GIT;
if (!root || !git || process.version !== "v24.21.0") {
  throw new Error("pinned source, read-only git and Node 24.21.0 required");
}
const verified = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function verify(relative) {
  if (verified.has(relative)) return;
  const source = readFileSync(path.join(root, relative));
  const expected = execFileSync("git", ["-C", git, "show", `${PIN}:${relative}`], { maxBuffer: 16 * 1024 * 1024 });
  if (!source.equals(expected)) throw new Error(`pinned neo-names source hash mismatch: ${relative}`);
  verified.set(relative, digest(source));
  for (const match of source.toString().matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const relativeImport = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (/\.[cm]?js$/.test(relativeImport)) verify(relativeImport);
  }
}

verify("lib/episodes.js");

const { resolveParticipantNames } = await import(pathToFileURL(path.join(root, "lib/episodes.js")));
const assert = (await import("node:assert/strict")).default;
const { tmpdir } = await import("node:os");
const input = [
  ["missing", null, null],
  ["plain", "**Name:** Ada\n", "**Name:** Rust Assistant\n"],
  ["assistant-only", null, "**Name:** Helper"],
  ["markdown", "**Name:** **Ada_ Lovelace** `One`", "**Name:** _Assistant_"],
  ["case-sensitive", "**name:** Ada", "Name: Assistant"],
  ["placeholder-dash", "**Name:** -", "**Name:** —"],
  ["multiple-dashes", "**Name:** --", "**Name:** ---"],
  ["empty-markdown", "**Name:** _**_`", "**Name:**   \n \t"],
  ["first-match", "**Name:** First\n**Name:** Second", "prefix **Name:** Inline"],
  ["cross-newline", "**Name:**\nNext paragraph\nEnd", "**Name:**\r\nAgent"],
  ["carriage-return", "**Name:** Ada\rMiddle\nEnd", "**Name:** A\u2028B"],
  ["js-whitespace", "**Name:**\ufeff\u00a0Ada\u3000", "**Name:**\u0085Other"],
  ["nfd", "**Name:** A\u0308nne", "**Name:** Änne"],
  ["surrogate-cut-name", "**Name:** " + "x".repeat(59) + "😀after", "**Name:** " + "x".repeat(58) + "😀after"],
  ["source-cut-surrogate", "x".repeat(3990) + "**Name:**😀", null],
  ["source-boundary", "x".repeat(3980) + "**Name:**1234567890ABC", null],
  ["after-source-limit", "x".repeat(4000) + "**Name:** Hidden", null],
  ["large-tail", "**Name:** Ada\n" + "x".repeat(20000), "**Name:** Agent"],
  ["cache-same-mtime", "**Name:** Before", "**Name:** Agent"],
];
function run() {
  const cases=[];
  for (const [name,user,assistant] of input) {
    const dir=mkdtempSync(path.join(tmpdir(),"neo-name-recording-"));
    try {
      const files={};
      for (const [file,value] of [["USER.md",user],["IDENTITY.md",assistant]]) if(value!==null) {
        files[file]=Buffer.from(value).toString("hex");writeFileSync(path.join(dir,file),Buffer.from(value));
        utimesSync(path.join(dir,file),1700000000,1700000000);
      }
      const output=resolveParticipantNames(dir,{agentId:"alpha"});
      let cache=null;
      if(name==="cache-same-mtime") {
        const bytes=Buffer.from("**Name:** After");writeFileSync(path.join(dir,"USER.md"),bytes);utimesSync(path.join(dir,"USER.md"),1700000000,1700000000);
        cache={replacement:bytes.toString("hex"),output:resolveParticipantNames(dir,{agentId:"alpha"})};
      }
      cases.push({name,agentId:"alpha",files,output,cache});
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
  for(const bytes of [[0xff,0x41],[0xc3,0x28],[0xed,0xa0,0x80],[0xf0,0x9f,0x98],[0xe2,0x82,0xac]]) {
    const dir=mkdtempSync(path.join(tmpdir(),"neo-name-bytes-"));
    try {
      const raw=Buffer.concat([Buffer.from("**Name:** "),Buffer.from(bytes)]);
      writeFileSync(path.join(dir,"USER.md"),raw);
      cases.push({name:`utf8-${Buffer.from(bytes).toString("hex")}`,agentId:"alpha",files:{"USER.md":raw.toString("hex")},output:resolveParticipantNames(dir,{agentId:"alpha"}),cache:null});
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
  return cases;
}
const cases=run();assert.deepEqual(run(),cases);
writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),"golden/neo-names.json"),JSON.stringify({provenance:{commit:PIN,node:process.version,sourceHashes:Object.fromEntries(verified)},cases},null,2)+"\n");
console.log(`Recorded ${cases.length} actual Node participant-name cases twice`);
