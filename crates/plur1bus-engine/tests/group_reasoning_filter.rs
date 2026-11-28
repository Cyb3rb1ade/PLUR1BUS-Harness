use plur1bus_engine::group_reasoning_filter::*;

fn decide(
    chat: ChatKind,
    text: &str,
    sender: Option<&str>,
    allow_from: &[&str],
    group_allow_from: &[&str],
) -> Decision {
    classify(&Input {
        chat,
        enabled: true,
        bodies: &[text],
        sender,
        allow_from,
        group_allow_from,
        prefixes: &[],
    })
}

#[test]
fn only_group_reasoning_at_the_start_is_filtered() {
    assert_eq!(
        decide(ChatKind::Direct, "🧠 thought", None, &[], &[]),
        Decision::Pass
    );
    assert_eq!(
        decide(ChatKind::Group, "I saw <think> as text", None, &[], &[]),
        Decision::Pass
    );
    for text in [
        " 🧠 draft",
        "[Bot]: <THINK>...",
        "Bot: 💭 draft",
        "reasoning: draft",
        "Thinking: draft",
        "<THINKING>draft",
    ] {
        assert!(
            matches!(
                decide(ChatKind::Group, text, None, &[], &[]),
                Decision::Ignore { sender_hash: None }
            ),
            "{text}"
        );
    }
}

#[test]
fn only_an_exact_single_sender_entry_exempts_the_sender() {
    let who = Some("sender-42");
    assert_eq!(
        decide(ChatKind::Group, "💭 thought", who, &["sender-42"], &[]),
        Decision::Pass
    );
    assert_eq!(
        decide(ChatKind::Group, "💭 thought", who, &[], &["sender-42"]),
        Decision::Pass
    );
    for (sender, list) in [
        (who, &["sender-4"][..]),
        (who, &["*", "sender-*"][..]),
        (Some("*"), &["*"][..]),
    ] {
        assert!(matches!(
            decide(ChatKind::Group, "💭 thought", sender, list, list),
            Decision::Ignore {
                sender_hash: Some(_)
            }
        ));
    }
}

#[test]
fn only_a_hit_carries_a_sender_hash() {
    let who = Some("sender-42");
    assert_eq!(
        decide(ChatKind::Group, "hello", who, &[], &[]),
        Decision::Pass
    );
    let result = decide(ChatKind::Group, "thinking: draft", who, &[], &[]);
    assert_eq!(result, decide(ChatKind::Group, "💭 draft", who, &[], &[]));
    let Decision::Ignore {
        sender_hash: Some(hash),
    } = result
    else {
        unreachable!()
    };
    assert_eq!(
        hash,
        "2f271d6f0d823b5eacdd05527b97828088f294458f3bc28d42d763d1de3fcd64"
    );
}

#[test]
fn configured_prefixes_and_disable_are_respected() {
    let input = Input {
        chat: ChatKind::Group,
        enabled: true,
        bodies: &["normal header", "[Bot]: Reason trace: notes"],
        sender: None,
        allow_from: &[],
        group_allow_from: &[],
        prefixes: &[" REASON TRACE: "],
    };
    assert_eq!(classify(&input), Decision::Ignore { sender_hash: None });
    assert_eq!(
        classify(&Input {
            enabled: false,
            ..input
        }),
        Decision::Pass
    );
}

#[test]
fn transport_labels_match_the_pinned_group_filter_grammar() {
    let symbols = "🛠".repeat(40);
    let plain = "🛠".repeat(30);
    for (body, ignored) in [
        (format!("[{symbols}]: <THINK>note"), true),
        (format!("[{symbols}x]: <THINK>note"), false),
        (format!("x{plain}: <THINK>note"), true),
        (format!("xx{plain}: <THINK>note"), false),
        ("[Studio] Bot: <THINK>note".into(), true),
        ("Bot:\u{00a0}<THINK>note".into(), true),
        ("Bot:<THINK>note".into(), false),
        (": <THINK>note".into(), false),
        ("[]: <THINK>note".into(), true),
        ("First\nLast: <THINK>note".into(), false),
        ("[First\nLast]: <THINK>note".into(), false),
        ("Bot: Other: <THINK>note".into(), false),
    ] {
        let expected = if ignored {
            Decision::Ignore { sender_hash: None }
        } else {
            Decision::Pass
        };
        assert_eq!(
            decide(ChatKind::Group, &body, None, &[], &[]),
            expected,
            "{body:?}"
        );
    }
}

#[test]
fn custom_prefixes_replace_defaults_and_keep_empty_inputs_ordinary() {
    let input = Input {
        chat: ChatKind::Group,
        enabled: true,
        bodies: &["\u{00a0}REASON TRACE:note"],
        sender: Some(" \u{00a0} "),
        allow_from: &[],
        group_allow_from: &[],
        prefixes: &[" REASON TRACE: "],
    };
    assert_eq!(classify(&input), Decision::Ignore { sender_hash: None });
    assert_eq!(
        classify(&Input {
            bodies: &["🧠 text"],
            ..input
        }),
        Decision::Pass
    );
    assert_eq!(
        classify(&Input {
            bodies: &["🧠 text"],
            prefixes: &[" \u{00a0} "],
            ..input
        }),
        Decision::Pass
    );
    assert_eq!(
        classify(&Input {
            bodies: &[""],
            ..input
        }),
        Decision::Pass
    );
}
