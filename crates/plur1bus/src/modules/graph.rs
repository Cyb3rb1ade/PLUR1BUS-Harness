//! The module dependency graph (`module graph`, spec §6.6) and the supervisor's start order.
//! `needs` names modules or `core`; `consumes` names capabilities, resolved to the core
//! (`CORE_PROVIDES`) and to every valid module that `provides` them.
use super::manifest::{Installed, Manifest, CORE_PROVIDES};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// D14 priority bands, 100 wide; 500–999 is one band.
pub fn band(priority: u16) -> &'static str {
    match priority {
        0..=99 => "foundation",
        100..=199 => "core-services",
        200..=299 => "services",
        300..=399 => "aggregators",
        400..=499 => "orchestration",
        _ => "add-ons",
    }
}

/// `nodes`: the core first, then every installed module in scan order. `edges`: `{from, to, kind:
/// "needs"}` and `{from, to, kind: "consumes", capability}`. `cycles`: each needs-cycle's members,
/// sorted. `unresolved`: `{from, kind: "needs", name}` (a missing or invalid module) and `{from,
/// kind: "consumes", capability}` (no provider). Only valid modules contribute edges.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Graph {
    pub nodes: Vec<Value>,
    pub edges: Vec<Value>,
    pub cycles: Vec<Vec<String>>,
    pub unresolved: Vec<Value>,
}

const CORE: &str = "core";

fn valid(mods: &[Installed]) -> BTreeMap<&str, &Manifest> {
    mods.iter()
        .filter_map(|m| m.manifest.as_ref().ok().map(|x| (m.name.as_str(), x)))
        .collect()
}

/// Needs-edges between valid modules (the core is always there, so it takes no part in cycles).
fn module_needs<'a>(m: &'a Manifest, valid: &BTreeMap<&str, &Manifest>) -> Vec<&'a str> {
    m.needs
        .iter()
        .map(String::as_str)
        .filter(|n| valid.contains_key(n))
        .collect()
}

fn needs_cycles(valid: &BTreeMap<&str, &Manifest>) -> Vec<Vec<String>> {
    // Small graphs: reachability per node, then a strongly connected component is the set of
    // nodes that reach each other; a node is in a cycle when it reaches itself.
    let reach: BTreeMap<&str, BTreeSet<&str>> = valid
        .keys()
        .map(|&start| {
            let mut seen = BTreeSet::new();
            let mut stack: Vec<&str> = module_needs(valid[start], valid);
            while let Some(n) = stack.pop() {
                if seen.insert(n) {
                    stack.extend(module_needs(valid[n], valid));
                }
            }
            (start, seen)
        })
        .collect();
    let mut cycles = BTreeSet::new();
    for (&u, r) in &reach {
        if r.contains(u) {
            let scc: Vec<String> = r
                .iter()
                .filter(|v| reach[*v].contains(u))
                .map(|v| v.to_string())
                .collect();
            cycles.insert(scc);
        }
    }
    cycles.into_iter().collect()
}

pub fn graph(mods: &[Installed]) -> Graph {
    let valid = valid(mods);
    let mut nodes = vec![
        json!({ "name": CORE, "version": null, "priority": null, "band": null,
        "scope": "installation", "extensionPoints": {}, "valid": true }),
    ];
    for m in mods {
        nodes.push(match &m.manifest {
            Ok(x) => json!({ "name": x.name, "version": x.version, "priority": x.priority,
                "band": band(x.priority), "scope": x.scope, "extensionPoints": x.extension_points,
                "valid": true }),
            Err(_) => json!({ "name": m.name, "version": null, "priority": null, "band": null,
                "scope": null, "extensionPoints": {}, "valid": false }),
        });
    }
    let mut edges = Vec::new();
    let mut unresolved = Vec::new();
    for m in mods {
        let Ok(x) = &m.manifest else { continue };
        for n in &x.needs {
            if n == CORE || valid.contains_key(n.as_str()) {
                edges.push(json!({ "from": x.name, "to": n, "kind": "needs" }));
            } else {
                unresolved.push(json!({ "from": x.name, "kind": "needs", "name": n }));
            }
        }
        for c in &x.consumes {
            let mut providers: Vec<&str> = Vec::new();
            if CORE_PROVIDES.contains(&c.as_str()) {
                providers.push(CORE);
            }
            providers.extend(
                valid
                    .iter()
                    .filter(|(name, p)| **name != x.name && p.provides.contains(c))
                    .map(|(name, _)| *name),
            );
            if providers.is_empty() {
                unresolved.push(json!({ "from": x.name, "kind": "consumes", "capability": c }));
            }
            for p in providers {
                edges.push(json!({ "from": x.name, "to": p, "kind": "consumes", "capability": c }));
            }
        }
    }
    Graph {
        nodes,
        edges,
        cycles: needs_cycles(&valid),
        unresolved,
    }
}

/// The modules the supervisor starts, in order: valid, not in a needs-cycle, and every `needs`
/// resolved to the core or to a module that is itself startable. Topological (needs first), ties
/// by priority, then by name. An unresolved `consumes` does not hold a module back.
pub fn start_order(mods: &[Installed]) -> Vec<String> {
    let valid = valid(mods);
    let in_cycle: BTreeSet<String> = needs_cycles(&valid).into_iter().flatten().collect();
    let mut ok: BTreeSet<&str> = valid
        .keys()
        .copied()
        .filter(|n| !in_cycle.contains(*n))
        .collect();
    loop {
        let blocked: Vec<&str> = ok
            .iter()
            .copied()
            .filter(|n| {
                valid[n]
                    .needs
                    .iter()
                    .any(|d| d != CORE && !ok.contains(d.as_str()))
            })
            .collect();
        if blocked.is_empty() {
            break;
        }
        for b in blocked {
            ok.remove(b);
        }
    }
    let mut pending: BTreeMap<&str, usize> = ok
        .iter()
        .map(|&n| (n, module_needs(valid[n], &valid).len()))
        .collect();
    let mut ready: BTreeSet<(u16, &str)> = pending
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(n, _)| (valid[n].priority, *n))
        .collect();
    let mut order = Vec::with_capacity(ok.len());
    while let Some((_, n)) = ready.pop_first() {
        order.push(n.to_string());
        for &v in &ok {
            if valid[v].needs.iter().any(|d| d == n) {
                let d = pending.get_mut(v).expect("pending entry");
                *d -= 1;
                if *d == 0 {
                    ready.insert((valid[v].priority, v));
                }
            }
        }
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::manifest::parse_manifest;
    use serde_json::json;
    use std::path::PathBuf;

    fn module(name: &str, priority: u16, extra: Value) -> Installed {
        let mut m = json!({ "name": name, "version": "0.1.0", "apiVersion": "1", "entry": "index.js",
            "scope": "installation", "priority": priority });
        m.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        Installed {
            name: name.into(),
            dir: PathBuf::from("modules").join(name),
            manifest: Ok(parse_manifest(&m.to_string()).expect("test manifest is valid")),
        }
    }
    fn invalid(name: &str) -> Installed {
        Installed {
            name: name.into(),
            dir: PathBuf::from("modules").join(name),
            manifest: Err(vec!["manifest-missing".into()]),
        }
    }

    #[test]
    fn band_boundaries() {
        for (p, b) in [
            (0, "foundation"),
            (99, "foundation"),
            (100, "core-services"),
            (199, "core-services"),
            (200, "services"),
            (299, "services"),
            (300, "aggregators"),
            (399, "aggregators"),
            (400, "orchestration"),
            (499, "orchestration"),
            (500, "add-ons"),
            (999, "add-ons"),
        ] {
            assert_eq!(band(p), b, "priority {p}");
        }
    }

    #[test]
    fn needs_cycle_is_reported_and_excluded_from_start_order() {
        let mods = [
            module("a", 100, json!({ "needs": ["b"] })),
            module("b", 100, json!({ "needs": ["a", "core"] })),
            module("c", 100, json!({ "needs": ["a"] })),
            module("d", 500, json!({})),
            module("e", 100, json!({ "needs": ["e"] })),
        ];
        let g = graph(&mods);
        assert_eq!(g.cycles, vec![vec!["a", "b"], vec!["e"]]);
        assert_eq!(start_order(&mods), ["d"]);
    }

    #[test]
    fn unresolved_needs_blocks_unresolved_consumes_is_listed() {
        let mods = [
            module("a", 100, json!({ "needs": ["missing"] })),
            module("b", 100, json!({ "consumes": ["nobody-provides-this"] })),
            module("c", 100, json!({ "needs": ["broken"] })),
            module("d", 100, json!({ "needs": ["a"] })),
            invalid("broken"),
        ];
        let g = graph(&mods);
        assert_eq!(
            g.unresolved,
            vec![
                json!({ "from": "a", "kind": "needs", "name": "missing" }),
                json!({ "from": "b", "kind": "consumes", "capability": "nobody-provides-this" }),
                json!({ "from": "c", "kind": "needs", "name": "broken" }),
            ]
        );
        assert_eq!(
            g.edges,
            vec![json!({ "from": "d", "to": "a", "kind": "needs" })]
        );
        assert!(g.cycles.is_empty());
        assert_eq!(start_order(&mods), ["b"], "a, c and (through a) d stay out");
    }

    #[test]
    fn consumes_memory_resolves_to_core() {
        let mods = [
            module(
                "fixture",
                500,
                json!({ "needs": ["core"], "consumes": ["memory", "search"],
                "extensionPoints": { "collect-status": "collect" } }),
            ),
            module("search", 200, json!({ "provides": ["search"] })),
            invalid("zz-broken"),
        ];
        let g = graph(&mods);
        assert_eq!(
            g.edges,
            vec![
                json!({ "from": "fixture", "to": "core", "kind": "needs" }),
                json!({ "from": "fixture", "to": "core", "kind": "consumes", "capability": "memory" }),
                json!({ "from": "fixture", "to": "search", "kind": "consumes", "capability": "search" }),
            ]
        );
        assert!(g.unresolved.is_empty());
        assert_eq!(
            g.nodes,
            vec![
                json!({ "name": "core", "version": null, "priority": null, "band": null,
                    "scope": "installation", "extensionPoints": {}, "valid": true }),
                json!({ "name": "fixture", "version": "0.1.0", "priority": 500, "band": "add-ons",
                    "scope": "installation", "extensionPoints": { "collect-status": "collect" }, "valid": true }),
                json!({ "name": "search", "version": "0.1.0", "priority": 200, "band": "services",
                    "scope": "installation", "extensionPoints": {}, "valid": true }),
                json!({ "name": "zz-broken", "version": null, "priority": null, "band": null,
                    "scope": null, "extensionPoints": {}, "valid": false }),
            ]
        );
    }

    #[test]
    fn start_order_is_topological_then_priority_then_name() {
        let mods = [
            module("api", 100, json!({ "needs": ["store", "core"] })),
            module("beta", 100, json!({})),
            module("alpha", 100, json!({})),
            module("store", 500, json!({})),
            module("ui", 0, json!({ "needs": ["api"] })),
            invalid("broken"),
        ];
        assert_eq!(start_order(&mods), ["alpha", "beta", "store", "api", "ui"]);
    }
}
