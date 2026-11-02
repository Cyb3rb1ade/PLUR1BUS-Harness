// SPDX-License-Identifier: MIT
/** Generate input-only language bridges. No seed, expected output, oracle path or reference enters a bridge. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function selection(task, scope, tag, image) {
  const last = scope === "e2e" ? task.packages.length - 1 : task.packages.findIndex((item) => item.id === scope);
  if (last < 0) throw new Error("unknown checker scope");
  const packages =
    task.kind === "coupled" || scope === "e2e" ? task.packages.slice(0, last + 1) : [task.packages[last]];
  const entries = [...new Set(packages.map((item) => item.entry.replaceAll("__SEED__", tag)))];
  return { packages, entries, last, image, task, tag };
}

function nodeSource(meta) {
  const imports = meta.packages.map(
    (item) =>
      `const ${item.id.replaceAll("-", "_")} = await import(${JSON.stringify(
        pathToFileURL(join(meta.image, item.entry.replaceAll("__SEED__", meta.tag))).href,
      )});`,
  );
  const contractUrl = pathToFileURL(join(meta.image, `src/contracts.${meta.tag}.ts`)).href;
  const functions = meta.packages.map(
    (item) => `${item.id.replaceAll("-", "_")}[${JSON.stringify(item.symbol.replaceAll("__SEED__", meta.tag))}]`,
  );
  return [
    "import { readFileSync } from \"node:fs\";",
    ...imports,
    `const steps = [${functions.join(",")}];`,
    `const coupled = ${meta.task.kind === "coupled"};`,
    `const final = ${meta.last === meta.task.packages.length - 1};`,
    ...(meta.task.kind === "coupled" ? [`import { packet } from ${JSON.stringify(contractUrl)};`] : []),
    "let value = readFileSync(0, \"utf8\");",
    "const direct = process.argv[2] === \"direct\";",
    ...(meta.task.kind === "coupled"
      ? [
          "if (direct && steps.length > 1) value = packet(value, steps.length - 1);",
          "if (direct && steps.length > 1 && process.argv[3] === \"stale\") value.stage++;",
          "if (direct && steps.length > 1 && process.argv[3] === \"corrupt\") value.stamp++;",
        ]
      : []),
    "for (const step of direct ? steps.slice(-1) : steps) value = await step(value);",
    "if (coupled && !final) value = value.payload;",
    "if (typeof value !== \"string\") throw Error(\"expected string\");",
    "process.stdout.write(value);",
  ].join("\n");
}

function pythonSource(meta) {
  const paths = meta.packages.map((item) => join(meta.image, item.entry.replaceAll("__SEED__", meta.tag)));
  const symbols = meta.packages.map((item) => item.symbol.replaceAll("__SEED__", meta.tag));
  return [
    "import importlib.util",
    "import json",
    "import pathlib",
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(join(meta.image, "src"))})`,
    `paths = json.loads(${JSON.stringify(JSON.stringify(paths))})`,
    `symbols = json.loads(${JSON.stringify(JSON.stringify(symbols))})`,
    "steps = []",
    "for index, path in enumerate(paths):",
    "    sys.path.insert(0, str(pathlib.Path(path).parent))",
    "    spec = importlib.util.spec_from_file_location('candidate_' + str(index), path)",
    "    module = importlib.util.module_from_spec(spec)",
    "    sys.modules[spec.name] = module",
    "    spec.loader.exec_module(module)",
    "    steps.append(getattr(module, symbols[index]))",
    "value = sys.stdin.buffer.read().decode('utf8')",
    "direct = sys.argv[1] == 'direct'",
    ...(meta.task.kind === "coupled"
      ? [
          `from contracts${meta.tag} import Packet, packet`,
          "if direct and len(steps) > 1:",
          "    value = packet(value, len(steps) - 1)",
          "    if sys.argv[2] == 'stale':",
          "        value = Packet(value.payload, value.stage + 1, value.stamp)",
          "    if sys.argv[2] == 'corrupt':",
          "        value = Packet(value.payload, value.stage, value.stamp + 1)",
        ]
      : []),
    "for step in steps[-1:] if direct else steps:",
    "    value = step(value)",
    ...(meta.task.kind === "coupled" && meta.last < meta.task.packages.length - 1 ? ["value = value.payload"] : []),
    "if not isinstance(value, str):",
    "    raise TypeError('expected string')",
    "sys.stdout.write(value)",
  ].join("\n");
}

function rustSource(meta) {
  const modules = meta.entries.map(
    (entry, index) => `#[path = ${JSON.stringify(join(meta.image, entry))}] mod p${index};`,
  );
  const calls = meta.packages.map((item) => {
    const index = meta.entries.indexOf(item.entry.replaceAll("__SEED__", meta.tag));
    return `p${index}::${item.symbol.replaceAll("__SEED__", meta.tag)}`;
  });
  const directInput = meta.task.kind === "coupled" && meta.packages.length > 1 ? "&state" : "&raw";
  const prefix = calls.map((call, index) => `let value = ${call}(${index ? "&value" : "&raw"});`);
  const unwrap = meta.task.kind === "coupled" && meta.last < meta.task.packages.length - 1 ? ".payload" : "";
  return [
    "#![allow(dead_code)]",
    "use std::io::Read;",
    `#[path = ${JSON.stringify(join(meta.image, `src/contracts.${meta.tag}.rs`))}] mod contract;`,
    ...modules,
    "fn main() {",
    "let mut raw = String::new();",
    "std::io::stdin().read_to_string(&mut raw).unwrap();",
    "let direct = std::env::args().nth(1).as_deref() == Some(\"direct\");",
    ...(meta.task.kind === "coupled" && meta.packages.length > 1
      ? [
          `let mut state = contract::packet(raw.clone(), ${meta.packages.length - 1});`,
          "if std::env::args().nth(2).as_deref() == Some(\"stale\") { state.stage += 1; }",
          "if std::env::args().nth(2).as_deref() == Some(\"corrupt\") { state.stamp += 1; }",
        ]
      : []),
    `let result = if direct { ${calls.at(-1)}(${directInput})${unwrap} } else {`,
    ...prefix,
    `value${unwrap} };`,
    "print!(\"{}\", result);",
    "}",
  ].join("\n");
}

function goSource(meta) {
  const modules = meta.entries.map(
    (entry, index) => `p${index} "fixture.local/task/${dirname(entry).replaceAll("\\", "/")}"`,
  );
  const calls = meta.packages.map((item) => {
    const index = meta.entries.indexOf(item.entry.replaceAll("__SEED__", meta.tag));
    return `p${index}.${item.symbol.replaceAll("__SEED__", meta.tag)}`;
  });
  const coupled = meta.task.kind === "coupled";
  const directInput = coupled && meta.packages.length > 1 ? "state" : "raw";
  const unwrap = coupled && meta.last < meta.task.packages.length - 1 ? ".Payload" : "";
  const prefix = calls.map((call, index) => `value${index} := ${call}(${index ? `value${index - 1}` : "raw"})`);
  return [
    "package main",
    "import (\"fmt\"; \"os\"; \"io\";",
    ...(coupled && meta.packages.length > 1 ? [`contract "fixture.local/task/src/contracts${meta.tag}"`] : []),
    ...modules,
    ")",
    "func main() {",
    "bytes, err := io.ReadAll(os.Stdin)",
    "if err != nil { panic(err) }",
    "raw := string(bytes)",
    "if len(os.Args) > 1 && os.Args[1] == \"direct\" {",
    ...(coupled && meta.packages.length > 1
      ? [
          `state := contract.PacketOf(raw, ${meta.packages.length - 1})`,
          "if len(os.Args) > 2 && os.Args[2] == \"stale\" { state.Stage++ }",
          "if len(os.Args) > 2 && os.Args[2] == \"corrupt\" { state.Stamp++ }",
        ]
      : []),
    `fmt.Print(${calls.at(-1)}(${directInput})${unwrap})`,
    "return",
    "}",
    ...prefix,
    `fmt.Print(value${calls.length - 1}${unwrap})`,
    "}",
  ].join("\n");
}

/** Prepare one scope; isolated packages import no sibling code, coupled scopes include their actual predecessors. */
export async function prepareProbe(task, image, tag, scope, root, runtime, execute) {
  const meta = selection(task, scope, tag, image);
  const directory = join(root, `probe-${scope}`);
  await mkdir(directory);
  const extension = { typescript: "mjs", python: "py", rust: "rs", go: "go" }[task.language];
  const source = join(directory, `main.${extension}`);
  const generators = { typescript: nodeSource, python: pythonSource, rust: rustSource, go: goSource };
  await writeFile(source, generators[task.language](meta));
  let program = runtime.program;
  let args;
  if (task.language === "typescript") {
    args = ["--experimental-transform-types", "--no-warnings=ExperimentalWarning", source];
  } else if (task.language === "python") {
    args = ["-I", "-S", "-B", "-X", "utf8", source];
  } else {
    program = join(directory, "probe");
    const build =
      task.language === "rust"
        ? ["--edition=2024", "--crate-name", "team_probe", source, "-o", program]
        : ["build", "-o", program, source];
    const result = await execute({ ...runtime, args: build, cwd: image });
    if (result.code !== 0 || result.reason) throw new Error("candidate-error");
    args = [];
  }
  return {
    async invoke(input, prefix, state = "normal") {
      const result = await execute({
        program,
        args: [...args, prefix ? "prefix" : "direct", state],
        cwd: image,
        env: runtime.env,
        stdin: input,
        digestOutput: true,
        maxOutputBytes: 1024 * 1024,
      });
      if (result.code !== 0 || result.reason) throw new Error(result.reason ?? "candidate-error");
      return result.stdout;
    },
  };
}
