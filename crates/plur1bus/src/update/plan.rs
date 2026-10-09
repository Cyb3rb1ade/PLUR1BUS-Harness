//! The human-readable update plan (`update --plan`, and what `update` shows before it asks): old to new version, the
//! notes grouped as new / changed / fixed / attention, breaking changes with what to do, which components restart,
//! migrations (reversible or not), the state of every add-on, and the download size.
//!
//! One document is built ([`build`], schema `update.plan/1`, also what `--json` prints) and the text is rendered from
//! it ([`render`]), so the two cannot disagree.
//!
//! **Language.** The CLI has no message catalogue; the plan alone is localised. `--lang en|de` picks it; without the
//! flag the locale decides (`LC_ALL`, `LC_MESSAGES`, `LANG`: a value starting with `de` is German, anything else
//! English). Texts that come from the signed release manifest (`notes`, `changes`, `breaking`, `migrations`) are shown
//! in the chosen language, else English, else the first language the release has.
//!
//! The release manifest's top level is open (D78); the optional fields read here, all tolerated when absent or
//! malformed, are:
//!
//! ```json
//! "notes": { "en": "…", "de": "…" },
//! "changes": { "new": [L], "changed": [L], "fixed": [L], "attention": [L] },
//! "breaking": [ { "summary": L, "action": L } ],
//! "migrations": [ { "id": "…", "description": L, "reversible": true } ]
//! ```
//!
//! where `L` is a string or `{ "en": "…", "de": "…" }`.
use super::addons::{AddonPlan, Status};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    De,
}

impl Lang {
    pub fn parse(s: &str) -> Option<Lang> {
        match s.trim().to_ascii_lowercase().as_str() {
            "en" => Some(Lang::En),
            "de" => Some(Lang::De),
            _ => None,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::De => "de",
        }
    }

    /// From a lookup of `LC_ALL`, `LC_MESSAGES`, `LANG` (the first one set and non-empty decides).
    pub fn from_locale(env: &dyn Fn(&str) -> Option<String>) -> Lang {
        let v = ["LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .find_map(|k| env(k).filter(|v| !v.trim().is_empty()));
        match v {
            Some(v) if v.trim().to_ascii_lowercase().starts_with("de") => Lang::De,
            _ => Lang::En,
        }
    }

    pub fn from_env() -> Lang {
        Lang::from_locale(&|k| std::env::var(k).ok())
    }
}

/// A localised text: a string, or an object of languages.
fn loc(v: &Value, lang: Lang) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Object(m) => m
            .get(lang.code())
            .or_else(|| m.get("en"))
            .or_else(|| m.values().find(|v| v.is_string()))
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        _ => None,
    }
}

fn loc_list(v: Option<&Value>, lang: Lang) -> Vec<String> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| loc(x, lang))
        .collect()
}

/// What the plan is built from.
pub struct Inputs<'a> {
    /// The signed release manifest as the feed (or bundle) served it.
    pub doc: &'a Value,
    pub from: &'a str,
    pub to: &'a str,
    pub channel: &'a str,
    pub downgrade: bool,
    pub bundle: bool,
    /// `plan_changes`' unit diff.
    pub changes: &'a [Value],
    pub restart_core: bool,
    pub restart_modules: &'a [String],
    pub supervisor_restart: bool,
    pub addons: &'a AddonPlan,
    /// `(what, bytes)` of every download; `None`: the release does not say.
    pub downloads: Vec<(String, Option<u64>)>,
    pub forced: bool,
}

/// Fixed phrases, English and German.
struct Words {
    update: &'static str,
    security: &'static str,
    downgrade: &'static str,
    source_feed: &'static str,
    source_bundle: &'static str,
    download: &'static str,
    unknown_size: &'static str,
    restarts: &'static str,
    restart_none: &'static str,
    new: &'static str,
    changed: &'static str,
    fixed: &'static str,
    attention: &'static str,
    breaking: &'static str,
    todo: &'static str,
    migrations: &'static str,
    reversible: [&'static str; 3],
    addons: &'static str,
    compatible: &'static str,
    incompatible: &'static str,
    unknown: &'static str,
    will_disable: &'static str,
    will_reenable: &'static str,
    required: &'static str,
    rollback: &'static str,
    daemon: &'static str,
    supervisor: &'static str,
    core: &'static str,
    modules: &'static str,
    attn_security: &'static str,
    attn_downgrade: &'static str,
    attn_disable: &'static str,
    attn_blocked: &'static str,
    attn_irreversible: &'static str,
    attn_note: &'static str,
    attn_forced: &'static str,
}

const EN: Words = Words {
    update: "Update",
    security: "security release",
    downgrade: "DOWNGRADE",
    source_feed: "signed release feed",
    source_bundle: "offline bundle",
    download: "Download",
    unknown_size: "size not stated",
    restarts: "Restarts",
    restart_none: "the daemon only",
    new: "New",
    changed: "Changed",
    fixed: "Fixed",
    attention: "Needs attention",
    breaking: "Breaking changes",
    todo: "What to do",
    migrations: "Migrations",
    reversible: ["reversible", "NOT reversible", "reversibility not stated"],
    addons: "Add-ons",
    compatible: "compatible",
    incompatible: "incompatible",
    unknown: "unknown",
    will_disable: "will be disabled for the new version",
    will_reenable: "will be re-enabled",
    required: "required",
    rollback: "Rollback: a snapshot of the binary, config.json, the install manifest and the core is kept (`plur1bus update --rollback`); the memory store is never touched or restored.",
    daemon: "the daemon",
    supervisor: "the supervisor binary",
    core: "the core",
    modules: "modules",
    attn_security: "This is a security release.",
    attn_downgrade: "This goes back to an older version.",
    attn_disable: "add-on(s) are incompatible and will be disabled:",
    attn_blocked: "required add-on(s) are incompatible, the update is refused without --force:",
    attn_irreversible: "A migration cannot be reversed by a rollback:",
    attn_note: "The add-on check could not run completely:",
    attn_forced: "--force: required add-on(s) will be disabled anyway:",
};

const DE: Words = Words {
    update: "Update",
    security: "Sicherheits-Release",
    downgrade: "DOWNGRADE",
    source_feed: "signierter Release-Feed",
    source_bundle: "Offline-Bundle",
    download: "Download",
    unknown_size: "Größe nicht angegeben",
    restarts: "Neustart",
    restart_none: "nur der Daemon",
    new: "Neu",
    changed: "Geändert",
    fixed: "Behoben",
    attention: "Beachten",
    breaking: "Inkompatible Änderungen",
    todo: "Was zu tun ist",
    migrations: "Migrationen",
    reversible: ["umkehrbar", "NICHT umkehrbar", "Umkehrbarkeit nicht angegeben"],
    addons: "Add-ons",
    compatible: "kompatibel",
    incompatible: "inkompatibel",
    unknown: "unbekannt",
    will_disable: "wird für die neue Version deaktiviert",
    will_reenable: "wird wieder aktiviert",
    required: "erforderlich",
    rollback: "Rollback: Ein Snapshot von Binary, config.json, Installations-Manifest und Core bleibt erhalten (`plur1bus update --rollback`); der Memory-Speicher wird nie angefasst oder wiederhergestellt.",
    daemon: "der Daemon",
    supervisor: "die Supervisor-Binary",
    core: "der Core",
    modules: "Module",
    attn_security: "Dies ist ein Sicherheits-Release.",
    attn_downgrade: "Dies geht auf eine ältere Version zurück.",
    attn_disable: "Add-on(s) sind inkompatibel und werden deaktiviert:",
    attn_blocked: "erforderliche Add-on(s) sind inkompatibel, ohne --force wird das Update abgelehnt:",
    attn_irreversible: "Eine Migration lässt sich durch einen Rollback nicht rückgängig machen:",
    attn_note: "Die Add-on-Prüfung konnte nicht vollständig laufen:",
    attn_forced: "--force: erforderliche Add-on(s) werden trotzdem deaktiviert:",
};

fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::En => &EN,
        Lang::De => &DE,
    }
}

/// Builds the `update.plan/1` document body (the `schema` key is added by the output layer).
pub fn build(i: &Inputs, lang: Lang) -> Value {
    let w = words(lang);
    let doc = i.doc;
    let security = doc["security"].as_bool().unwrap_or(false);

    let migrations: Vec<Value> = doc["migrations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["id"].as_str().or_else(|| m.as_str())?;
            Some(json!({
                "id": id,
                "description": loc(&m["description"], lang),
                "reversible": m["reversible"].as_bool(),
            }))
        })
        .collect();
    let irreversible: Vec<String> = migrations
        .iter()
        .filter(|m| m["reversible"] == false)
        .filter_map(|m| m["id"].as_str().map(str::to_string))
        .collect();

    let breaking: Vec<Value> = doc["breaking"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| {
            let summary = loc(&b["summary"], lang).or_else(|| loc(b, lang))?;
            Some(json!({ "summary": summary, "action": loc(&b["action"], lang) }))
        })
        .collect();

    let groups = &doc["changes"];
    let mut attention = loc_list(groups.get("attention"), lang);
    if security {
        attention.push(w.attn_security.into());
    }
    if i.downgrade {
        attention.push(w.attn_downgrade.into());
    }
    let a = i.addons;
    if !a.disable.is_empty() {
        let list = a.disable.join(", ");
        if i.forced && !a.blocked.is_empty() {
            attention.push(format!("{} {}", w.attn_forced, a.blocked.join(", ")));
        } else if !a.blocked.is_empty() {
            attention.push(format!("{} {}", w.attn_blocked, a.blocked.join(", ")));
        }
        attention.push(format!("{} {}", w.attn_disable, list));
    }
    if !irreversible.is_empty() {
        attention.push(format!(
            "{} {}",
            w.attn_irreversible,
            irreversible.join(", ")
        ));
    }
    if let Some(n) = &a.note {
        attention.push(format!("{} {n}", w.attn_note));
    }

    let known: Option<u64> = i
        .downloads
        .iter()
        .try_fold(0u64, |acc, (_, b)| b.map(|b| acc.saturating_add(b)));
    let files: Vec<Value> = i
        .downloads
        .iter()
        .map(|(n, b)| json!({ "name": n, "bytes": b }))
        .collect();

    json!({
        "lang": lang.code(),
        "from": i.from,
        "to": i.to,
        "channel": i.channel,
        "kind": doc["kind"],
        "security": security,
        "date": doc["date"],
        "downgrade": i.downgrade,
        "source": if i.bundle { "bundle" } else { "feed" },
        "notes": {
            "summary": loc(&doc["notes"], lang),
            "new": loc_list(groups.get("new"), lang),
            "changed": loc_list(groups.get("changed"), lang),
            "fixed": loc_list(groups.get("fixed"), lang),
            "attention": attention,
        },
        "breaking": breaking,
        "changes": i.changes,
        "restart": {
            "daemon": true,
            "supervisor": i.supervisor_restart,
            "core": i.restart_core,
            "modules": i.restart_modules,
        },
        "migrations": migrations,
        "addons": {
            "compatible": a.count(Status::Compatible),
            "incompatible": a.count(Status::Incompatible),
            "unknown": a.count(Status::Unknown),
            "items": a.items,
            "willDisable": a.disable,
            "willReenable": a.reenable,
            "blocked": a.blocked,
            "forced": i.forced,
            "note": a.note,
        },
        "download": { "bytes": known, "known": known.is_some(), "files": files },
        "rollback": {
            "possible": true,
            "restores": ["binary", "config", "install-manifest", "core"],
            "keeps": ["memory-store"],
        },
    })
}

fn mib(b: u64) -> String {
    if b >= 1 << 20 {
        format!("{:.1} MiB", b as f64 / (1u64 << 20) as f64)
    } else {
        format!("{:.1} KiB", b as f64 / 1024.0)
    }
}

/// Renders a document built by [`build`] as text.
pub fn render(p: &Value, lang: Lang) -> String {
    let w = words(lang);
    let s = |v: &Value| v.as_str().unwrap_or("?").to_string();
    let mut out: Vec<String> = Vec::new();
    let mut head = format!(
        "{} {} -> {} ({})",
        w.update,
        s(&p["from"]),
        s(&p["to"]),
        s(&p["channel"])
    );
    if p["downgrade"] == true {
        head.push_str(&format!("  [{}]", w.downgrade));
    }
    if p["security"] == true {
        head.push_str(&format!("  [{}]", w.security));
    }
    out.push(head);
    out.push(
        if p["source"] == "bundle" {
            w.source_bundle
        } else {
            w.source_feed
        }
        .to_string(),
    );
    if let Some(sum) = p["notes"]["summary"].as_str() {
        out.push(String::new());
        out.push(sum.to_string());
    }
    let dl = match p["download"]["bytes"].as_u64() {
        Some(b) => mib(b),
        None => w.unknown_size.to_string(),
    };
    out.push(format!("{}: {dl}", w.download));

    let r = &p["restart"];
    let mut parts: Vec<String> = Vec::new();
    if r["supervisor"] == true {
        parts.push(w.supervisor.into());
    }
    if r["core"] == true {
        parts.push(w.core.into());
    }
    let mods: Vec<&str> = r["modules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !mods.is_empty() {
        parts.push(format!("{}: {}", w.modules, mods.join(", ")));
    }
    out.push(format!(
        "{}: {}",
        w.restarts,
        if parts.is_empty() {
            w.restart_none.to_string()
        } else {
            format!("{} ({})", w.daemon, parts.join(", "))
        }
    ));

    for (key, title) in [
        ("new", w.new),
        ("changed", w.changed),
        ("fixed", w.fixed),
        ("attention", w.attention),
    ] {
        let items: Vec<&str> = p["notes"][key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if !items.is_empty() {
            out.push(String::new());
            out.push(format!("{title}:"));
            out.extend(items.iter().map(|i| format!("  - {i}")));
        }
    }

    let breaking = p["breaking"].as_array().cloned().unwrap_or_default();
    if !breaking.is_empty() {
        out.push(String::new());
        out.push(format!("{}:", w.breaking));
        for b in &breaking {
            out.push(format!("  - {}", s(&b["summary"])));
            if let Some(a) = b["action"].as_str() {
                out.push(format!("    {}: {a}", w.todo));
            }
        }
    }

    let migrations = p["migrations"].as_array().cloned().unwrap_or_default();
    if !migrations.is_empty() {
        out.push(String::new());
        out.push(format!("{}:", w.migrations));
        for m in &migrations {
            let rev = match m["reversible"].as_bool() {
                Some(true) => w.reversible[0],
                Some(false) => w.reversible[1],
                None => w.reversible[2],
            };
            let d = m["description"]
                .as_str()
                .map(|d| format!(": {d}"))
                .unwrap_or_default();
            out.push(format!("  - {}{d} ({rev})", s(&m["id"])));
        }
    }

    let a = &p["addons"];
    let items = a["items"].as_array().cloned().unwrap_or_default();
    if !items.is_empty() {
        out.push(String::new());
        out.push(format!(
            "{}: {} {}, {} {}, {} {}",
            w.addons,
            a["compatible"],
            w.compatible,
            a["incompatible"],
            w.incompatible,
            a["unknown"],
            w.unknown
        ));
        for v in &items {
            let name = s(&v["name"]);
            let status = match v["status"].as_str() {
                Some("compatible") => w.compatible,
                Some("incompatible") => w.incompatible,
                _ => w.unknown,
            };
            let mut line = format!(
                "  - {name} ({} {}): {status}",
                s(&v["kind"]),
                s(&v["version"])
            );
            let listed = |k: &str| {
                a[k].as_array()
                    .into_iter()
                    .flatten()
                    .any(|n| n.as_str() == Some(name.as_str()))
            };
            if listed("willDisable") {
                line.push_str(&format!(" -> {}", w.will_disable));
            }
            if listed("willReenable") {
                line.push_str(&format!(" -> {}", w.will_reenable));
            }
            if v["required"] == true {
                line.push_str(&format!(" [{}]", w.required));
            }
            if let Some(d) = v["detail"].as_str() {
                line.push_str(&format!(" ({d})"));
            }
            out.push(line);
        }
    }
    out.push(String::new());
    out.push(w.rollback.to_string());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::addons::Verdict;

    fn doc() -> Value {
        json!({
            "version": "0.3.0", "kind": "minor", "security": true, "date": "2026-10-01",
            "notes": { "en": "Big release.", "de": "Großes Release." },
            "changes": {
                "new": [ { "en": "Dark mode", "de": "Dunkelmodus" }, "Plain" ],
                "changed": [ "Faster start" ],
                "fixed": [ { "en": "Crash on exit" } ],
                "attention": [ { "en": "Config key renamed", "de": "Konfigurationsschlüssel umbenannt" } ]
            },
            "breaking": [ { "summary": { "en": "RPC 2.0", "de": "RPC 2.0 (de)" }, "action": { "en": "Update clients" } } ],
            "migrations": [
                { "id": "store-v3", "description": "Re-index", "reversible": false },
                { "id": "cfg-v2", "reversible": true },
                { "id": "mystery" }
            ]
        })
    }

    fn addons() -> AddonPlan {
        let v = |n: &str, s: Status, en: bool, req: bool| Verdict {
            name: n.into(),
            kind: "module".into(),
            version: "1.0.0".into(),
            status: s,
            enabled: en,
            required: req,
            detail: (s == Status::Incompatible).then(|| "compat.harness: needs <0.3.0".into()),
            held_by_update: false,
        };
        AddonPlan {
            items: vec![
                v("ok-one", Status::Compatible, true, false),
                v("old-one", Status::Incompatible, true, true),
                v("who", Status::Unknown, true, false),
            ],
            disable: vec!["old-one".into()],
            reenable: vec![],
            blocked: vec!["old-one".into()],
            note: None,
        }
    }

    fn inputs<'a>(
        d: &'a Value,
        a: &'a AddonPlan,
        ch: &'a [Value],
        mods: &'a [String],
    ) -> Inputs<'a> {
        Inputs {
            doc: d,
            from: "0.2.0",
            to: "0.3.0",
            channel: "stable",
            downgrade: false,
            bundle: false,
            changes: ch,
            restart_core: true,
            restart_modules: mods,
            supervisor_restart: true,
            addons: a,
            downloads: vec![
                ("plur1bus".into(), Some(3 << 20)),
                ("core".into(), Some(1 << 20)),
            ],
            forced: false,
        }
    }

    #[test]
    fn the_document_has_every_part_of_the_plan() {
        let (d, a) = (doc(), addons());
        let mods = vec!["fixture".to_string()];
        let p = build(
            &inputs(&d, &a, &[json!({"unit":"binary"})], &mods),
            Lang::En,
        );
        assert_eq!(
            (p["from"].as_str(), p["to"].as_str()),
            (Some("0.2.0"), Some("0.3.0"))
        );
        assert_eq!(p["notes"]["summary"], "Big release.");
        assert_eq!(p["notes"]["new"], json!(["Dark mode", "Plain"]));
        assert_eq!(p["notes"]["fixed"], json!(["Crash on exit"]));
        assert_eq!(p["breaking"][0]["action"], "Update clients");
        assert_eq!(
            p["restart"],
            json!({"daemon":true,"supervisor":true,"core":true,"modules":["fixture"]})
        );
        assert_eq!(p["migrations"][0]["reversible"], false);
        assert_eq!(p["migrations"][1]["reversible"], true);
        assert!(p["migrations"][2]["reversible"].is_null());
        assert_eq!(p["addons"]["compatible"], 1);
        assert_eq!(p["addons"]["incompatible"], 1);
        assert_eq!(p["addons"]["unknown"], 1);
        assert_eq!(p["addons"]["willDisable"], json!(["old-one"]));
        assert_eq!(p["addons"]["blocked"], json!(["old-one"]));
        assert_eq!(
            p["download"],
            json!({"bytes": 4u64 << 20, "known": true, "files": [
            {"name":"plur1bus","bytes":3u64<<20},{"name":"core","bytes":1u64<<20}]})
        );
        let attn = p["notes"]["attention"].as_array().unwrap();
        let text = serde_json::to_string(attn).unwrap();
        for needle in [
            "Config key renamed",
            "security release",
            "old-one",
            "--force",
            "store-v3",
        ] {
            assert!(text.contains(needle), "{needle} missing in {text}");
        }
        assert_eq!(p["rollback"]["keeps"], json!(["memory-store"]));
    }

    #[test]
    fn the_text_names_everything_in_english() {
        let (d, a) = (doc(), addons());
        let mods = vec!["fixture".to_string()];
        let p = build(&inputs(&d, &a, &[], &mods), Lang::En);
        let t = render(&p, Lang::En);
        for needle in [
            "Update 0.2.0 -> 0.3.0 (stable)",
            "[security release]",
            "Download: 4.0 MiB",
            "Restarts: the daemon (the supervisor binary, the core, modules: fixture)",
            "New:\n  - Dark mode",
            "Fixed:\n  - Crash on exit",
            "Breaking changes:\n  - RPC 2.0\n    What to do: Update clients",
            "store-v3: Re-index (NOT reversible)",
            "cfg-v2 (reversible)",
            "mystery (reversibility not stated)",
            "Add-ons: 1 compatible, 1 incompatible, 1 unknown",
            "old-one (module 1.0.0): incompatible -> will be disabled for the new version [required]",
            "ok-one (module 1.0.0): compatible",
            "the memory store is never touched",
        ] {
            assert!(t.contains(needle), "{needle:?} missing in:\n{t}");
        }
    }

    #[test]
    fn german_uses_german_texts_and_falls_back_to_english() {
        let (d, a) = (doc(), addons());
        let p = build(&inputs(&d, &a, &[], &[]), Lang::De);
        let t = render(&p, Lang::De);
        for needle in [
            "Sicherheits-Release",
            "Großes Release.",
            "Dunkelmodus",
            "Neu:",
            "Behoben:\n  - Crash on exit",
            "Inkompatible Änderungen:\n  - RPC 2.0 (de)",
            "Was zu tun ist: Update clients",
            "NICHT umkehrbar",
            "inkompatibel -> wird für die neue Version deaktiviert [erforderlich]",
            "der Memory-Speicher wird nie angefasst",
        ] {
            assert!(t.contains(needle), "{needle:?} missing in:\n{t}");
        }
        assert_eq!(p["lang"], "de");
    }

    #[test]
    fn the_language_follows_the_locale_unless_told() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(
            Lang::from_locale(&env(&[("LANG", "de_DE.UTF-8")])),
            Lang::De
        );
        assert_eq!(
            Lang::from_locale(&env(&[("LC_ALL", "en_US.UTF-8"), ("LANG", "de_DE.UTF-8")])),
            Lang::En
        );
        assert_eq!(
            Lang::from_locale(&env(&[("LC_ALL", ""), ("LANG", "de")])),
            Lang::De
        );
        assert_eq!(Lang::from_locale(&env(&[])), Lang::En);
        assert_eq!(Lang::parse("DE"), Some(Lang::De));
        assert_eq!(Lang::parse("fr"), None);
    }

    #[test]
    fn a_bare_release_still_makes_a_plan_and_unknown_sizes_are_said() {
        let d = json!({ "version": "0.3.0", "channel": "stable", "minFromVersion": "0.1.0" });
        let a = AddonPlan::default();
        let mut i = inputs(&d, &a, &[], &[]);
        i.downloads = vec![("plur1bus".into(), None), ("core".into(), Some(10))];
        i.downgrade = true;
        i.bundle = true;
        let p = build(&i, Lang::En);
        assert_eq!(p["download"]["known"], false);
        let t = render(&p, Lang::En);
        assert!(t.contains("Download: size not stated"), "{t}");
        assert!(
            t.contains("[DOWNGRADE]") && t.contains("offline bundle"),
            "{t}"
        );
        assert!(!t.contains("Add-ons:"), "no add-ons, no section: {t}");
        assert!(!t.contains("Breaking"), "{t}");
    }
}
