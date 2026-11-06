//! Retained tool previews. Call identity and bounded text come from the runtime's owned session events.
use serde_json::Value;
use std::collections::VecDeque;

const TOOLS: usize = 128;
const TOOL_BYTES: usize = 64 * 1024;
const TOTAL_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum State {
    Running,
    Done,
    Failed,
}

pub(super) struct Tool {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub diff: String,
    pub state: State,
    pub folded: bool,
    pub truncated: bool,
}

impl Tool {
    fn bytes(&self) -> usize {
        self.id.len() + self.name.len() + self.summary.len() + self.diff.len()
    }
}

pub(super) struct ToolList {
    pub entries: VecDeque<Tool>,
    pub selected: usize,
    pub bytes: usize,
    following: bool,
}

impl Default for ToolList {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
            selected: 0,
            bytes: 0,
            following: true,
        }
    }
}

impl ToolList {
    /// Retain one row per issued call; a duplicate must not reset its result or selection.
    pub fn call(&mut self, data: &Value) {
        let Some(id) = data["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
        else {
            return;
        };
        if self.entries.iter().any(|entry| entry.id == id) {
            return;
        }
        let mut name = clean(data["name"].as_str().unwrap_or("?"), 256);
        if let Some(path) = data.pointer("/args/path").and_then(Value::as_str) {
            name.push(' ');
            name.push_str(&clean(path, 512));
        }
        let tool = Tool {
            id: id.into(),
            name,
            summary: String::new(),
            diff: String::new(),
            state: State::Running,
            folded: true,
            truncated: false,
        };
        self.bytes += tool.bytes();
        self.entries.push_back(tool);
        if self.following {
            self.selected = self.entries.len().saturating_sub(1);
        }
        self.trim();
    }

    /// An unmatched result cannot fabricate a tool call or expose an arbitrary raw body.
    pub fn result(&mut self, id: &str, output: &str, is_error: bool) {
        if id.is_empty() {
            return;
        }
        let Some(tool) = self.entries.iter_mut().find(|entry| entry.id == id) else {
            return;
        };
        let before = tool.bytes();
        // The transport is bounded too; refuse oversized input before allocating another JSON tree.
        let raw = (output.len() <= 4 * 1024 * 1024)
            .then(|| serde_json::from_str::<Value>(output).ok())
            .flatten();
        tool.state = if is_error || raw.as_ref().is_some_and(|v| v["isError"] == true) {
            State::Failed
        } else {
            State::Done
        };
        if let Some(raw) = raw {
            let value = raw.get("value").unwrap_or(&raw);
            let summary = ["summary", "essence"]
                .into_iter()
                .filter_map(|field| value[field].as_str())
                .map(|text| clean(text, 4096))
                .collect::<Vec<_>>()
                .join("\n");
            tool.summary = super::model::clipped(&summary, 4096);
            let patch = value["diff"]
                .as_str()
                .or_else(|| value["unifiedDiff"].as_str())
                .unwrap_or("");
            let (diff, truncated) = clean_with_flag(patch, TOOL_BYTES);
            tool.diff = diff;
            tool.truncated = truncated || raw["truncated"] == true || value["truncated"] == true;
        } else {
            tool.truncated = output.len() > 4 * 1024 * 1024;
        }
        self.bytes = self.bytes - before + tool.bytes();
        self.trim();
    }

    /// Keyboard selection stays anchored while additional calls arrive.
    pub fn select(&mut self, previous: bool) {
        self.selected = if previous {
            self.selected.saturating_sub(1)
        } else {
            self.selected
                .saturating_add(1)
                .min(self.entries.len().saturating_sub(1))
        };
        self.following = self.selected == self.entries.len().saturating_sub(1);
    }

    /// Open the core-read worktree diff; its empty id is reserved from ordinary issued calls.
    pub fn show_diff(&mut self, patch: &str, append: bool) {
        let existing = self
            .entries
            .iter()
            .position(|entry| entry.id.is_empty())
            .and_then(|index| self.entries.remove(index));
        // Opening a diff is an explicit selection: keep that view after older previews are evicted.
        let mut entry = if let Some(entry) = existing {
            self.bytes -= entry.bytes();
            entry
        } else {
            Tool {
                id: String::new(),
                name: "git diff".into(),
                summary: String::new(),
                diff: String::new(),
                state: State::Done,
                folded: false,
                truncated: false,
            }
        };
        let raw = if append {
            format!("{}{patch}", entry.diff)
        } else {
            patch.into()
        };
        let (diff, truncated) = clean_with_flag(&raw, TOOL_BYTES);
        entry.diff = diff;
        entry.folded = false;
        entry.truncated = if append {
            entry.truncated || truncated
        } else {
            truncated
        };
        self.bytes += entry.bytes();
        self.entries.push_back(entry);
        self.selected = self.entries.len() - 1;
        self.following = false;
        self.trim();
    }

    fn trim(&mut self) {
        while self.entries.len() > TOOLS || self.bytes > TOTAL_BYTES {
            if let Some(removed) = self.entries.pop_front() {
                self.bytes -= removed.bytes();
                self.selected = self.selected.saturating_sub(1);
            }
        }
    }
}

fn clean(text: &str, limit: usize) -> String {
    clean_with_flag(text, limit).0
}

fn clean_with_flag(text: &str, limit: usize) -> (String, bool) {
    let prefix = super::model::clipped(text, limit);
    let safe = super::super::render::safe(&prefix, true).replace('\t', "    ");
    (
        super::model::clipped(&safe, limit),
        text.len() > limit || safe.len() > limit,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reading_an_earlier_tool_does_not_jump_when_a_new_call_arrives() {
        let mut tools = ToolList::default();
        for id in ["one", "two"] {
            tools.call(&json!({"id":id,"name":"file.read"}));
        }
        tools.select(true);
        tools.call(&json!({"id":"three","name":"file.edit"}));
        assert_eq!(tools.entries[tools.selected].id, "one");
        tools.select(false);
        tools.select(false);
        tools.call(&json!({"id":"four","name":"file.read"}));
        assert_eq!(tools.entries[tools.selected].id, "four");
    }

    #[test]
    fn a_core_worktree_diff_replaces_then_appends_pages_and_cannot_be_overwritten_by_a_tool_result()
    {
        let mut tools = ToolList::default();
        tools.show_diff("@@ header\n", false);
        tools.show_diff("+next page", true);
        let entry = &tools.entries[tools.selected];
        assert_eq!(entry.diff, "@@ header\n+next page");
        assert!(!entry.folded);
        tools.result("", &json!({"value":{"diff":"forged"}}).to_string(), false);
        assert_eq!(tools.entries[tools.selected].diff, "@@ header\n+next page");
        tools.show_diff("replacement", false);
        assert_eq!(tools.entries[tools.selected].diff, "replacement");
    }

    #[test]
    fn opening_a_worktree_diff_keeps_it_selected_when_the_shared_preview_budget_is_full() {
        let mut tools = ToolList::default();
        tools.show_diff("previous diff", false);
        let patch = "+".repeat(TOOL_BYTES);
        for i in 0..15 {
            let id = format!("call-{i}");
            tools.call(&json!({"id":id,"name":"file.edit"}));
            tools.result(&id, &json!({"value":{"diff":patch}}).to_string(), false);
        }
        tools.show_diff(&patch, false);
        let shown = &tools.entries[tools.selected];
        assert!(shown.id.is_empty(), "the requested diff remains selected");
        assert_eq!(shown.diff, patch);
        assert!(tools.bytes <= TOTAL_BYTES);
    }

    #[test]
    fn a_literal_ellipsis_does_not_claim_that_a_complete_patch_was_truncated() {
        let mut tools = ToolList::default();
        tools.call(&json!({"id":"complete","name":"file.edit"}));
        tools.result(
            "complete",
            &json!({"value":{"diff":"+text…"}}).to_string(),
            false,
        );
        assert_eq!(tools.entries[0].diff, "+text…");
        assert!(!tools.entries[0].truncated);
    }

    #[test]
    fn an_owned_tool_keeps_its_full_retained_diff_for_folding_and_scrolling() {
        let mut tools = ToolList::default();
        tools.call(&json!({"id":"call-1","name":"file.edit","args":{"path":"src/main.rs"}}));
        let patch = (0..80)
            .map(|n| format!("+line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        tools.result(
            "call-1",
            &json!({"isError":false,"value":{"summary":"updated","diff":patch}}).to_string(),
            false,
        );
        let tool = tools.entries.front().expect("issued tool");
        assert_eq!(tool.state, State::Done);
        assert!(tool.folded);
        assert!(tool.diff.contains("+line 79"));
        assert_eq!(tool.summary, "updated");
        assert!(!tool.truncated);
        tools.call(&json!({"id":"call-1","name":"forged replacement"}));
        assert_eq!(tools.entries.len(), 1);
        assert_eq!(tools.entries[0].name, "file.edit src/main.rs");
        assert_eq!(tools.entries[0].state, State::Done);
        tools.result("not-issued", "untrusted result", false);
        assert_eq!(tools.entries.len(), 1);
    }

    #[test]
    fn retained_tool_history_and_oversized_previews_are_bounded_and_terminal_safe() {
        let mut tools = ToolList::default();
        for n in 0..160 {
            let id = format!("call-{n}");
            tools.call(&json!({"id":id,"name":"file.write"}));
            tools.result(
                &id,
                &json!({"value":{"diff":"🧩\t\u{001b}[2J".repeat(9000)}}).to_string(),
                false,
            );
        }
        assert!(!tools.entries.is_empty());
        assert!(tools.entries.len() <= TOOLS && tools.bytes <= TOTAL_BYTES);
        let last = tools.entries.back().expect("latest");
        assert_eq!(last.id, "call-159");
        assert!(last.diff.len() <= TOOL_BYTES && last.truncated);
        assert!(!last.diff.contains(['\x1b', '\t']));
        assert!(last.diff.ends_with('…'));
    }

    #[test]
    fn failures_and_upstream_truncation_are_visible_without_dumping_unknown_payloads() {
        let mut tools = ToolList::default();
        tools.call(&json!({"id":"one","name":"exec.run"}));
        tools.result("one", &json!({"isError":true,"truncated":true,"value":{"summary":"failed","diff":"+preview"},"nonce":"private"}).to_string(), false);
        let tool = tools.entries.front().expect("tool");
        assert_eq!(tool.state, State::Failed);
        assert!(tool.truncated);
        assert!(!tool.summary.contains("private") && !tool.diff.contains("private"));
    }
}
