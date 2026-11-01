/** Original MIT invocation shims. They contain serialization only; expected cases stay in the coordinator. */
export function rustBridge(id, entry, symbol) {
  const quote = String.raw`
fn quoted(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""), '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"), '\r' => out.push_str("\\r"), '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 32 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"'); out
}
`;
  const prefix = `// Original MIT B1 invocation shim; no expected results.\n#[path = ${JSON.stringify(entry)}] mod subject;\n`;
  if (id === "easy-rust-window")
    return (
      prefix +
      quote +
      `
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let values: Vec<i64> = args[0].split(',').filter(|s| !s.is_empty()).map(|s| s.parse().unwrap()).collect();
    let result = subject::${symbol}(&values, args[1].parse().unwrap());
    println!("{{\\"value\\":[{}]}}", result.iter().map(|v| quoted(&v.to_string())).collect::<Vec<_>>().join(","));
}
`
    );
  if (id === "medium-rust-tokenizer")
    return (
      prefix +
      quote +
      `
fn main() {
    let input = std::env::args().nth(1).unwrap();
    match subject::${symbol}(&input) {
        Ok(values) => println!("{{\\"value\\":[{}]}}", values.iter().map(|v| quoted(v)).collect::<Vec<_>>().join(",")),
        Err(_) => println!("{{\\"error\\":true}}"),
    }
}
`
    );
  if (id === "hard-rust-intervals")
    return (
      prefix +
      quote +
      `
fn main() {
    let input = std::env::args().nth(1).unwrap();
    let pairs: Vec<(i64,i64)> = input.split(';').filter(|s| !s.is_empty()).map(|s| {
        let parts: Vec<_> = s.split(',').collect(); (parts[0].parse().unwrap(), parts[1].parse().unwrap())
    }).collect();
    let result = subject::${symbol}(&pairs);
    println!("{{\\"value\\":[{}]}}", result.iter().map(|(a,b)| format!("[{},{}]", quoted(&a.to_string()), quoted(&b.to_string()))).collect::<Vec<_>>().join(","));
}
`
    );
  throw new Error("unsupported Rust bridge");
}
