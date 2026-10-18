import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkToolchain, versionCommand, readVersion, version } from "./check-toolchain.mjs";

test("accepts node 24.16+, pnpm 10+, cargo 1.95+", () => {
  const ok = checkToolchain({ node: "v24.21.0", pnpm: "10.28.0", cargo: "cargo 1.95.0 (f2d3ce0bd 2026-03-21)" });
  assert.deepEqual(ok, { ok: true, problems: [] });
});

test("names every tool that is too old", () => {
  const bad = checkToolchain({ node: "v22.22.2", pnpm: "9.1.0", cargo: "cargo 1.80.0" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.map((p) => p.tool), ["node", "pnpm", "cargo"]);
});

test("the command line runs from a path with spaces and fails when pnpm and cargo are missing", () => {
  // The entry-point guard compared import.meta.url with `file://${argv[1]}`, which never matches a path with spaces
  // (percent-encoded in the URL) nor a Windows path: the script then did nothing and exited 0.
  const root = mkdtempSync(join(tmpdir(), "p1b-toolchain-"));
  try {
    const dir = join(root, "with space");
    mkdirSync(dir);
    copyFileSync(fileURLToPath(new URL("./check-toolchain.mjs", import.meta.url)), join(dir, "check-toolchain.mjs"));
    const empty = join(root, "empty-bin");
    mkdirSync(empty);
    const r = spawnSync(process.execPath, [join(dir, "check-toolchain.mjs")], { encoding: "utf8", env: { PATH: empty } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /toolchain: pnpm missing/);
    assert.match(r.stderr, /toolchain: cargo missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("Windows pnpm uses fixed cmd.exe invocation; native tools and Unix stay direct",()=>{
  assert.deepEqual(versionCommand("pnpm",{platform:"win32",systemRoot:"C:\\Windows"}),{file:"C:\\Windows\\System32\\cmd.exe",args:["/d","/s","/c","pnpm --version"]});
  assert.deepEqual(versionCommand("pnpm",{platform:"linux"}),{file:"pnpm",args:["--version"]});
  assert.deepEqual(versionCommand("cargo",{platform:"win32",systemRoot:"C:\\Windows"}),{file:"cargo",args:["--version"]});
  assert.deepEqual(versionCommand("node",{platform:"darwin"}),{file:process.execPath,args:["--version"]});
  for(const tool of ["pnpm & whoami","other","cargo --help"]){assert.throws(()=>versionCommand(tool,{platform:"win32",systemRoot:"C:\\Windows"}),/unsupported tool/);}
  assert.throws(()=>versionCommand("pnpm",{platform:"win32",systemRoot:"relative"}),/SystemRoot/);
});

test("version reader is injectable, bounded, and returns missing on execution failure",()=>{
 const calls=[];const env={PATH:"fixture"};
 assert.equal(readVersion("pnpm",{platform:"win32",systemRoot:"C:\\Windows",env,runner:(file,args,options)=>{calls.push({file,args,options});return "10.28.0\n";}}),"10.28.0");
 assert.equal(calls[0].file,"C:\\Windows\\System32\\cmd.exe");assert.deepEqual(calls[0].args,["/d","/s","/c","pnpm --version"]);
 assert.equal(calls[0].options.timeout,10000);assert.equal(calls[0].options.maxBuffer,65536);assert.equal(calls[0].options.encoding,"utf8");assert.equal(calls[0].options.env,env);assert.equal(calls[0].options.shell,undefined);
 assert.equal(readVersion("cargo",{runner:()=>{throw Error("missing");}}),"missing");
 let executed=false;assert.equal(readVersion("pnpm & whoami",{runner:()=>{executed=true;}}),"missing");assert.equal(executed,false);
});

test("Windows executes a real PATH pnpm.cmd shim",{skip:process.platform!=="win32"?"requires Windows cmd.exe and batch execution":false},()=>{
 const dir=mkdtempSync(join(tmpdir(),"p1b-pnpm-cmd-"));
 try{
  writeFileSync(join(dir,"pnpm.cmd"),"@echo off\r\necho 10.28.0\r\n");
  const env={...process.env,PATH:dir};
  assert.equal(readVersion("pnpm",{platform:"win32",systemRoot:process.env.SystemRoot,env}),"10.28.0");
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test("module import from a non-file stdin entry point does not execute or throw", () => {
  const source = `import {isMainModule} from ${JSON.stringify(new URL("./check-toolchain.mjs", import.meta.url).href)}; if(isMainModule('-'))process.exit(7); console.log('import-only');`;
  assert.equal(execFileSync(process.execPath,["--input-type=module","-"],{input:source,encoding:"utf8"}).trim(),"import-only");
});

// Exercise the Windows launch strategy on all runners; the command is fixed.
test("Windows pnpm uses cmd while native tools execute directly", () => {
  const calls = [];
  const run = (...args) => { calls.push(args); return "10.28.0\r\n"; };
  assert.equal(version("pnpm", ["--version"], { platform: "win32", run }), "10.28.0");
  assert.deepEqual(calls[0], [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "pnpm --version"], { encoding: "utf8" }]);
  version("cargo", ["--version"], { platform: "win32", run });
  assert.deepEqual(calls[1], ["cargo", ["--version"], { encoding: "utf8" }]);
  version("pnpm", ["--version"], { platform: "darwin", run });
  assert.deepEqual(calls[2], ["pnpm", ["--version"], { encoding: "utf8" }]);
  assert.equal(version("pnpm", ["--version"], { platform: "win32", run: () => { throw new Error("missing"); } }), "missing");
});

test("installed pnpm is discoverable through the real launcher", () => {
  assert.match(version("pnpm", ["--version"]), /^\d+\.\d+\.\d+/);
});
