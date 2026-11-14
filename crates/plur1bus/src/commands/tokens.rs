//! Read-only CLI access to the running native token counter.
use super::{connect_recorded, read_token_of};
use crate::{cli::TokensCmd, output::Out, paths::Layout};
use plur1bus_rpc::{ConnectOptions, Endpoint};
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

const LIMIT: u64 = 4 * 1024 * 1024;

fn read_request(path: &Path) -> Result<Value, &'static str> {
    let input: Box<dyn Read> = if path == Path::new("-") {
        Box::new(io::stdin().lock())
    } else {
        Box::new(File::open(path).map_err(|_| "cannot open the token-count request")?)
    };
    let mut bytes = Vec::new();
    input
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read the token-count request")?;
    if bytes.len() as u64 > LIMIT {
        return Err("token-count request exceeds 4 MiB");
    }
    serde_json::from_slice(&bytes).map_err(|_| "token-count request is not valid JSON")
}

fn render(method: &str, result: &Value) -> String {
    if method == "engine.tokens.families" {
        return result
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| {
                format!(
                    "{}\t{}\t{}",
                    row["family"].as_str().unwrap_or("?"),
                    row["method"].as_str().unwrap_or("?"),
                    row["artifactState"].as_str().unwrap_or("?")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    let mut rows = vec![format!(
        "{} ({})",
        result["family"].as_str().unwrap_or("?"),
        result["method"].as_str().unwrap_or("?")
    )];
    rows.extend(result["items"].as_array().into_iter().flatten().map(|row| {
        format!(
            "{}\t{} tokens ({}–{})",
            row["id"].as_str().unwrap_or("?"),
            row["tokens"],
            row["lower"],
            row["upper"]
        )
    }));
    rows.join("\n")
}

pub fn run(out: &Out, layout: &Layout, cmd: TokensCmd) {
    let (method, params, schema) = match cmd {
        TokensCmd::Families => ("engine.tokens.families", json!({}), "tokens.families/1"),
        TokensCmd::Count { request } => match read_request(&request) {
            Ok(params) => ("engine.tokens.count", params, "tokens.count/1"),
            Err(error) => out.fail("E_INVALID_PARAMS", error, json!({})),
        },
    };
    let endpoint = Endpoint::Engine;
    let Some(token) = read_token_of(layout, endpoint) else {
        out.fail(
            "E_NOT_AVAILABLE",
            "the Rust engine is not running",
            json!({ "reason": "engine-unavailable" }),
        );
    };
    let address = crate::paths::engine_address(&layout.home, std::env::consts::OS);
    let options = ConnectOptions {
        endpoint,
        ..ConnectOptions::default()
    };
    let mut client = match connect_recorded(layout, &address, &token, options) {
        Ok(client) => client,
        Err(error) => out.from_rpc_error(&error),
    };
    if !client.supports(method) {
        out.fail(
            "E_NOT_AVAILABLE",
            "the running engine does not support this token method",
            json!({ "reason": "engine-lacks-method", "method": method }),
        );
    }
    match client.call(method, params) {
        Ok(result) => out.ok(schema, &result, || render(method, &result)),
        Err(error) => out.from_rpc_error(&error),
    }
}
