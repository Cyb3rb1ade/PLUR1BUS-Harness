#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture checks")]

use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use plur1bus_documents::chromium::{Client, Control, Error, Result, Transport};
use serde_json::{json, Value};

struct Fixture {
    commands: Vec<Value>,
    responses: VecDeque<String>,
}

impl Transport for Fixture {
    fn send(&mut self, text: &str, _deadline: Instant) -> Result<()> {
        let wire: Value = serde_json::from_str(text).unwrap();
        let id = wire["id"].clone();
        let command = json!({"method":wire["method"],"params":wire["params"]});
        let result = match wire["method"].as_str().unwrap() {
            "Page.printToPDF" => json!({"data":"JVBERi0xLjcKZml4dHVyZQ=="}),
            "Page.captureScreenshot" => json!({"data":"iVBORw0KGgo="}),
            "Runtime.evaluate" if wire["params"]["expression"] == "document.readyState" => {
                json!({"result":{"value":"complete"}})
            }
            "Runtime.evaluate" => json!({"result":{"value":1500}}),
            _ => json!({}),
        };
        self.responses
            .push_back(json!({"method":"Page.lifecycleEvent","params":{}}).to_string());
        self.responses
            .push_back(json!({"id":id,"result":result}).to_string());
        self.commands.push(command);
        Ok(())
    }

    fn receive(&mut self, _deadline: Instant) -> Result<String> {
        self.responses.pop_front().ok_or(Error::Protocol)
    }

    fn wait(&mut self, delay: Duration, _deadline: Instant) -> Result<()> {
        assert_eq!(delay, Duration::from_millis(50));
        Ok(())
    }
}

#[test]
fn pdf_and_screenshot_commands_replay_the_typescript_cdp_contract() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/documents/cdp.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut port = Fixture {
            commands: Vec::new(),
            responses: VecDeque::new(),
        };
        let cancelled = || name == "cancelled";
        let mut client = Client::new(
            &mut port,
            Control {
                deadline: Instant::now() + Duration::from_secs(5),
                cancelled: &cancelled,
            },
        );
        let result = match name {
            "pdf" | "cancelled" => client.print_pdf(),
            "screenshot" => client.screenshot(),
            "full-page" => client.screenshot_full(),
            _ => panic!("unknown fixture"),
        };
        let actual = match result {
            Ok(bytes) => json!({ "bytes": bytes }),
            Err(Error::Cancelled) => json!({ "error": "cancelled" }),
            Err(error) => panic!("{error:?}"),
        };
        assert_eq!(actual, case["expected"], "{name}");
        assert_eq!(json!(port.commands), case["commands"], "{name}");
    }
}

#[test]
fn navigation_waits_for_the_document_and_fonts_under_one_deadline() {
    let mut port = Fixture {
        commands: Vec::new(),
        responses: VecDeque::new(),
    };
    let mut client = Client::new(
        &mut port,
        Control {
            deadline: Instant::now() + Duration::from_secs(5),
            cancelled: &|| false,
        },
    );
    client.navigate("file:///fixture/document.html").unwrap();
    assert_eq!(
        port.commands
            .iter()
            .map(|command| command["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "Page.enable",
            "Page.navigate",
            "Runtime.evaluate",
            "Runtime.evaluate"
        ]
    );
    assert_eq!(
        port.commands[1]["params"]["url"],
        "file:///fixture/document.html"
    );
    assert_eq!(port.commands[3]["params"]["awaitPromise"], true);

    let mut port = Fixture {
        commands: Vec::new(),
        responses: VecDeque::new(),
    };
    let mut expired = Client::new(
        &mut port,
        Control {
            deadline: Instant::now(),
            cancelled: &|| false,
        },
    );
    assert_eq!(expired.print_pdf(), Err(Error::Timeout));
    assert!(port.commands.is_empty());
}

#[test]
fn navigation_rejects_unowned_schemes_before_sending_commands() {
    let mut port = Fixture {
        commands: Vec::new(),
        responses: VecDeque::new(),
    };
    let mut client = Client::new(
        &mut port,
        Control {
            deadline: Instant::now() + Duration::from_secs(2),
            cancelled: &|| false,
        },
    );
    assert_eq!(
        client.navigate("https://example.invalid/fixture"),
        Err(Error::Protocol)
    );
    assert!(port.commands.is_empty());
}
