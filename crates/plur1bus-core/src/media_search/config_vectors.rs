use super::*;
use serde_json::json;
use std::cell::RefCell;

struct Fixture<'a> {
    name: &'a str,
    calls: RefCell<Vec<Value>>,
}
impl Catalog for Fixture<'_> {
    fn lookup(&self, provider: &str, model: &str) -> Option<Model> {
        self.calls
            .borrow_mut()
            .push(json!(["lookup", provider, model]));
        if provider == "fixture-cloud" && model == "test" {
            return serde_json::from_value(json!({
                "local":false,"capabilities":{"text":true,"image":true,"audio":false,"video":false},
                "licence":{"id":"fixture-licence","nonCommercial":true},"dimensions":[8,16]
            }))
            .ok();
        }
        builtin_model(provider, model)
    }
    fn licence_accepted(&self, model: &str) -> bool {
        self.calls.borrow_mut().push(json!(["licence", model]));
        self.name != "licence"
    }
    fn available(&self, provider: &str, model: &str) -> bool {
        self.calls
            .borrow_mut()
            .push(json!(["available", provider, model]));
        self.name != "unavailable"
    }
}

#[test]
fn catalog_legacy_load_and_validation_match_typescript() {
    let f: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/media/config.json"
    ))
    .unwrap();
    assert_eq!(builtin_catalog(), &f["catalog"]);
    for row in f["load"].as_array().unwrap() {
        assert_eq!(for_load(&row["before"]), row["after"]);
    }
    for row in f["validate"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let catalog = Fixture {
            name,
            calls: RefCell::new(Vec::new()),
        };
        let selection = serde_json::from_value(row["cfg"].clone()).unwrap();
        let output = if row["section"] == "caption" {
            caption(&selection, &catalog, name == "pinned")
        } else {
            embedding(&selection, &catalog, name == "pinned")
        };
        assert_eq!(
            output.map_or_else(|e| e.code, |()| "ok"),
            row["outcome"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(json!(catalog.calls.into_inner()), row["calls"], "{name}");
    }
}
