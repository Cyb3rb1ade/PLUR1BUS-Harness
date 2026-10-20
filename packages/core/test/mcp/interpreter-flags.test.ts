// The table of interpreter flags that run inline code (audit mcp #2, note on the allowlist). Pure: no process is started.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inlineCodeFlag, interpreterFamily } from "../../src/mcp/interpreter-flags.ts";

describe("interpreter family", () => {
  it("recognises an interpreter by its file name, whatever the path, case, version or extension", () => {
    for (const [cmd, family] of [["node", "node"], ["nodejs", "node"], ["/usr/local/bin/node", "node"], ["C:\\Program Files\\nodejs\\node.exe", "node"], ["NODE.EXE", "node"],
      ["python3", "python"], ["python3.12", "python"], ["/usr/bin/python", "python"], ["pypy3", "python"], ["bash", "shell"], ["/bin/sh", "shell"], ["zsh", "shell"], ["dash", "shell"],
      ["perl", "perl"], ["ruby3.2", "ruby"], ["php8.3", "php"], ["pwsh", "powershell"], ["powershell.exe", "powershell"], ["cmd.exe", "cmd"], ["deno", "deno"], ["bun", "node"], ["Rscript", "rscript"], ["npx", "npx"]] as const) {
      assert.equal(interpreterFamily(cmd), family, cmd);
    }
    for (const cmd of ["uvx", "/opt/tools/server", "my-node", "nodemon", "pythonista"]) assert.equal(interpreterFamily(cmd), null, cmd);
  });
});

describe("inline code flags", () => {
  const hit = (cmd: string, ...args: string[]) => inlineCodeFlag(cmd, args);
  it("finds the flag by name only, never returning the code", () => {
    assert.equal(hit("node", "-e", "CODE"), "-e");
    assert.equal(hit("node", "--eval=CODE"), "--eval");
    assert.equal(hit("python3", "-cCODE"), "-c");
    assert.equal(hit("python3", "-Ic", "CODE"), "-c");
    assert.equal(hit("node", "-pe", "CODE"), "-p");
    assert.equal(hit("deno", "eval", "CODE"), "eval");
  });
  it("covers the interpreters an operator is likely to allowlist", () => {
    for (const [cmd, args] of [
      ["bun", ["-e", "x"]], ["bun", ["--print", "x"]], ["sh", ["-c", "x"]], ["bash", ["-lc", "x"]], ["zsh", ["-xc", "x"]], ["dash", ["-c", "x"]], ["fish", ["--command", "x"]],
      ["perl", ["-e", "x"]], ["perl", ["-le", "x"]], ["perl", ["-Mstrict", "-E", "x"]], ["ruby", ["-e", "x"]], ["php", ["-r", "x"]], ["lua", ["-e", "x"]], ["Rscript", ["-e", "x"]],
      ["pwsh", ["-Command", "x"]], ["pwsh", ["-c", "x"]], ["powershell.exe", ["-EncodedCommand", "eA=="]], ["powershell", ["-NoProfile", "-enc", "eA=="]], ["powershell", ["-e", "eA=="]],
      ["powershell", ["Get-Process"]], ["cmd.exe", ["/c", "dir"]], ["cmd", ["/K", "dir"]], ["npx", ["-c", "x"]], ["npx", ["--call=x"]],
    ] as Array<[string, string[]]>) assert.notEqual(inlineCodeFlag(cmd, args), null, `${cmd} ${args.join(" ")}`);
  });
  it("leaves script, module and file launches alone, and ignores flags that belong to the script", () => {
    for (const [cmd, args] of [
      ["node", []], ["node", ["server.js", "-e", "x"]], ["node", ["--", "-e"]], ["node", ["--check", "server.js"]], ["node", ["-c", "server.js"]],
      ["python3", ["server.py", "-c", "x"]], ["python3", ["-m", "pkg", "-c", "x"]], ["python3", ["-X", "dev", "server.py", "-c", "x"]], ["python3", ["-W", "c", "server.py"]], ["python3", ["--", "-c"]],
      ["sh", ["run.sh", "-c", "x"]], ["bash", ["--rcfile", "rc", "run.sh", "-c"]], ["bash", ["-o", "errexit", "run.sh"]],
      ["perl", ["server.pl", "-e"]], ["perl", ["-Mfeature=say", "server.pl"]], ["perl", ["-I", "lib", "server.pl"]], ["ruby", ["server.rb", "-e"]], ["php", ["-f", "server.php"]],
      ["powershell", ["-NoProfile", "-File", "server.ps1", "-Command", "x"]], ["npx", ["@scope/server", "-c", "x"]], ["npx", ["-y", "@scope/server", "-c", "x"]], ["npx", ["-p", "pkg", "server", "-c", "x"]],
      ["/opt/tools/server", ["-e", "-c"]],
    ] as Array<[string, string[]]>) assert.equal(inlineCodeFlag(cmd, args), null, `${cmd} ${args.join(" ")}`);
  });
  it("is not fooled by an option placed before the inline flag", () => {
    assert.equal(hit("node", "--unknown-option", "value", "-e", "x"), "-e", "an unknown option may consume its value, so the scan goes on");
    assert.equal(hit("node", "-r", "./pre.js", "-e", "x"), "-e");
    assert.equal(hit("node", "--import", "x", "--eval", "x"), "--eval");
    assert.equal(hit("python3", "-B", "-u", "-c", "x"), "-c");
    assert.equal(hit("sh", "-e", "-c", "x"), "-c");
  });
});
