use crate::output::Out;
use serde_json::json;

pub fn milestone(out: &Out, cmd: &str, milestone: &str, note: &str) -> ! {
    out.fail(
        "E_NOT_AVAILABLE",
        &format!("`plur1bus {cmd}` arrives in {milestone}: {note}"),
        json!({ "milestone": milestone, "command": cmd }),
        2,
    )
}
