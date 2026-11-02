//! Verbatim prompt constants from the immutable Node pin 9f34008c.

pub(super) const HINTS: &[(&str, &str)] = &[
    (
        "new_session",
        r#"This appears to be the first user-visible turn in this session."#,
    ),
    (
        "immediate",
        r#"Continue naturally; the conversation is ongoing."#,
    ),
    (
        "recent",
        r#"Continue naturally; only a short pause has occurred."#,
    ),
    (
        "same_day",
        r#"The user may expect continuation without a full recap."#,
    ),
    (
        "overnight",
        r#"Briefly re-anchor the task before proceeding."#,
    ),
    (
        "multi_day",
        r#"A longer gap has passed; a brief recap may help."#,
    ),
    (
        "stale",
        concat!(
            "Treat old assumptions as potentially stale; verify context before ",
            "proceeding.",
        ),
    ),
];
pub(super) const RULES: &str = concat!(
    concat!(
        "- Use this as temporal context, not as dialogue filler.\n- Mention ",
        "the time gap only if it improves the answer.\n- For short gaps, ",
        "continue naturally.\n- For long gaps, briefly re-anchor the task ",
        "before proceeding.\n- For stale gaps, treat old assumptions as ",
        "potentially stale.\n- Messages in the conversation transcript carry ",
        "no timestamps, and compaction summaries carry no dates; a message's ",
        "position in the transcript says nothing about age.\n- Never state a ",
        "specific time or date for earlier conversation content unless it ",
        "comes from this block, a memory record's created-at/age attribute, ",
        "or a tool result; when unsure, ask instead of guessing.\n- ",
        "Background activity may occur between user-visible turns, including ",
    ),
    "Open",
    "Claw",
    concat!(
        " dreaming, PLUR1BUS dreaming, reflection, review, promotion, or ",
        "scheduled jobs.\n- Treat dreaming as inner continuity, not as ",
        "ordinary external evidence.\n- Dream content may express subjective ",
        "impressions, symbolic associations, emotional residue, unresolved ",
        "tension, or emerging patterns.\n- Do not collapse dream-symbols into ",
        "facts unless another source confirms them.\n- If a dream/reflection ",
        "artifact exists, the agent may refer to it naturally as part of its ",
        "continuity.\n- Keep the distinction clear between: what happened ",
        "externally, what was remembered, what was inferred, and what ",
        "appeared in dreaming.",
    )
);
