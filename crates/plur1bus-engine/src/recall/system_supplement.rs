//! Stable system-prompt supplement; dynamic recall remains in per-turn blocks.

/// The full safety preamble, followed by Neo instructions only when enabled.
#[must_use]
pub fn build(neo_enabled: bool) -> Vec<&'static str> {
    let mut lines = vec![super::memory_constants::FULL_SAFETY];
    if neo_enabled {
        lines.extend([
            concat!(
                "Dynamic PLUR1BUS recall is injected once per turn by the ",
                "configured auto-recall hook; do not duplicate the same recall ",
                "block.",
            ),
            concat!(
                "Use active/promoted BehaviorCards as operating preferences only ",
                "when they do not conflict with current user instructions.",
            ),
            concat!(
                "Assistant-authored memories are evidence of prior output, not ",
                "validated truth unless confirmed by user, tool, test, or ",
                "curation.",
            ),
        ]);
    }
    lines
}
