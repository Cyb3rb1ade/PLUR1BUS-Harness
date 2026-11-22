use super::*;
use serde_json::{json, Value};
use std::collections::VecDeque;

struct Lists {
    pages: VecDeque<Page>,
    calls: Vec<Value>,
}
impl Listing for Lists {
    fn page(&mut self, since: i64, until: f64, limit: usize) -> R<Page> {
        self.calls
            .push(json!({"since":since,"until":until,"limit":limit}));
        self.pages.pop_front().ok_or_else(invalid)
    }
}
struct Stats {
    reply: Option<Statistics>,
    calls: Vec<Value>,
}
impl Recall for Stats {
    fn statistics(&mut self, agent: &str, ids: &[&str]) -> R<Statistics> {
        self.calls.push(json!({"agentId":agent,"ids":ids}));
        self.reply.take().ok_or_else(invalid)
    }
}

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/dreams/source.json"
    ))
    .unwrap()
}

#[test]
fn source_listing_is_scoped_and_refuses_incomplete_pages() {
    for row in fixture()["listings"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let pages: VecDeque<Page> = serde_json::from_value(row["pages"].clone()).unwrap();
        let mut list = Lists {
            pages,
            calls: vec![],
        };
        let result = if name.starts_with("projection") {
            project(list.pages.pop_front().unwrap())
        } else {
            read(&mut list, 100)
        };
        let actual = match result {
            Ok(entries) => json!({"entries":entries,"calls":list.calls}),
            Err(_) => json!({"refused":true,"calls":list.calls}),
        };
        assert!(
            crate::toolcall::json::V::from_serde(&actual)
                .deep_equal(&crate::toolcall::json::V::from_serde(&row["expected"])),
            "{name}: {actual} vs {}",
            row["expected"]
        );
    }
}

#[test]
fn signals_require_measured_requested_agent_and_id() {
    for row in fixture()["signals"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let items: Vec<CandidateInput> = serde_json::from_value(row["items"].clone()).unwrap();
        let mut stats = Stats {
            reply: Some(serde_json::from_value(row["reply"].clone()).unwrap()),
            calls: vec![],
        };
        let port = (name != "old capability").then_some(&mut stats as &mut dyn Recall);
        let result = signals("alpha", items, port);
        let actual = match result {
            Ok(entries) => json!({"entries":entries,"calls":stats.calls}),
            Err(_) => json!({"refused":true,"calls":stats.calls}),
        };
        assert!(
            crate::toolcall::json::V::from_serde(&actual)
                .deep_equal(&crate::toolcall::json::V::from_serde(&row["expected"])),
            "{name}: {actual} vs {}",
            row["expected"]
        );
    }
}
