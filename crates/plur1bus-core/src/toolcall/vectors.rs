//! Replays `fixtures/parity/toolcall/*.json` (mode V, `scripts/parity/export-toolcall.ts`). An answer is the text
//! TypeScript's `JSON.stringify` gave for what the function returned, so member order and number printing are compared
//! with it; a long answer is its hash and length. The fixtures are read with `serde_json`, not with the reader under test.
use super::dialects::{
    compile_catalogue, compile_dialect, from_registered_tool, restore_strict_arguments,
    CompileOptions, ToolDefinition,
};
use super::json::{parse_units, JsStr, Parsed, MAX_PARSE_DEPTH, V};
use super::quirks::{lookup_quirks, QUIRKS};
use super::validation::{
    assert_schema, prepare_call, validate_arguments, PortFailed, RepairPort, RepairRequest, Thrown,
};
use plur1bus_log_schema::redact::forms::secret_forms_in;
use plur1bus_log_schema::redact::matcher::SecretMatcher;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(super) fn fixture(name: &str) -> Value {
    let text = match name {
        "json" => include_str!("../../../../fixtures/parity/toolcall/json.json"),
        "arguments" => include_str!("../../../../fixtures/parity/toolcall/arguments.json"),
        "validation" => include_str!("../../../../fixtures/parity/toolcall/validation.json"),
        "dialects" => include_str!("../../../../fixtures/parity/toolcall/dialects.json"),
        "tables" => include_str!("../../../../fixtures/parity/toolcall/tables.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

/// A string of the fixture: plain, `{ "$u16": "<hex units>" }`, `{ gen: [prefix, fill, count, suffix] }` or
/// `{ parts: [...] }`.
pub(super) fn js(v: &Value) -> JsStr {
    if let Some(s) = v.as_str() {
        return JsStr::from(s);
    }
    if let Some(hex) = v.get("$u16").and_then(Value::as_str) {
        let units = hex
            .as_bytes()
            .chunks(4)
            .map(|c| u16::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap())
            .collect();
        return JsStr::new(units);
    }
    if let Some(g) = v.get("gen").and_then(Value::as_array) {
        let n = usize::try_from(g[2].as_u64().unwrap()).unwrap();
        let text = format!(
            "{}{}{}",
            g[0].as_str().unwrap(),
            g[1].as_str().unwrap().repeat(n),
            g[3].as_str().unwrap()
        );
        return JsStr::from(text);
    }
    if let Some(p) = v.get("parts").and_then(Value::as_array) {
        return JsStr::from(p.iter().map(|x| x.as_str().unwrap()).collect::<String>());
    }
    panic!("not a string spec: {v}")
}

/// JSON text of the fixture as a value (the exporter parsed the same text).
pub(super) fn value_of(text: &str) -> V {
    let units: Vec<u16> = text.encode_utf16().collect();
    match parse_units(&units) {
        Ok(Parsed::Value(v)) => v,
        other => panic!("fixture value does not parse: {other:?} {text}"),
    }
}

/// A raw input: text (a string value), `{ value: "<json>" }` (already parsed) or `{ undefined: true }`.
pub(super) fn raw_of(v: &Value) -> Option<V> {
    if v.get("undefined").is_some() {
        return None;
    }
    if let Some(text) = v.get("value").and_then(Value::as_str) {
        return Some(value_of(text));
    }
    Some(V::Str(js(v)))
}

pub(super) fn hash16(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares what Rust produced with a recorded answer: the text, `{ h, n }`, or `{ throws: { name, message? } }`.
pub(super) fn expect(case: &str, want: &Value, got: Result<String, Thrown>) {
    match (want.get("throws"), got) {
        (Some(t), Err(e)) => {
            assert_eq!(t["name"].as_str(), Some(e.name), "{case}: {e:?}");
            if let Some(m) = t.get("message") {
                assert_eq!(m.as_str(), Some(e.message.as_str()), "{case}");
            }
        }
        (Some(t), Ok(text)) => panic!("{case}: TypeScript throws {t}, Rust answers {text}"),
        (None, Err(e)) => panic!("{case}: Rust refuses ({e:?}), TypeScript answers {want}"),
        (None, Ok(text)) => match want.get("h") {
            Some(h) => {
                let n = text.encode_utf16().count() as u64;
                assert!(
                    h.as_str() == Some(hash16(&text).as_str()) && want["n"].as_u64() == Some(n),
                    "{case}: hash differs; Rust has {text}"
                );
            }
            None => assert_eq!(js(want).lossy(), text, "{case}"),
        },
    }
}

fn parse_text(units: &[u16]) -> Result<String, Thrown> {
    match parse_units(units) {
        Ok(Parsed::Value(v)) => Ok(v.stringify()),
        Ok(Parsed::TooDeep { .. }) => panic!("unexpectedly deep"),
        Err(_) => Err(Thrown::syntax()),
    }
}

#[test]
fn json_parse_and_stringify() {
    let f = fixture("json");
    for c in f["cases"].as_array().unwrap() {
        let text = js(&c["text"]);
        expect(&format!("{text:?}"), &c["out"], parse_text(text.units()));
    }
    for c in f["generated"].as_array().unwrap() {
        let text = js(&c[0]);
        expect(&format!("{text:?}"), &c[1], parse_text(text.units()));
    }
    // Depth: TypeScript parses all of these or none; above the cap Rust says "well-formed but too deep" instead of a value.
    for c in f["deep"].as_array().unwrap() {
        let text = js(c);
        let depth = usize::try_from(c["depth"].as_u64().unwrap()).unwrap();
        let got = parse_units(text.units());
        match (c["ok"].as_bool().unwrap(), got) {
            (false, Err(_)) => {}
            (true, Ok(Parsed::Value(_))) => assert!(depth <= MAX_PARSE_DEPTH, "depth {depth}"),
            (true, Ok(Parsed::TooDeep { array })) => {
                assert!(depth > MAX_PARSE_DEPTH, "depth {depth}");
                assert_eq!(array, text.units()[0] == u16::from(b'['));
            }
            (ok, got) => panic!("depth {depth}: TypeScript ok={ok}, Rust {got:?}"),
        }
    }
}

struct Script<'a> {
    answers: &'a [Value],
    next: usize,
    asked: Vec<String>,
}

impl RepairPort for Script<'_> {
    fn repair(&mut self, request: &RepairRequest) -> Result<Option<V>, PortFailed> {
        self.asked.push(request.to_v().stringify());
        let answer = &self.answers[self.next];
        self.next += 1;
        if answer.get("throw").is_some() {
            return Err(PortFailed);
        }
        Ok(raw_of(answer))
    }
}

#[test]
fn prepare_call_named_cases() {
    let f = fixture("arguments");
    let fuzz_schema = value_of(f["schemas"][0].as_str().unwrap());
    for c in f["named"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let schema = c["schema"]
            .as_str()
            .map_or_else(|| fuzz_schema.clone(), value_of);
        let raw = raw_of(&c["raw"]);
        let mut script = c.get("repairs").map(|r| Script {
            answers: r.as_array().unwrap(),
            next: 0,
            asked: Vec::new(),
        });
        let matcher = c.get("secrets").map(|s| {
            let secrets: Vec<String> = s
                .as_array()
                .unwrap()
                .iter()
                .map(|p| js(p).lossy())
                .collect();
            let forms = secret_forms_in(secrets.iter().map(String::as_str));
            Arc::new(SecretMatcher::from_strs(forms.iter().map(String::as_str)))
        });
        let known = matcher.as_ref().map(|m| move || Ok(Arc::clone(m)));
        let got = prepare_call(
            c["tool"].as_str().unwrap(),
            &schema,
            raw.as_ref(),
            script.as_mut().map(|s| s as &mut dyn RepairPort),
            c.get("family").and_then(Value::as_str),
            known
                .as_ref()
                .map(|k| k as &dyn Fn() -> Result<Arc<SecretMatcher>, PortFailed>),
        );
        expect(name, &c["out"], got.map(|p| p.to_v().stringify()));
        if let Some(script) = script {
            // Above the reader's depth cap the port is handed the raw text, not a value (recorded as `askedAbove512`).
            let asked = c.get("askedAbove512").unwrap_or(&c["asked"]);
            let asked: Vec<String> = asked
                .as_array()
                .unwrap()
                .iter()
                .map(|a| js(a).lossy())
                .collect();
            assert_eq!(
                asked, script.asked,
                "{name}: what the repair port was asked"
            );
        }
    }
}

#[test]
fn prepare_call_hostile_corpus() {
    let f = fixture("arguments");
    let schemas: Vec<V> = f["schemas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| value_of(s.as_str().unwrap()))
        .collect();
    let families: Vec<&str> = f["families"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    let cases = f["fuzz"]["cases"].as_array().unwrap();
    assert!(cases.len() >= 2000);
    for (i, c) in cases.iter().enumerate() {
        let raw = raw_of(&c[0]);
        let schema = &schemas[usize::try_from(c[1].as_u64().unwrap()).unwrap()];
        let family = families[usize::try_from(c[2].as_u64().unwrap()).unwrap()];
        let got = prepare_call("t", schema, raw.as_ref(), None, Some(family), None);
        let shown = raw.as_ref().map(V::stringify).unwrap_or_default();
        expect(
            &format!("fuzz #{i} ({family}) {shown}"),
            &c[3],
            got.map(|p| p.to_v().stringify()),
        );
    }
}

fn issues_text(schema: &str, value: &str) -> Result<String, Thrown> {
    let issues = validate_arguments(&value_of(schema), Some(&value_of(value)), None)?;
    Ok(V::Arr(issues.iter().map(|i| i.to_v()).collect()).stringify())
}

#[test]
fn assert_schema_grid() {
    let f = fixture("validation");
    for c in f["assert"].as_array().unwrap() {
        let text = c[0].as_str().unwrap();
        let got = assert_schema(&value_of(text));
        match (&c[1], got) {
            (Value::Null, Ok(())) => {}
            (Value::Null, Err(e)) => {
                panic!("{text}: Rust refuses a schema TypeScript accepts: {e:?}")
            }
            (want, Ok(())) => panic!("{text}: Rust accepts a schema TypeScript refuses: {want}"),
            (want, Err(e)) => {
                assert_eq!(want["name"].as_str(), Some(e.name), "{text}");
                if let Some(m) = want.get("message") {
                    assert_eq!(m.as_str(), Some(e.message.as_str()), "{text}");
                }
            }
        }
    }
}

#[test]
fn validate_arguments_grid_and_generated() {
    let f = fixture("validation");
    for key in ["validate", "generated"] {
        for (i, c) in f[key].as_array().unwrap().iter().enumerate() {
            let (schema, value) = (c[0].as_str().unwrap(), c[1].as_str().unwrap());
            expect(
                &format!("{key} #{i}: {schema} over {value}"),
                &c[2],
                issues_text(schema, value),
            );
        }
    }
}

fn tool_of(t: &Value) -> ToolDefinition {
    ToolDefinition {
        name: t["name"].as_str().unwrap().to_owned(),
        description: t.get("description").map(|d| d.as_str().unwrap().to_owned()),
        parameters: t.get("parameters").map(|p| value_of(p.as_str().unwrap())),
    }
}

fn options_of(o: Option<&Value>) -> (Option<bool>, Option<String>) {
    let o = o.filter(|o| !o.is_null());
    (
        o.and_then(|o| o.get("strict")).and_then(Value::as_bool),
        o.and_then(|o| o.get("modelFamily"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    )
}

#[test]
fn compile_dialect_cases() {
    let f = fixture("dialects");
    for c in f["compile"].as_array().unwrap() {
        let (strict, model_family) = options_of(c.get("options"));
        let options = CompileOptions {
            strict,
            model_family: model_family.as_deref(),
        };
        let got = compile_dialect(
            &tool_of(&c["tool"]),
            c["family"].as_str().unwrap(),
            &options,
        );
        expect(
            c["name"].as_str().unwrap(),
            &c["out"],
            got.map(|d| d.to_v().stringify()),
        );
    }
    for (i, c) in f["generated"].as_array().unwrap().iter().enumerate() {
        let (strict, model_family) = options_of(Some(&c[2]));
        let options = CompileOptions {
            strict,
            model_family: model_family.as_deref(),
        };
        let tool = ToolDefinition {
            name: "t".to_owned(),
            description: Some("d".to_owned()),
            parameters: Some(value_of(c[0].as_str().unwrap())),
        };
        let got = compile_dialect(&tool, c[1].as_str().unwrap(), &options);
        expect(
            &format!("generated #{i}: {} for {} {}", c[0], c[1], c[2]),
            &c[3],
            got.map(|d| d.to_v().stringify()),
        );
    }
}

#[test]
fn compile_catalogue_and_restore() {
    let f = fixture("dialects");
    for c in f["catalogue"].as_array().unwrap() {
        let names: Vec<String> = match c.get("names") {
            Some(n) => n
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect(),
            None => (0..c["count"].as_u64().unwrap())
                .map(|i| format!("t{i}"))
                .collect(),
        };
        let tools: Vec<ToolDefinition> = names
            .iter()
            .map(|name| ToolDefinition {
                name: name.clone(),
                description: Some("d".to_owned()),
                parameters: Some(value_of(
                    r#"{"type":"object","properties":{},"additionalProperties":false}"#,
                )),
            })
            .collect();
        let got = compile_catalogue(
            &tools,
            c["family"].as_str().unwrap(),
            c.get("modelFamily").and_then(Value::as_str),
        );
        expect(
            c["name"].as_str().unwrap(),
            &c["out"],
            got.map(|l| V::Arr(l.iter().map(|d| d.to_v()).collect()).stringify()),
        );
    }
    for c in f["restore"].as_array().unwrap() {
        let (schema, value) = (c[0].as_str().unwrap(), c[1].as_str().unwrap());
        let got = restore_strict_arguments(&value_of(schema), &value_of(value));
        expect(
            &format!("restore {schema} {value}"),
            &c[2],
            Ok(got.stringify()),
        );
    }
    let tool = from_registered_tool("n", "d", &value_of(r#"{"type":"object"}"#));
    assert_eq!(f["registered"].as_str().unwrap(), tool.to_v().stringify());
}

#[test]
fn quirks_table_and_lookup() {
    let f = fixture("tables");
    let table = f["quirks"].as_array().unwrap();
    assert_eq!(
        table.len(),
        QUIRKS.len(),
        "the two tables have the same rows"
    );
    for (row, (name, quirks)) in table.iter().zip(QUIRKS) {
        assert_eq!(row[0].as_str(), Some(*name));
        assert_eq!(
            row[1].as_str().unwrap(),
            quirks.to_v().stringify(),
            "{name}"
        );
    }
    for c in f["lookups"].as_array().unwrap() {
        let got = lookup_quirks(c[0].as_str().unwrap(), c[1].as_str());
        assert_eq!(
            c[2].as_str().unwrap(),
            got.to_v().stringify(),
            "{} {}",
            c[0],
            c[1]
        );
    }
}
