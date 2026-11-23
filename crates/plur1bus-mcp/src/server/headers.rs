use std::collections::HashSet;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{Map, Value};
use ureq::http::{HeaderMap, HeaderName};

use super::Error;

#[derive(Clone, Copy)]
enum Kind {
    String,
    Integer,
    Boolean,
}

pub(super) struct Rule {
    header: HeaderName,
    keys: Vec<String>,
    kind: Kind,
}

pub(super) fn rules(schema: &Map<String, Value>) -> Result<Vec<Rule>, Error> {
    let mut seen = HashSet::new();
    let mut rules = Vec::new();
    let mut nodes = 1;
    visit(
        schema,
        &mut Vec::new(),
        true,
        0,
        &mut nodes,
        &mut seen,
        &mut rules,
    )?;
    Ok(rules)
}

fn visit(
    value: &Map<String, Value>,
    path: &mut Vec<String>,
    reachable: bool,
    depth: usize,
    nodes: &mut usize,
    seen: &mut HashSet<HeaderName>,
    rules: &mut Vec<Rule>,
) -> Result<(), Error> {
    if let Some(annotation) = value.get("x-mcp-header") {
        let name = annotation
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or(Error::Invalid)?;
        let header = HeaderName::from_bytes(format!("mcp-param-{name}").as_bytes())
            .map_err(|_| Error::Invalid)?;
        if !reachable || path.is_empty() || !seen.insert(header.clone()) {
            return Err(Error::Invalid);
        }
        let kind = match value.get("type").and_then(Value::as_str) {
            Some("string") => Kind::String,
            Some("integer") => Kind::Integer,
            Some("boolean") => Kind::Boolean,
            _ => return Err(Error::Invalid),
        };
        rules.push(Rule {
            header,
            keys: path.clone(),
            kind,
        });
    }
    for (key, item) in value {
        if key == "properties" {
            if let Some(properties) = item.as_object() {
                for (name, subschema) in properties {
                    path.push(name.clone());
                    descend(subschema, path, reachable, depth + 1, nodes, seen, rules)?;
                    path.pop();
                }
                continue;
            }
        }
        descend(item, path, false, depth + 1, nodes, seen, rules)?;
    }
    Ok(())
}

fn descend(
    value: &Value,
    path: &mut Vec<String>,
    reachable: bool,
    depth: usize,
    nodes: &mut usize,
    seen: &mut HashSet<HeaderName>,
    rules: &mut Vec<Rule>,
) -> Result<(), Error> {
    *nodes += 1;
    if *nodes > 4096 || depth > 32 {
        return Err(Error::Invalid);
    }
    match value {
        Value::Object(value) => visit(value, path, reachable, depth, nodes, seen, rules),
        Value::Array(items) => {
            for item in items {
                descend(item, path, false, depth + 1, nodes, seen, rules)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub(super) fn single<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let values = headers.get_all(name);
    let mut parts = values.iter();
    let value = parts.next()?.to_str().ok()?;
    parts.next().is_none().then_some(value)
}

pub(super) fn encode(value: &str) -> String {
    if value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        && value.trim() == value
        && !(value.starts_with("=?base64?") && value.ends_with("?="))
    {
        value.to_owned()
    } else {
        format!("=?base64?{}?=", STANDARD.encode(value))
    }
}

pub(super) fn valid(rules: &[Rule], args: &Map<String, Value>, headers: &HeaderMap) -> bool {
    let mut matched = 0;
    for rule in rules {
        let Some((first, rest)) = rule.keys.split_first() else {
            return false;
        };
        let value = rest.iter().fold(args.get(first), |value, part| {
            value.and_then(|value| value.get(part))
        });
        let Some(value) = value.filter(|value| !value.is_null()) else {
            continue;
        };
        let text = match rule.kind {
            Kind::String => value.as_str().map(ToOwned::to_owned),
            Kind::Boolean => value.as_bool().map(|value| value.to_string()),
            Kind::Integer => value
                .as_f64()
                .filter(|value| value.abs() <= 9_007_199_254_740_991.0 && value.fract() == 0.0)
                .map(|number| {
                    if number == 0.0 {
                        "0".into()
                    } else {
                        format!("{number:.0}")
                    }
                }),
        };
        let Some(text) = text else {
            return false;
        };
        if single(headers, rule.header.as_str()) != Some(encode(&text).as_str()) {
            return false;
        }
        matched += 1;
    }
    headers
        .keys()
        .filter(|key| key.as_str().starts_with("mcp-param-"))
        .count()
        == matched
}
