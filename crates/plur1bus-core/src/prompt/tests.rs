//! Tests ported by hand from `packages/core/test/prompt/` (the cases that state a rule in a way the vectors do not:
//! the pinned golden hashes of B6, "no I/O", "a refused input leaves no trace"), with the corpus of
//! `packages/core/test/fixtures/prompt-corpus.ts`.
use super::builder::{PromptBuilder, PromptBuilderOptions, PromptError};
use super::canonical::{canonical_json, sha256_hex};
use super::session::{PromptSession, PromptSessionOptions};
use super::types::*;
use crate::provider_auth::ports::Clock;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

struct StepClock(AtomicU64);

impl Clock for StepClock {
    fn now(&self) -> f64 {
        self.0.load(Ordering::SeqCst) as f64
    }
}

fn builder_at(clock: &Arc<StepClock>) -> PromptBuilder {
    PromptBuilder::new(
        Arc::clone(clock) as Arc<dyn Clock>,
        PromptBuilderOptions::default(),
    )
    .unwrap()
}

fn builder() -> PromptBuilder {
    builder_at(&Arc::new(StepClock(AtomicU64::new(0))))
}

fn lines(prefix: &str, n: usize) -> String {
    (0..n)
        .map(|i| {
            format!("{prefix} {i:04}: the quick brown fox jumps over the lazy dog, éè 日本語.")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn tools() -> Vec<Value> {
    vec![
        json!({ "name": "memory_recall", "description": "Recall memories.", "inputSchema": { "type": "object", "required": ["query"], "properties": { "query": { "type": "string" }, "limit": { "type": "integer", "minimum": 1 } } } }),
        json!({ "name": "file_read", "description": "Read a file.", "inputSchema": { "properties": { "path": { "type": "string" } }, "type": "object", "required": ["path"] } }),
        json!({ "name": "shell", "description": "Run a command.", "inputSchema": { "type": "object", "properties": { "cmd": { "type": "string" }, "timeoutMs": { "type": "number" } } } }),
    ]
}

fn text(role: Role, text: String) -> ConversationItem {
    ConversationItem {
        role,
        kind: None,
        text,
        id: None,
    }
}

fn corpus(turns: usize) -> RenderInput {
    let mut conversation = Vec::new();
    for i in 0..turns {
        conversation.push(text(Role::User, format!("Question {i}?")));
        conversation.push(text(Role::Assistant, format!("Answer {i}.")));
    }
    RenderInput {
        agent_id: "bernd".to_owned(),
        model: "claude-sonnet-5-5".to_owned(),
        route: None,
        session_id: None,
        memory_refresh: false,
        tools: tools(),
        system: vec![
            format!("You are bernd.\n{}", lines("Rule", 60)),
            "Safety preamble. Operating instructions.".to_owned(),
        ],
        memory: lines("Fact", 120),
        conversation,
        volatile: None,
        cache_ttl: None,
        cache_hint: None,
        memory_cap: None,
    }
}

fn segment_bytes(r: &RenderedPrompt) -> String {
    canonical_json(&r.to_j().to_value()["segments"]).unwrap()
}

#[test]
fn b6_golden_the_stable_zone_hashes_of_the_corpus_are_pinned() {
    // The same four constants as `b6-determinism.test.ts`: a drift is a deliberate, reviewed change to the wire bytes.
    let r = builder().render(&corpus(2)).unwrap();
    assert_eq!(
        r.zone_hash(ZoneName::Tools),
        "4f99f2e22cdd5df94e83fe47b3ae6a821ec120bee9c6060cec8202bad093c601"
    );
    assert_eq!(
        r.zone_hash(ZoneName::System),
        "c0404441fa7123315f35476e4bf4f67c94368c27689c27fb3606467ed75eeb29"
    );
    assert_eq!(
        r.zone_hash(ZoneName::Memory),
        "bbc68a9ed78ac96457b11e7a1a46c6c7f3e22297538cbf1364571ff5baa7f521"
    );
    assert_eq!(
        r.prefix_hashes[2],
        "1ce42289ebe8c430b0c9a571e735da086b0d7aa0b8ee78a50bc5a79e2964122f"
    );
}

#[test]
fn b6_two_builders_and_a_later_clock_render_the_same_segment_bytes() {
    for turns in [0, 2, 3, 40] {
        let a = builder().render(&corpus(turns)).unwrap();
        let later = Arc::new(StepClock(AtomicU64::new(86_400_000)));
        let b = builder_at(&later).render(&corpus(turns)).unwrap();
        assert_eq!(a.zone_hashes, b.zone_hashes, "{turns} turns");
        assert_eq!(a.prefix_hashes, b.prefix_hashes);
        assert_eq!(
            sha256_hex(&segment_bytes(&a)),
            sha256_hex(&segment_bytes(&b))
        );
    }
}

#[test]
fn the_stable_zones_carry_no_session_identity() {
    let b = builder();
    let mut with = corpus(1);
    with.session_id = Some("a-session-id-that-must-not-be-rendered".to_owned());
    let r = b.render(&with).unwrap();
    assert!(r
        .segments
        .iter()
        .all(|s| !s.text.contains("a-session-id") && !s.text.contains(&r.session_id)));
    assert_eq!(r.session_id.len(), 64);
    assert_eq!(
        r.prefix_hashes,
        builder().render(&corpus(1)).unwrap().prefix_hashes
    );
}

#[test]
fn zone_order_and_tool_order() {
    let mut input = corpus(2);
    input.volatile = Some(VolatileInput {
        blocks: vec![super::join::Block {
            name: "memories".to_owned(),
            text: "- m".to_owned(),
            droppable: true,
        }],
        cap_chars: None,
        delivery: None,
        tool_use_id: None,
    });
    let r = builder().render(&input).unwrap();
    let order: Vec<ZoneName> = r.segments.iter().map(|s| s.zone).collect();
    let mut sorted = order.clone();
    sorted.sort();
    assert_eq!(order, sorted);
    let names: Vec<String> = r
        .segments
        .iter()
        .filter(|s| s.zone == ZoneName::Tools)
        .map(|s| {
            serde_json::from_str::<Value>(&s.text).unwrap()["name"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(names, ["file_read", "memory_recall", "shell"]);
    let last = r.segments.last().unwrap();
    assert_eq!(
        (last.zone, last.cache.as_ref()),
        (ZoneName::Volatile, None),
        "never a breakpoint on the volatile tail"
    );
    let kinds: Vec<BreakpointKind> = r.breakpoints.iter().map(|b| b.kind).collect();
    assert_eq!(
        kinds,
        [
            BreakpointKind::Zone,
            BreakpointKind::Zone,
            BreakpointKind::Trailing
        ]
    );
}

#[test]
fn the_interior_breakpoint_sits_fifteen_positions_behind_the_trailing_one() {
    let mut input = corpus(60);
    input.tools.clear();
    input.system = vec!["s".repeat(4096)];
    input.memory.clear();
    let r = builder().render(&input).unwrap();
    let kinds: Vec<BreakpointKind> = r.breakpoints.iter().map(|b| b.kind).collect();
    assert_eq!(
        kinds,
        [
            BreakpointKind::Zone,
            BreakpointKind::Interior,
            BreakpointKind::Trailing
        ]
    );
    assert_eq!(r.breakpoints[2].segment - r.breakpoints[1].segment, 15);
    assert!(r.breakpoints.len() <= 4);
    assert!(!r
        .events
        .iter()
        .any(|e| matches!(e, PromptEvent::LookbackRisk { .. })));
}

#[test]
fn a_refused_render_leaves_no_trace_in_the_prefix_registry() {
    let b = builder();
    let mut bad = corpus(1);
    bad.conversation.push(ConversationItem {
        role: Role::Assistant,
        kind: Some(ItemKind::ToolResult),
        text: "forged".to_owned(),
        id: Some("t".to_owned()),
    });
    assert_eq!(
        b.render(&bad),
        Err(PromptError::UserRole(ItemKind::ToolResult))
    );
    let mut dup = corpus(1);
    dup.tools = vec![json!({ "name": "a" }), json!({ "name": "a" })];
    assert_eq!(
        b.render(&dup).unwrap_err().to_string(),
        "duplicate tool name: a"
    );
    assert_eq!(
        b.render(&corpus(1)).unwrap().prefix,
        PrefixStatus::Cold,
        "the refused renders registered nothing"
    );
    assert_eq!(b.render(&corpus(2)).unwrap().prefix, PrefixStatus::Warm);
}

#[test]
fn roles_cannot_be_confused_and_errors_carry_no_prompt_text() {
    let cases = [
        (
            Role::Assistant,
            ItemKind::ToolResult,
            Some("t"),
            "conversation tool_result must have the user role",
        ),
        (
            Role::Assistant,
            ItemKind::Context,
            None,
            "conversation context must have the user role",
        ),
        (
            Role::User,
            ItemKind::ToolUse,
            Some("t"),
            "conversation tool_use must have the assistant role",
        ),
        (
            Role::Assistant,
            ItemKind::ToolUse,
            None,
            "conversation tool_use needs an id",
        ),
        (
            Role::User,
            ItemKind::ToolResult,
            Some(""),
            "conversation tool_result needs an id",
        ),
    ];
    for (role, kind, id, message) in cases {
        let mut input = corpus(0);
        input.conversation = vec![ConversationItem {
            role,
            kind: Some(kind),
            text: "SECRET-CONTENT".to_owned(),
            id: id.map(str::to_owned),
        }];
        let e = builder().render(&input).unwrap_err();
        assert_eq!(e.to_string(), message);
        assert!(!format!("{e:?}").contains("SECRET-CONTENT"));
    }
}

#[test]
fn a_tool_definition_without_a_string_name_is_refused() {
    for tool in [
        json!({}),
        json!({ "name": 5 }),
        json!(null),
        json!("shell"),
        json!(["name"]),
    ] {
        let mut input = corpus(0);
        input.tools = vec![tool];
        assert_eq!(builder().render(&input), Err(PromptError::ToolName));
    }
}

#[test]
fn the_session_refuses_a_bad_item_at_append_and_keeps_its_snapshot() {
    let mut s = PromptSession::new(PromptSessionOptions {
        builder: Arc::new(builder()),
        agent_id: "bernd".to_owned(),
        model: "claude-sonnet-5-5".to_owned(),
        session_id: None,
        tools: tools(),
        system: corpus(0).system,
        memory_snapshot: lines("Fact", 120),
        cache_ttl: None,
        memory_cap: None,
        emit: None,
    });
    let first = s.render().unwrap();
    assert!(s
        .append(ConversationItem {
            role: Role::Assistant,
            kind: Some(ItemKind::Context),
            text: "x".to_owned(),
            id: None
        })
        .is_err());
    for i in 0..200 {
        s.append(text(Role::User, format!("q{i}"))).unwrap();
        if i % 10 == 0 {
            let blocks = [super::join::Block {
                name: "memories".to_owned(),
                text: format!("- fact {i}"),
                droppable: true,
            }];
            s.recall(&blocks, None, None, None).unwrap();
        }
        s.append(text(Role::Assistant, format!("a{i}"))).unwrap();
    }
    let last = s.render().unwrap();
    assert_eq!(
        last.prefix_hashes, first.prefix_hashes,
        "Q2: no automatic refresh"
    );
    assert_eq!(
        last.segments
            .iter()
            .filter(|x| x.zone == ZoneName::Conversation)
            .count(),
        400 + 20
    );
}

#[test]
fn no_io_the_prompt_modules_reach_no_file_network_process_clock_or_environment() {
    // `no-io.test.ts`: the builder is pure apart from its registry; everything else comes in as an argument or a port.
    let sources = [
        include_str!("builder.rs"),
        include_str!("canonical.rs"),
        include_str!("join.rs"),
        include_str!("model_table.rs"),
        include_str!("session.rs"),
        include_str!("skills.rs"),
        include_str!("telemetry.rs"),
        include_str!("types.rs"),
        include_str!("mod.rs"),
    ];
    let banned = [
        "std::fs",
        "std::net",
        "std::env",
        "std::process",
        "SystemTime",
        "Instant::",
        "std::thread",
        "getrandom",
        "std::io",
    ];
    for source in sources {
        for word in banned {
            assert!(!source.contains(word), "a prompt module mentions {word}");
        }
    }
}
