//! Replay of the parity vectors recorded from the TypeScript exposure resolution, the sensitivity scanner and the local-only
//! rules (`scripts/parity/export-exposure.ts`, `fixtures/parity/exposure/*.json`). Vectors are recorded, never edited by hand.
//! A file is `{fields, tables, cases}`; a case line is `[name TAB] refs TAB expected`, `refs` one table index per field joined by
//! "." ("-" for an absent argument). The three `resolve-*` files and `switches` store dimensions, not objects: the builders
//! below mirror `mkPrincipal` / `exposureConfig` of the exporter. A failing file reports how many cases differ and the first
//! few by their dimensions.
use super::config::channel_switches;
use super::resolve::{read_rights, resolve_exposure};
use super::scanner::{
    compute_content_hash_units, matches_keywords, matches_token, SensitivityScanner, CARD_PATTERN,
    FINANCIAL, HEALTH, IBAN_PATTERN, IDENTITY, PERSONAL,
};
use super::sensitivity::{filter_sensitive_blocks, sensitivity_refusal, Block, SensitivityService};
use super::types::{
    ChannelSwitches, Disclose, Exposure, ExposureChannel, ExposurePrincipal, MemoryOverride,
    RecallOverride, ScopeAccess, TokenBinding,
};
use crate::config::policy::{is_local_chat_model, is_local_model, local_only_for};
use crate::config::privacy_doctor::{local_only_check, local_only_findings};
use crate::rbac::types::{AgentRight, Principal, PrincipalKind, Role};
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::collections::HashMap;

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/exposure/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// One case: the decoded cells (absent argument: no entry), the expected text and a name (recorded, or rebuilt).
struct Row {
    name: String,
    cells: HashMap<String, Value>,
    expected: String,
}

impl Row {
    fn cell(&self, field: &str) -> Option<&Value> {
        self.cells.get(field)
    }
    fn str(&self, field: &str) -> &str {
        self.cell(field)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{}: no string {field}", self.name))
    }
}

fn rows(file: &Value) -> Vec<Row> {
    let fields: Vec<&str> = file["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    file["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| {
            let parts: Vec<&str> = line.as_str().unwrap().split('\t').collect();
            let (name, refs, expected) = match parts.as_slice() {
                [n, r, e] => (Some((*n).to_owned()), *r, *e),
                [r, e] => (None, *r, *e),
                other => panic!("bad case line {other:?}"),
            };
            let mut cells: HashMap<String, Value> = HashMap::new();
            for (field, r) in fields.iter().zip(refs.split('.')) {
                if r == "-" {
                    continue;
                }
                let text = file["tables"][field][r.parse::<usize>().unwrap()]
                    .as_str()
                    .unwrap();
                cells.insert((*field).to_owned(), serde_json::from_str(text).unwrap());
            }
            let name = name.unwrap_or_else(|| {
                fields
                    .iter()
                    .map(|f| {
                        cells.get(*f).map_or("-".to_owned(), |v| {
                            v.to_string().trim_matches('"').to_owned()
                        })
                    })
                    .collect::<Vec<_>>()
                    .join(" | ")
            });
            Row {
                name,
                cells,
                expected: expected.to_owned(),
            }
        })
        .collect()
}

fn expect_none(file: &str, total: usize, fails: &[String]) {
    assert!(total > 0, "{file}: no cases");
    assert!(
        fails.is_empty(),
        "{file}: {} of {total} case(s) differ from the TypeScript outcome, e.g. {:?}",
        fails.len(),
        &fails[..fails.len().min(5)]
    );
}

/// A string of the fixtures: a JSON string, or `{"u16": [units]}` when it holds a lone surrogate.
fn decode(v: &Value) -> Vec<u16> {
    match v {
        Value::String(s) => s.encode_utf16().collect(),
        Value::Object(o) => o["u16"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u16)
            .collect(),
        other => panic!("not a string: {other}"),
    }
}

fn tf(b: bool) -> char {
    if b {
        'T'
    } else {
        'F'
    }
}

fn bits(a: ScopeAccess) -> String {
    [a.workspace, a.user, a.agent_private]
        .into_iter()
        .map(tf)
        .collect()
}

fn switches_text(s: &ChannelSwitches) -> String {
    format!("{}{}", bits(s.recall), tf(s.capture))
}

fn exposure_text(e: &Exposure) -> String {
    format!(
        "{}{}{}{}",
        bits(e.rights),
        bits(e.recall),
        tf(e.capture),
        switches_text(&e.switches)
    )
}

fn tri(c: char) -> Option<bool> {
    match c {
        '-' => None,
        other => Some(other == 'T'),
    }
}

/// `exposureConfig(channel, sw, agent)`.
fn exposure_config(channel: &str, sw: &str, agent: &str) -> Value {
    let [w, u, p, c]: [Option<bool>; 4] =
        sw.chars().map(tri).collect::<Vec<_>>().try_into().unwrap();
    let mut recall = Map::new();
    for (k, v) in [("workspace", w), ("user", u), ("agentPrivate", p)] {
        if let Some(v) = v {
            recall.insert(k.into(), Value::Bool(v));
        }
    }
    let mut entry = Map::new();
    if !recall.is_empty() {
        entry.insert("recall".into(), Value::Object(recall));
    }
    if let Some(c) = c {
        entry.insert("capture".into(), Value::Bool(c));
    }
    json!({"agents": {agent: {"memoryExposure": {channel: entry}}}})
}

fn channel_of(s: &str) -> ExposureChannel {
    ExposureChannel::parse(s).unwrap()
}

#[derive(Default)]
struct Dims<'a> {
    role: &'a str,
    kind: &'a str,
    right: &'a str,
    scopes: Option<Vec<String>>,
    variant: &'a str,
    groups: Option<Vec<String>>,
    memory: Option<MemoryOverride>,
}

/// `mkPrincipal(o)` of the exporter.
fn build_principal(d: Dims) -> ExposurePrincipal {
    let mut p = Principal::new("u-self", Role::parse(d.role).unwrap());
    p.kind = PrincipalKind::parse(d.kind);
    p.agent_rights = match d.right {
        "use" => Some(vec![("a1".to_owned(), AgentRight::Use)]),
        "manage" => Some(vec![("a1".to_owned(), AgentRight::Manage)]),
        _ => None,
    };
    p.token_scopes = d.scopes;
    let mut token_id = match d.variant {
        "tid-only" | "bound" | "other-agent" => Some("tok-1".to_owned()),
        "empty-tid" => Some(String::new()),
        _ => None,
    };
    let has_binding = matches!(
        d.variant,
        "binding-only" | "bound" | "other-agent" | "empty-tid"
    ) || d.groups.is_some()
        || d.memory.is_some();
    let binding = has_binding.then(|| TokenBinding {
        agent_id: if d.variant == "other-agent" {
            "a2"
        } else {
            "a1"
        }
        .to_owned(),
        groups: d.groups.clone(),
        memory: d.memory,
    });
    if (d.groups.is_some() || d.memory.is_some()) && token_id.as_deref().is_none_or(str::is_empty) {
        token_id = Some("tok-1".to_owned());
    }
    ExposurePrincipal {
        principal: p,
        token_id,
        binding,
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

fn resolve_text(channel: ExposureChannel, p: Option<&ExposurePrincipal>, config: &Value) -> String {
    let e = resolve_exposure(channel, "a1", p, config);
    assert_eq!(read_rights(p, "a1"), e.rights);
    exposure_text(&e)
}

#[test]
fn channel_switches_over_every_switch_set_and_configuration_shape() {
    let file = load("switches");
    let all = rows(&file);
    let mut fails = Vec::new();
    for r in &all {
        let (channel, shape, sw) = (r.str("channel"), r.str("shape"), r.str("sw"));
        let agent_cfg = |agent: &str| exposure_config(channel, sw, agent);
        let (config, agent) = match shape {
            "configured" => (agent_cfg("a1"), "a1"),
            "unlisted-agent" => (agent_cfg("someone-else"), "a1"),
            "other-channel-only" => {
                let other = ["collab", "mcp", "a2a"]
                    .into_iter()
                    .find(|c| *c != channel)
                    .unwrap();
                (exposure_config(other, sw, "a1"), "a1")
            }
            "proto-agent" => {
                let entry = agent_cfg("a1")["agents"]["a1"].clone();
                let text = format!("{{\"agents\":{{\"__proto__\":{entry}}}}}");
                (serde_json::from_str(&text).unwrap(), "__proto__")
            }
            "constructor-agent" => (json!({"agents": {}}), "constructor"),
            "empty-agent-id" => (
                json!({"agents": {"": {"memoryExposure": {"a2a": {"capture": false}}}}}),
                "",
            ),
            other => panic!("shape {other}"),
        };
        let got = switches_text(&channel_switches(&config, agent, channel_of(channel)));
        if got != r.expected {
            fails.push(format!("{} {got} vs {}", r.name, r.expected));
        }
    }
    expect_none("switches", all.len(), &fails);
}

#[test]
fn resolve_over_principals_rights_and_capture() {
    let file = load("resolve-principals");
    let scope_sets = file["scopeSets"].as_object().unwrap().clone();
    let all = rows(&file);
    let mut fails = Vec::new();
    for r in &all {
        let got = if r.str("variant") == "no-principal" {
            resolve_text(ExposureChannel::Collab, None, &json!({"agents": {}}))
        } else {
            let scopes = scope_sets[r.str("scopes")]
                .as_array()
                .map(|a| a.iter().map(|s| s.as_str().unwrap().to_owned()).collect());
            let p = build_principal(Dims {
                role: r.str("role"),
                kind: r.str("kind"),
                right: r.str("right"),
                scopes,
                variant: r.str("variant"),
                ..Dims::default()
            });
            resolve_text(ExposureChannel::Collab, Some(&p), &json!({"agents": {}}))
        };
        if got != r.expected {
            fails.push(format!("{} {got} vs {}", r.name, r.expected));
        }
    }
    expect_none("resolve-principals", all.len(), &fails);
}

#[test]
fn resolve_over_switch_sets_and_principals() {
    let all = rows(&load("resolve-switches"));
    let mut fails = Vec::new();
    for r in &all {
        let channel = r.str("channel");
        let p = build_principal(Dims {
            role: r.str("role"),
            kind: r.str("kind"),
            right: r.str("right"),
            variant: r.str("variant"),
            ..Dims::default()
        });
        let got = resolve_text(
            channel_of(channel),
            Some(&p),
            &exposure_config(channel, r.str("sw"), "a1"),
        );
        if got != r.expected {
            fails.push(format!("{} {got} vs {}", r.name, r.expected));
        }
    }
    expect_none("resolve-switches", all.len(), &fails);
}

#[test]
fn resolve_over_token_binding_overrides() {
    let file = load("resolve-overrides");
    let bases = file["bases"].as_object().unwrap().clone();
    let group_sets = file["groupSets"].as_object().unwrap().clone();
    let all = rows(&file);
    let mut fails = Vec::new();
    for r in &all {
        let base = &bases[r.str("base")];
        let [w, u, p]: [Option<bool>; 3] = r
            .str("recall")
            .chars()
            .map(tri)
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        let recall = (w.is_some() || u.is_some() || p.is_some()).then_some(RecallOverride {
            workspace: w,
            user: u,
            agent_private: p,
        });
        let disclose = match r.str("disclose") {
            "agent-decides" => Some(Disclose::AgentDecides),
            "never" => Some(Disclose::Never),
            _ => None,
        };
        let capture = tri(r.str("capture").chars().next().unwrap());
        let memory = (recall.is_some() || disclose.is_some() || capture.is_some()).then_some(
            MemoryOverride {
                recall,
                disclose,
                capture,
            },
        );
        let groups = group_sets.get(r.str("groups")).map(strings);
        let principal = build_principal(Dims {
            role: base["role"].as_str().unwrap(),
            kind: base["kind"].as_str().unwrap(),
            right: base["right"].as_str().unwrap(),
            variant: "bound",
            groups,
            memory,
            ..Dims::default()
        });
        let got = resolve_text(
            ExposureChannel::Collab,
            Some(&principal),
            &json!({"agents": {}}),
        );
        if got != r.expected {
            fails.push(format!("{} {got} vs {}", r.name, r.expected));
        }
    }
    expect_none("resolve-overrides", all.len(), &fails);
}

#[test]
fn scanner_classifies_every_corpus_line_and_both_credential_halves_agree() {
    let scanner = SensitivityScanner::new().unwrap();
    let all = rows(&load("scanner"));
    let mut fails = Vec::new();
    let (mut redactor_lines, mut token_lines) = (0, 0);
    for r in &all {
        let text = decode(r.cell("text").unwrap());
        let summary = r.cell("summary").map(decode).unwrap_or_default();
        let mut combined = text.clone();
        combined.push(0x0a);
        combined.extend_from_slice(&summary);
        let cats = scanner.scan_units(&text, &summary);
        let (red, tok) = (
            scanner.credential_by_redactor(&combined),
            matches_token(&combined),
        );
        redactor_lines += usize::from(red);
        token_lines += usize::from(tok);
        let got = format!(
            "{}/{}{}",
            if cats.is_empty() {
                "-".to_owned()
            } else {
                cats.join(",")
            },
            if red { 'R' } else { '-' },
            if tok { 'T' } else { '-' }
        );
        if got != r.expected {
            fails.push(format!(
                "{:?} -> {got} vs {}",
                String::from_utf16_lossy(&combined)
                    .chars()
                    .take(60)
                    .collect::<String>(),
                r.expected
            ));
        }
    }
    assert!(
        redactor_lines > 50 && token_lines > 40,
        "the corpus exercises both halves ({redactor_lines}, {token_lines})"
    );
    expect_none("scanner", all.len(), &fails);
}

#[test]
fn content_hash_over_whitespace_normal_forms_and_lone_surrogates() {
    let all = rows(&load("hash"));
    let mut fails = Vec::new();
    for r in &all {
        let text = decode(r.cell("text").unwrap());
        let summary = r.cell("summary").map(decode).unwrap_or_default();
        let got = compute_content_hash_units(&text, &summary);
        if got != r.expected {
            fails.push(r.name.clone());
        }
    }
    expect_none("hash", all.len(), &fails);
    // A lone surrogate hashes as U+FFFD, which is what a Rust string holds in its place.
    assert_eq!(
        compute_content_hash_units(&[0x61, 0xd83d], &[]),
        compute_content_hash_units(&[0x61, 0xfffd], &[])
    );
}

#[test]
fn keyword_tables_are_the_expansion_of_the_pattern_source() {
    let file = load("keywords");
    for (cat, table) in [
        ("health", HEALTH),
        ("financial", FINANCIAL),
        ("identity", IDENTITY),
        ("personal", PERSONAL),
    ] {
        let mut want = strings(&file["variants"][cat]);
        let mut got: Vec<String> = table.iter().map(|s| (*s).to_owned()).collect();
        crate::js::sort_default(&mut want);
        crate::js::sort_default(&mut got);
        assert_eq!(got, want, "{cat}");
    }
    let others = file["otherPatterns"].as_array().unwrap();
    assert_eq!(others[0]["src"], IBAN_PATTERN);
    assert_eq!(others[1]["src"], CARD_PATTERN);
    assert_eq!(others[1]["flags"], "");
    assert_eq!(others[0]["flags"], "i");
}

#[test]
fn keyword_spot_checks_over_non_ascii_letters() {
    // `/\b(?:überweisung|führerschein|ssn|krankheit)\b/i`, recorded from the real regular expression (fixtures/parity/js).
    let path = format!(
        "{}/../../fixtures/parity/js/classes.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let file: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in file["spot"].as_array().unwrap() {
        let s = decode(&case["s"]);
        assert_eq!(
            matches_keywords(&s, &["überweisung", "führerschein", "ssn", "krankheit"]),
            case["matches"].as_bool().unwrap(),
            "{:?}",
            String::from_utf16_lossy(&s)
        );
    }
    // Sanity of the two other tables used above.
    assert!(FINANCIAL.contains(&"überweisung"));
}

/// The stub service of the exporter (`makeStub`).
struct Stub {
    manual: String,
    table: HashMap<String, Vec<String>>,
    throws_all: bool,
    throws_on: Option<String>,
    assessed: Cell<usize>,
    manual_calls: Cell<usize>,
}

impl Stub {
    fn from(v: &Value) -> Option<Stub> {
        let o = v.as_object()?;
        let assess = &o["assess"];
        let (throws_all, throws_on, table) = match assess {
            Value::String(s) if s == "throws" => (true, None, Value::Null),
            other => (
                false,
                other
                    .get("throwsOn")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                other["table"].clone(),
            ),
        };
        Some(Stub {
            manual: o["manual"].as_str().unwrap().to_owned(),
            table: table
                .as_object()
                .map(|t| t.iter().map(|(k, v)| (k.clone(), strings(v))).collect())
                .unwrap_or_default(),
            throws_all,
            throws_on,
            assessed: Cell::new(0),
            manual_calls: Cell::new(0),
        })
    }
}

impl SensitivityService<String> for Stub {
    fn has_manual_categories(&self, _filter: &[String]) -> Result<bool, String> {
        self.manual_calls.set(self.manual_calls.get() + 1);
        match self.manual.as_str() {
            "never" => Ok(false),
            "always" => Ok(true),
            "after-assess" => Ok(self.assessed.get() > 0),
            "throws" => Err("manual failed".into()),
            "throws-second" if self.manual_calls.get() > 1 => Err("manual failed again".into()),
            "throws-second" => Ok(false),
            other => panic!("manual {other}"),
        }
    }

    fn assess_aggregate(&self, text: &str) -> Result<Vec<String>, String> {
        self.assessed.set(self.assessed.get() + 1);
        if self.throws_all {
            return Err("assess failed".into());
        }
        if self.throws_on.as_deref() == Some(text) {
            return Err("assess failed on one block".into());
        }
        Ok(self.table.get(text).cloned().unwrap_or_default())
    }
}

#[derive(Clone)]
struct TestBlock {
    name: String,
    text: String,
}

impl Block for TestBlock {
    fn text(&self) -> &str {
        &self.text
    }
}

#[test]
fn refusal_and_block_filter_over_a_stub_service() {
    let mut fails = Vec::new();
    let refusal = rows(&load("sensitivity-refusal"));
    for r in &refusal {
        let filter = strings(r.cell("filter").unwrap());
        let stub = Stub::from(r.cell("service").unwrap());
        let got = match sensitivity_refusal(&filter, stub.as_ref()) {
            Ok(None) => "none".to_owned(),
            Ok(Some(x)) => x.as_str().to_owned(),
            Err(e) => format!("throws/{e}"),
        };
        if got != r.expected {
            fails.push(format!("{} {got} vs {}", r.name, r.expected));
        }
    }
    expect_none("sensitivity-refusal", refusal.len(), &fails);
    let filters = rows(&load("sensitivity-filter"));
    for r in &filters {
        let filter = strings(r.cell("filter").unwrap());
        let stub = Stub::from(r.cell("service").unwrap());
        let blocks: Vec<TestBlock> = r
            .cell("blocks")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|b| TestBlock {
                name: b["name"].as_str().unwrap().into(),
                text: b["text"].as_str().unwrap().into(),
            })
            .collect();
        let got = match filter_sensitive_blocks(&blocks, &filter, stub.as_ref()) {
            Ok(kept) => format!(
                "kept/{}",
                kept.iter()
                    .map(|b| b.name.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Err(e) => format!("throws/{e}"),
        };
        if got != r.expected {
            fails.push(format!("{} {got} vs {}", r.name, r.expected));
        }
    }
    expect_none("sensitivity-filter", filters.len(), &fails);
}

#[test]
fn local_only_functions() {
    let all = rows(&load("local-only"));
    let mut fails = Vec::new();
    for r in &all {
        let cfg = r.cell("cfg").cloned().unwrap_or(Value::Null);
        let got = match r.str("fn") {
            "for" => local_only_for(&cfg, r.cell("agentId").and_then(Value::as_str)),
            "model" => is_local_model(r.str("provider"), r.str("model")),
            "chat" => {
                // `new URL(5)` and `new URL(null)` read the string form of the value, which is no URL.
                let endpoint = r.cell("endpoint").map(|e| match e {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                });
                is_local_chat_model(r.str("provider"), r.str("model"), endpoint.as_deref(), &cfg)
            }
            other => panic!("fn {other}"),
        };
        if tf(got).to_string() != r.expected {
            fails.push(format!("{} {got} vs {}", r.name, r.expected));
        }
    }
    expect_none("local-only", all.len(), &fails);
}

#[test]
fn local_only_findings_and_check() {
    let all = rows(&load("doctor-findings"));
    let mut fails = Vec::new();
    for r in &all {
        let cfg = r.cell("cfg").cloned().unwrap_or(Value::Null);
        let shared = r.cell("sharedOnly").and_then(Value::as_bool).unwrap();
        let got = json!(local_only_findings(&cfg, shared));
        let want: Value = serde_json::from_str(&r.expected).unwrap();
        if got != want {
            fails.push(format!("{} {got} vs {want}", r.name));
        }
    }
    expect_none("doctor-findings", all.len(), &fails);
    let all = rows(&load("doctor-check"));
    for r in &all {
        let cfg = r.cell("cfg").cloned().unwrap_or(Value::Null);
        let base = cfg.as_object().cloned().unwrap_or_default();
        let run = match r.str("variant") {
            "switch-off" => cfg.clone(),
            "installation-on" => {
                let mut o = base;
                o.insert("privacy".into(), json!({"localOnly": true}));
                Value::Object(o)
            }
            _ => {
                let mut o = base;
                o.insert("privacy".into(), json!({"localOnly": false}));
                o.insert(
                    "agents".into(),
                    json!({"zed": {"privacy": {"localOnly": true}}, "alice": {"privacy": {"localOnly": true}}, "bob": {"privacy": {"localOnly": false}}}),
                );
                Value::Object(o)
            }
        };
        let got = local_only_check(&run).to_value();
        let want: Value = serde_json::from_str(&r.expected).unwrap();
        if got != want {
            fails.push(format!("{} {got} vs {want}", r.name));
        }
    }
    expect_none("doctor-check", all.len(), &fails);
}
