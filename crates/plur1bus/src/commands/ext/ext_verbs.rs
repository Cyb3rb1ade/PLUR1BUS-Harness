//! `skill …` and `plugin …`: the same verbs over `ext.*`, told apart by [`Verb`] (see the parent module).
use super::backend::{Backend, Input};
use super::disclosure::*;
use super::{ack_hint, fail, strings, Failure};
use crate::cli::{ExtState, InstallFlags};
use crate::commands::module::confirm;
use crate::ext::commit::Agents;
use crate::ext::list::ListFilter;
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};

/// Which command runs: the `--json` id prefix, the kinds it lists and installs, and the other command's name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Verb {
    Skill,
    Plugin,
}

impl Verb {
    fn name(self) -> &'static str {
        match self {
            Verb::Skill => "skill",
            Verb::Plugin => "plugin",
        }
    }
    fn other(self) -> &'static str {
        match self {
            Verb::Skill => "plugin",
            Verb::Plugin => "skill",
        }
    }
    fn kinds(self) -> Vec<String> {
        match self {
            Verb::Skill => vec!["skill".into()],
            Verb::Plugin => vec!["module".into(), "channel".into()],
        }
    }
    fn owns(self, kind: &str) -> bool {
        self.kinds().iter().any(|k| k == kind)
    }
    fn schema(self, op: &str) -> String {
        format!("{}.{op}/1", self.name())
    }
}

fn interactive(out: &Out) -> bool {
    std::io::stdin().is_terminal() && !out.json
}

/// One `[y/N]` on the terminal.
fn ask(question: &str) -> bool {
    eprint!("{question} [y/N] ");
    std::io::stderr().flush().ok();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).ok();
    line.trim().eq_ignore_ascii_case("y")
}

fn declined(out: &Out) -> ! {
    out.fail(
        "E_INVALID_PARAMS",
        "not applied",
        json!({ "applied": false }),
        2,
    )
}

fn state_filter(s: Option<ExtState>) -> Option<Vec<String>> {
    s.map(|s| {
        vec![match s {
            ExtState::Installed => "installed".to_string(),
            ExtState::Enabled => "enabled".to_string(),
        }]
    })
}

fn agents_text(a: &Value) -> String {
    match a {
        Value::String(s) => s.clone(),
        Value::Array(l) if l.is_empty() => "none".into(),
        other => strings(other).join(","),
    }
}

fn describe_list(v: &Value, verb: Verb) -> String {
    let items = v["items"].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return format!(
            "no {} installed",
            if verb == Verb::Skill {
                "skills"
            } else {
                "modules or channels"
            }
        );
    }
    let mut s = String::new();
    for i in &items {
        s.push_str(&format!(
            "{} {}  {}  {}  source {}  trust {}",
            i["name"].as_str().unwrap_or("?"),
            i["version"].as_str().unwrap_or("?"),
            i["kind"].as_str().unwrap_or("?"),
            i["state"].as_str().unwrap_or("?"),
            i["source"].as_str().unwrap_or("?"),
            i["trust"].as_str().unwrap_or("?"),
        ));
        if verb == Verb::Skill {
            s.push_str(&format!("  agents {}", agents_text(&i["agents"])));
        }
        let overlays = strings(&i["overlays"]);
        if !overlays.is_empty() {
            s.push_str(&format!("  [{}]", overlays.join(", ")));
        }
        if i["integrity"] == "tampered" {
            s.push_str("  files changed");
        }
        s.push('\n');
    }
    s.trim_end().to_string()
}

/// `list`: `ext.list` of this command's kinds (`plugin --kind` narrows them); `--source` filters here, since
/// `ext.list` has no source filter.
pub(crate) fn list(
    out: &Out,
    layout: &Layout,
    verb: Verb,
    kind: Option<&str>,
    state: Option<ExtState>,
    agent: Option<String>,
    source: Option<String>,
) {
    let filter = ListFilter {
        kind: Some(kind.map_or_else(|| verb.kinds(), |k| vec![k.to_string()])),
        state: state_filter(state),
        agent,
    };
    let mut v = Backend::open(out, layout, false)
        .list(&filter)
        .unwrap_or_else(|f| fail(out, &f, None));
    if let Some(src) = source {
        let kept: Vec<Value> = v["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i["source"] == src.as_str())
            .cloned()
            .collect();
        v["items"] = json!(kept);
    }
    out.ok(&verb.schema("list"), &v, || describe_list(&v, verb));
}

fn describe_show(v: &Value) -> String {
    let i = &v["item"];
    let mut lines = vec![format!(
        "{} {} ({}), {}",
        i["name"].as_str().unwrap_or("?"),
        i["version"].as_str().unwrap_or("?"),
        i["kind"].as_str().unwrap_or("?"),
        i["state"].as_str().unwrap_or("?")
    )];
    if let Some(id) = i["id"].as_str() {
        lines.push(format!("package: {id}"));
    }
    lines.push(format!("source: {}", i["source"].as_str().unwrap_or("?")));
    lines.push(trust_line(&v["trust"]));
    if i["kind"] == "skill" {
        lines.push(format!("agents: {}", agents_text(&i["agents"])));
    }
    let overlays = strings(&i["overlays"]);
    if !overlays.is_empty() {
        lines.push(format!("overlays: {}", overlays.join(", ")));
    }
    if let Some(ig) = i["integrity"].as_str() {
        lines.push(format!("integrity: {ig}"));
    }
    if v["capabilities"].as_object().is_some_and(|c| !c.is_empty()) {
        lines.extend(capability_lines(&v["capabilities"]));
        lines.extend(script_lines(&v["scripts"]));
    }
    lines.push(format!(
        "files: {} ({} bytes)",
        v["files"]["count"], v["files"]["bytes"]
    ));
    let deps = strings(&v["dependents"]);
    if !deps.is_empty() {
        lines.push(format!("needed by: {}", deps.join(", ")));
    }
    for t in v["trash"].as_array().into_iter().flatten() {
        lines.push(format!(
            "in the trash: {} ({}, removed {})",
            t["trashId"].as_str().unwrap_or("?"),
            t["version"].as_str().unwrap_or("?"),
            t["removedAt"].as_str().unwrap_or("?")
        ));
    }
    lines.join("\n")
}

fn not_this_kind(verb: Verb, op: &str, name: &str, kind: &str) -> Failure {
    let mut f = Failure::new(
        "E_NOT_FOUND",
        "extension-unknown",
        format!("{name} is a {kind}, not a {}", verb.name()),
    );
    f.detail = Some(format!("use {} {op} {name}", verb.other()));
    f
}

/// `show`: `ext.show`; an item of the other command's kind is `extension-unknown` with a pointer to it.
pub(crate) fn show(out: &Out, layout: &Layout, verb: Verb, name: &str) {
    let v = Backend::open(out, layout, false)
        .show(name)
        .unwrap_or_else(|f| fail(out, &f, None));
    let kind = v["item"]["kind"].as_str().unwrap_or("");
    if !verb.owns(kind) {
        fail(out, &not_this_kind(verb, "show", name, kind), None);
    }
    out.ok(&verb.schema("show"), &v, || describe_show(&v));
}

/// The acknowledgments an inspection shows it needs: the trust tier's, a downgrade, and `capabilities` for an
/// install that enables (or, on the terminal's one question, a replacement whose capabilities change).
fn predicted(insp: &Value, enable: bool) -> Vec<String> {
    let mut need = Vec::new();
    match insp["trust"]["tier"].as_str() {
        Some("unsigned") => need.push("unsigned".to_string()),
        Some("unknown-signer") => need.push("unknown-signer".to_string()),
        _ => {}
    }
    let new = semver::Version::parse(insp["manifest"]["version"].as_str().unwrap_or(""));
    let old = semver::Version::parse(insp["replaces"]["version"].as_str().unwrap_or(""));
    if let (Ok(n), Ok(o)) = (new, old) {
        if n < o {
            need.push("downgrade".into());
        }
    }
    if enable {
        need.push("capabilities".into());
    }
    need
}

/// The one terminal question: it names the tier, and what else a yes acknowledges (the capabilities of an install that
/// enables, or of a replacement whose capabilities change).
fn question(insp: &Value, enable: bool, changed: bool) -> String {
    let head = match insp["trust"]["tier"].as_str() {
        Some("unsigned") => "Install unsigned package",
        Some("unknown-signer") => "Install package from unknown signer",
        _ => "Install",
    };
    let tail = if enable {
        " and enable it, acknowledging the capabilities above"
    } else if changed {
        ", acknowledging its changed capabilities"
    } else {
        ""
    };
    format!("{head}{tail}?")
}

fn describe_install(v: &Value, verb: Verb) -> String {
    let name = v["name"].as_str().unwrap_or("?");
    let version = v["version"].as_str().unwrap_or("?");
    let state = v["state"].as_str().unwrap_or("installed");
    let head = if v["replaced"] == true {
        format!("replaced {name} with {version}")
    } else {
        format!("installed {name} {version}")
    };
    if state == "enabled" {
        format!("{head} (enabled)")
    } else {
        format!(
            "{head} (disabled); enable it with `plur1bus {} enable {name}`",
            verb.name()
        )
    }
}

/// `install` (see the module documentation).
pub(crate) fn install(
    out: &Out,
    layout: &Layout,
    verb: Verb,
    path: &str,
    enable: Option<Agents>,
    flags: &InstallFlags,
) {
    let input = Input::parse(path);
    let mut be = Backend::open(out, layout, true);
    let insp = be.inspect(&input).unwrap_or_else(|f| fail(out, &f, None));
    let kind = insp["manifest"]["kind"].as_str().unwrap_or("");
    if !verb.owns(kind) {
        let mut f = Failure::new(
            "E_INVALID_PARAMS",
            "package-invalid",
            format!(
                "{} is a {kind} package; `plur1bus {} install` takes {}",
                insp["manifest"]["id"].as_str().unwrap_or("the package"),
                verb.name(),
                if verb == Verb::Skill {
                    "skills"
                } else {
                    "modules and channels"
                }
            ),
        );
        f.detail = Some(format!("use {} install", verb.other()));
        fail(out, &f, None);
    }
    if flags.dry_run {
        out.ok("ext.inspect/1", &insp, || {
            format!(
                "{}\n(dry run: nothing was installed)",
                describe_inspection(&insp)
            )
        });
        return;
    }
    if !out.json {
        println!("{}", describe_inspection(&insp));
    }
    // stdin carries the package, so it cannot answer a question.
    let tty = interactive(out) && !flags.yes && matches!(input, Input::Path(_));
    let mut given: Vec<String> = Vec::new();
    for (on, a) in [
        (flags.allow_unsigned, "unsigned"),
        (flags.allow_unknown_signer, "unknown-signer"),
        (flags.allow_downgrade, "downgrade"),
        (flags.yes, "capabilities"),
    ] {
        if on {
            given.push(a.to_string());
        }
    }
    let changed = insp["replaces"]["capabilityDiff"]["changed"]
        .as_array()
        .is_some_and(|c| !c.is_empty());
    if tty {
        if !ask(&question(&insp, enable.is_some(), changed)) {
            declined(out);
        }
        for a in predicted(&insp, enable.is_some() || changed) {
            if !given.contains(&a) {
                given.push(a);
            }
        }
    } else if let Some(missing) = predicted(&insp, enable.is_some())
        .into_iter()
        // Spec §8.3: outside a terminal a tier or downgrade needs its --allow-* flag *and* --yes (X1-C24 waives --yes
        // only when nothing is due); `capabilities` is --yes itself.
        .find(|a| !given.contains(a) || (a != "capabilities" && !flags.yes))
    {
        let what = match missing.as_str() {
            "unsigned" => "the package is not signed",
            "unknown-signer" => "the package is signed by a key this harness does not trust",
            "downgrade" => "the package is a lower version than the installed one",
            _ => "enabling lets the extension use the capabilities it declares",
        };
        // The data the engine's refusal carries: the inspection, plus the authority for the capabilities.
        let mut data = insp.clone();
        if missing == "capabilities" {
            data["authority"] = if kind == "skill" {
                insp["capabilities"]["harness"]["authority"].clone()
            } else {
                json!("full")
            };
        }
        let f = Failure {
            code: "E_APPROVAL_REQUIRED".into(),
            message: format!("{what}; acknowledge {missing:?} to go ahead"),
            reason: Some(format!("acknowledge-{missing}")),
            detail: None,
            ids: None,
            data: Some(Box::new(data)),
        };
        fail(out, &f, Some(&ack_hint(&missing)));
    }
    let id = insp["inspectionId"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let v = loop {
        match be.install(&id, &given, enable.as_ref()) {
            Ok(v) => break v,
            Err(f) => {
                let Some(x) = f.wants().map(str::to_string) else {
                    fail(out, &f, None)
                };
                if given.contains(&x) || !tty {
                    fail(out, &f, Some(&ack_hint(&x)));
                }
                if let Some(d) = &f.data {
                    println!("{}", describe_inspection(d));
                }
                if !ask(&format!("{}; go ahead?", f.message)) {
                    declined(out);
                }
                given.push(x);
            }
        }
    };
    if let Some(note) = noop_note(&insp, &v, enable.as_ref(), verb) {
        eprintln!("plur1bus: note: {note}");
    }
    out.ok(&verb.schema("install"), &v, || describe_install(&v, verb));
}

/// Review Focus 5: the identical package again is a no-op (the inspection saw the id installed, yet nothing was
/// replaced), so an `--enable` was not applied: not at all when the item stays disabled, and not its agent restriction
/// when it was already enabled. Says so and names the command that does it.
fn noop_note(insp: &Value, v: &Value, enable: Option<&Agents>, verb: Verb) -> Option<String> {
    let enable = enable?;
    if !insp["replaces"].is_object() || v["replaced"] != false {
        return None;
    }
    let name = v["name"].as_str().unwrap_or("?");
    let head = format!(
        "{name} {} is already installed from this very package, so nothing was installed",
        v["version"].as_str().unwrap_or("?")
    );
    let agent_flags = match enable {
        Agents::Some(l) => l
            .iter()
            .map(|a| format!(" --agent {a}"))
            .collect::<String>(),
        Agents::All => String::new(),
    };
    let cmd = format!("plur1bus {} enable {name}{agent_flags}", verb.name());
    Some(match (v["state"].as_str(), enable) {
        (Some("enabled"), Agents::Some(l)) => format!(
            "{head} and the agent restriction ({}) was not applied; apply it with `{cmd}`",
            l.join(", ")
        ),
        (Some("enabled"), Agents::All) => format!(
            "{head} and nothing was changed (it is enabled); to give it to every agent use `{cmd}`"
        ),
        _ => format!("{head} or enabled; enable it with `{cmd}`"),
    })
}

fn plan_lines(plan: &Value) -> String {
    let or_nothing = |l: Vec<String>| {
        if l.is_empty() {
            "nothing".to_string()
        } else {
            l.join(", ")
        }
    };
    format!(
        "will restart: {}\nwill be held back: {}",
        or_nothing(strings(&plan["restart"]["modules"])),
        or_nothing(strings(&plan["heldBack"]))
    )
}

fn agents_of(list: Vec<String>) -> Option<Agents> {
    (!list.is_empty()).then_some(Agents::Some(list))
}

/// `enable` (see the module documentation).
pub(crate) fn enable(
    out: &Out,
    layout: &Layout,
    verb: Verb,
    name: &str,
    agents: Vec<String>,
    yes: bool,
) {
    let agents = agents_of(agents);
    let mut be = Backend::open(out, layout, true);
    let mut ack: Vec<String> = Vec::new();
    let plan = match be.toggle(name, true, agents.as_ref(), &ack, true) {
        Ok(p) => p,
        Err(f) if f.wants() == Some("capabilities") => {
            if !out.json {
                if let Some(d) = &f.data {
                    println!("{}", describe_capabilities(d));
                }
            }
            if !yes {
                if !interactive(out) {
                    fail(out, &f, Some(&ack_hint("capabilities")));
                }
                if !ask(&format!("Enable {name} with these capabilities?")) {
                    declined(out);
                }
            }
            ack.push("capabilities".into());
            be.toggle(name, true, agents.as_ref(), &ack, true)
                .unwrap_or_else(|f| fail(out, &f, None))
        }
        Err(f) => fail(out, &f, None),
    };
    if verb == Verb::Plugin && !out.json {
        println!("{}", plan_lines(&plan));
    }
    let v = be
        .toggle(name, true, agents.as_ref(), &ack, false)
        .unwrap_or_else(|f| fail(out, &f, None));
    out.ok(&verb.schema("enable"), &v, || match &agents {
        Some(Agents::Some(l)) => format!("enabled {name} for {}", l.join(", ")),
        _ => format!("enabled {name}"),
    });
}

/// `disable`: always allowed; a module's plan is printed first, and holding dependents back is asked.
pub(crate) fn disable(
    out: &Out,
    layout: &Layout,
    verb: Verb,
    name: &str,
    agents: Vec<String>,
    yes: bool,
) {
    let agents = agents_of(agents);
    let mut be = Backend::open(out, layout, true);
    if verb == Verb::Plugin {
        let plan = be
            .toggle(name, false, None, &[], true)
            .unwrap_or_else(|f| fail(out, &f, None));
        if !out.json {
            println!("{}", plan_lines(&plan));
        }
        let held = strings(&plan["heldBack"]);
        if !held.is_empty() {
            confirm(
                out,
                &format!("disable {name} and hold back {}?", held.join(", ")),
                yes,
            );
        }
    }
    let v = be
        .toggle(name, false, agents.as_ref(), &[], false)
        .unwrap_or_else(|f| fail(out, &f, None));
    out.ok(&verb.schema("disable"), &v, || match &agents {
        Some(Agents::Some(l)) => format!("disabled {name} for {}", l.join(", ")),
        _ => format!("disabled {name}"),
    });
}

/// `uninstall`: asks, and for `--purge` asks a second, separate question naming what goes.
pub(crate) fn uninstall(
    out: &Out,
    layout: &Layout,
    verb: Verb,
    name: &str,
    purge: bool,
    cascade: bool,
    yes: bool,
) {
    // The name is checked and the item looked up before anything is asked: an unknown or invalid name is its own
    // error, and the question says what really happens (a bundled skill is only hidden, X1-R18).
    let mut be = Backend::open(out, layout, true);
    let item = be.show(name).unwrap_or_else(|f| fail(out, &f, None))["item"].clone();
    let kind = item["kind"].as_str().unwrap_or("");
    if !verb.owns(kind) {
        fail(out, &not_this_kind(verb, "uninstall", name, kind), None);
    }
    let bundled = item["source"] == "bundled";
    // A bundled purge is refused by the engine (`E_DENIED bundled`) before any write: nothing to ask.
    if !(bundled && purge) {
        let q = if bundled {
            format!("hide the bundled skill {name} (nothing is moved or deleted; it stays installed, disabled and hidden)?")
        } else {
            format!(
                "uninstall {name} (it moves to the trash, from where `plur1bus {} restore` brings it back)?",
                verb.name()
            )
        };
        confirm(out, &q, yes);
        if purge {
            confirm(
                out,
                &format!(
                    "also purge data/ext/{name} and its configuration section (no secrets are stored yet)?"
                ),
                yes,
            );
        }
    }
    let v = be
        .uninstall(name, purge, cascade)
        .unwrap_or_else(|f| fail(out, &f, None));
    out.ok(&verb.schema("uninstall"), &v, || {
        match v["trashId"].as_str() {
            Some(tid) => format!(
                "uninstalled {name}{}; restore it with `plur1bus {} restore {tid}`",
                if v["purged"] == true {
                    " with its data and configuration"
                } else {
                    ""
                },
                verb.name()
            ),
            // A bundled skill is hidden, not moved (X1-R18): there is no trash entry.
            None => {
                format!("hid {name} (bundled with the harness; nothing was moved to the trash)")
            }
        }
    });
}

pub(crate) fn restore(out: &Out, layout: &Layout, verb: Verb, trash_id: &str) {
    let v = Backend::open(out, layout, true)
        .restore(trash_id)
        .unwrap_or_else(|f| fail(out, &f, None));
    out.ok(&verb.schema("restore"), &v, || {
        format!(
            "restored {} {} (disabled); enable it with `plur1bus {} enable {}`",
            v["name"].as_str().unwrap_or("?"),
            v["version"].as_str().unwrap_or("?"),
            verb.name(),
            v["name"].as_str().unwrap_or("?")
        )
    });
}

#[cfg(test)]
mod tests {
    use super::super::flag_for;
    use super::*;

    fn insp(tier: &str, version: &str, replaces: Option<&str>) -> Value {
        let mut v = json!({ "manifest": { "version": version }, "trust": { "tier": tier } });
        if let Some(r) = replaces {
            v["replaces"] = json!({ "version": r, "capabilityDiff": { "changed": [] } });
        }
        v
    }

    #[test]
    fn the_inspection_predicts_the_acknowledgments_in_the_engines_order() {
        assert_eq!(
            predicted(&insp("unsigned", "1.0.0", None), false),
            ["unsigned"]
        );
        assert_eq!(
            predicted(&insp("unknown-signer", "1.0.0", Some("2.0.0")), true),
            ["unknown-signer", "downgrade", "capabilities"]
        );
        assert!(predicted(&insp("first-party", "2.0.0", Some("1.0.0")), false).is_empty());
        // A version that is not semver never reads as a downgrade.
        assert!(predicted(&insp("first-party", "x", Some("1.0.0")), false).is_empty());
    }

    #[test]
    fn the_one_question_names_the_tier() {
        let q = |tier: &str, enable: bool, changed: bool| {
            question(&insp(tier, "1.0.0", None), enable, changed)
        };
        assert_eq!(q("unsigned", false, false), "Install unsigned package?");
        assert_eq!(
            q("unknown-signer", false, false),
            "Install package from unknown signer?"
        );
        assert_eq!(q("first-party", false, false), "Install?");
        assert_eq!(
            q("unsigned", true, false),
            "Install unsigned package and enable it, acknowledging the capabilities above?"
        );
        assert_eq!(
            q("first-party", false, true),
            "Install, acknowledging its changed capabilities?"
        );
    }

    #[test]
    fn a_no_op_enable_says_what_was_not_applied() {
        let insp = insp("first-party", "1.0.0", Some("1.0.0"));
        let v = |state: &str| json!({ "name": "demo-skill", "version": "1.0.0", "replaced": false, "state": state });
        let some = Agents::Some(vec!["bernd".into()]);
        let n = noop_note(&insp, &v("enabled"), Some(&some), Verb::Skill).unwrap();
        assert!(
            n.contains("agent restriction (bernd) was not applied"),
            "{n}"
        );
        assert!(
            n.contains("`plur1bus skill enable demo-skill --agent bernd`"),
            "{n}"
        );
        let n = noop_note(&insp, &v("installed"), Some(&Agents::All), Verb::Skill).unwrap();
        assert!(
            n.contains("already installed from this very package") && n.contains("or enabled"),
            "{n}"
        );
        // No note without --enable, for a fresh install (nothing installed before) or a real replacement.
        assert!(noop_note(&insp, &v("installed"), None, Verb::Skill).is_none());
        let fresh = json!({ "manifest": {}, "trust": {} });
        assert!(noop_note(&fresh, &v("enabled"), Some(&Agents::All), Verb::Skill).is_none());
        let mut replaced = v("enabled");
        replaced["replaced"] = json!(true);
        assert!(noop_note(&insp, &replaced, Some(&Agents::All), Verb::Skill).is_none());
    }

    #[test]
    fn each_acknowledgment_names_its_flag() {
        assert_eq!(flag_for("unsigned"), "--allow-unsigned");
        assert_eq!(flag_for("unknown-signer"), "--allow-unknown-signer");
        assert_eq!(flag_for("downgrade"), "--allow-downgrade");
        assert_eq!(flag_for("capabilities"), "--yes");
        assert!(ack_hint("downgrade").contains("--allow-downgrade --yes"));
    }

    #[test]
    fn the_plan_names_restarts_and_held_back_modules() {
        assert_eq!(
            plan_lines(&json!({ "restart": { "modules": ["fixture"] }, "heldBack": [] })),
            "will restart: fixture\nwill be held back: nothing"
        );
    }
}
