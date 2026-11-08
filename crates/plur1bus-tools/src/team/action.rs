//! Deterministic outbox identifiers and snapshot updates; no action is executed here.
use super::{hash, list, num, state, text};
use serde_json::{json, Value};
pub(super) struct Machine {
    pub s: Value,
    pub actions: Vec<Value>,
    pub seq: u64,
}
impl Machine {
    pub fn emit(&mut self, kind: &str, mut fields: Value) {
        fields["kind"] = json!(kind);
        fields["id"] = json!(hash(&json!([
            self.s["run"]["id"],
            self.seq,
            self.actions.len()
        ])));
        self.actions.push(fields);
        self.s["counters"]["actions"] = json!(num(&self.s["counters"], "actions") + 1);
    }
    pub fn package_action(&mut self, kind: &str, i: usize) {
        self.emit(kind,json!({"package":self.s["packages"][i]["key"],"writerEpoch":self.s["packages"][i]["writerEpoch"]}));
    }
    pub fn note(&mut self, kind: &str, target: &str, reason: &str) {
        self.emit(kind, json!({"target":target,"reason":reason}));
    }
    pub fn status(&mut self, i: usize, status: &str) {
        self.s["packages"][i]["status"] = json!(status);
    }
    pub fn dequeue(&mut self, i: usize) {
        let key = self.s["packages"][i]["key"].clone();
        if let Some(q) = self.s["mergeQueue"].as_array_mut() {
            q.retain(|k| k != &key);
        }
    }
    pub fn invalidate(&mut self, i: usize) {
        for key in [
            "checksTree",
            "checksHead",
            "reviewTree",
            "mergeConfirmation",
        ] {
            self.s["packages"][i][key] = Value::Null;
        }
        self.s["packages"][i]["checks"] = json!([]);
        self.dequeue(i);
    }
    pub fn stop(&mut self, i: usize) {
        let old = num(&self.s["packages"][i], "writerEpoch");
        self.s["packages"][i]["stopPending"] = json!(true);
        self.s["packages"][i]["writerEpoch"] = json!(old + 1);
        self.emit("stop-worker",json!({"package":self.s["packages"][i]["key"],"writerEpoch":old+1,"stopEpoch":old,"member":if self.s["packages"][i]["activeRole"]=="reviewer" { self.s["packages"][i]["reviewer"].clone() } else {self.s["packages"][i]["writer"].clone()},"role":self.s["packages"][i]["activeRole"]}));
    }
    pub fn start(&mut self, i: usize, resume: bool) {
        self.s["packages"][i]["activeRole"] = json!("writer");
        self.status(i, "writing");
        self.emit("start-worker",json!({"package":self.s["packages"][i]["key"],"writerEpoch":self.s["packages"][i]["writerEpoch"],"member":self.s["packages"][i]["writer"],"resume":resume}));
    }
    pub fn decision(&mut self, i: usize, reason: &str) {
        if state::terminal(&self.s["packages"][i]) {
            return;
        }
        self.stop(i);
        self.invalidate(i);
        self.status(i, "needs-decision");
        self.s["packages"][i]["hadNeedsDecision"] = json!(true);
        self.s["packages"][i]["personPending"] = json!(true);
        self.s["packages"][i]["hold"] = Value::Null;
        let key = text(&self.s["packages"][i], "key").to_owned();
        self.note("ask-person", &key, reason);
        self.note("lead-turn", &key, "decision-options");
    }
    pub fn fix(&mut self, i: usize, reason: &str) {
        self.s["packages"][i]["fixRounds"] = json!(num(&self.s["packages"][i], "fixRounds") + 1);
        self.invalidate(i);
        if num(&self.s["packages"][i], "fixRounds") >= 5 {
            self.decision(i, reason);
            return;
        }
        self.s["packages"][i]["writerEpoch"] =
            json!(num(&self.s["packages"][i], "writerEpoch") + 1);
        self.start(i, true);
        self.status(i, "fixing");
    }
    pub fn begin_handover(&mut self, i: usize, member: &str) {
        self.stop(i);
        if self.s["packages"][i]["activeRole"] != "reviewer" {
            self.invalidate(i);
        }
        self.status(i, "handover");
        self.s["packages"][i]["handoverTo"] = json!(member);
        self.s["packages"][i]["handoverPhase"] = json!("stopping");
        self.s["packages"][i]["hold"] = Value::Null;
    }
    pub fn hold(&mut self, i: usize, allow: bool, reset: u64) {
        self.stop(i);
        if self.s["packages"][i]["activeRole"] != "reviewer" {
            self.invalidate(i);
        }
        self.status(i, "holding");
        let now = num(&self.s["run"], "now");
        self.s["packages"][i]["hold"] = json!({"since":now,"nextPollAt":now.saturating_add(num(&self.s["timers"],"pollIntervalMs")),"handoverAt":now.saturating_add(num(&self.s["timers"],"handoverAfterMs")),"resetAt":reset,"veto":false,"keepUntil":null,"allowHandover":allow,"pollPending":false});
        let key = text(&self.s["packages"][i], "key").to_owned();
        self.note("notify", &key, "quota-hold");
    }
    pub fn review(&mut self, i: usize) {
        let previous = self.s["packages"][i]["reviewer"]
            .as_str()
            .map(str::to_owned);
        let candidate = previous
            .filter(|member| self.eligible_role(i, member, "reviewer"))
            .or_else(|| {
                list(&self.s, "members")
                    .iter()
                    .find(|m| self.eligible_role(i, text(m, "id"), "reviewer"))
                    .map(|m| text(m, "id").to_owned())
            });
        if let Some(member) = candidate {
            self.s["packages"][i]["reviewer"] = json!(member);
            self.s["packages"][i]["activeRole"] = json!("reviewer");
            self.status(i, "reviewing");
            self.emit("start-review",json!({"package":self.s["packages"][i]["key"],"writerEpoch":self.s["packages"][i]["writerEpoch"],"member":member}));
        } else {
            self.decision(i, "reviewer-unavailable");
        }
    }
    pub fn quiesce(&mut self, section: Option<usize>) {
        for i in 0..list(&self.s, "packages").len() {
            if section.is_some() && state::section(&self.s, i) != section {
                continue;
            }
            if matches!(
                text(&self.s["packages"][i], "status"),
                "writing" | "fixing" | "syncing" | "checking" | "reviewing"
            ) {
                self.stop(i);
                self.status(i, "interrupted");
            }
        }
    }
    pub fn eligible_role(&self, i: usize, member: &str, role: &str) -> bool {
        self.eligible(i, member)
            && (role != "reviewer" || self.s["packages"][i]["writer"] != member)
            && list(&self.s, "members")
                .iter()
                .any(|m| text(m, "id") == member && list(m, "roles").iter().any(|r| r == role))
    }
    pub fn eligible(&self, i: usize, member: &str) -> bool {
        list(&self.s, "members").iter().any(|m| {
            text(m, "id") == member
                && m["available"] == true
                && list(m, "eligiblePackages").contains(&self.s["packages"][i]["key"])
        }) && !list(&self.s, "packages").iter().enumerate().any(|(j, p)| {
            i != j
                && (text(p, "writer") == member || text(p, "reviewer") == member)
                && state::active(p)
        })
    }
}
