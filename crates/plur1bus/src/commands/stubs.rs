use crate::output::Out;
use serde_json::json;

#[allow(dead_code)] // no milestone stub is left; the helper stays for the next one
pub fn milestone(out: &Out, cmd: &str, milestone: &str, note: &str) -> ! {
    out.fail(
        "E_NOT_AVAILABLE",
        &format!("`plur1bus {cmd}` arrives in {milestone}: {note}"),
        json!({ "milestone": milestone, "command": cmd }),
        2,
    )
}
