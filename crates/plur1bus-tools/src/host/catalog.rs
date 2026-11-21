use super::Config;
use plur1bus_core::approvals::js_json::num_value;
use plur1bus_core::policy::capabilities::capability;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Operation {
    Read,
    Write,
    Append,
    Edit,
    List,
    Search,
    Stat,
    Mkdir,
    Copy,
    Move,
    Trash,
    Exec,
    Start,
    Shell,
    ProcessList,
    ReadOutput,
    WriteStdin,
    Kill,
    KillForeign,
    Info,
    Open,
    ClipboardRead,
    ClipboardWrite,
    Notify,
}

#[derive(Clone, Copy)]
pub(super) struct Spec {
    pub operation: Operation,
    pub name: &'static str,
    pub capability: &'static str,
    pub required: &'static [&'static str],
    pub optional: &'static [&'static str],
}

macro_rules! spec {
    ($op:ident, $name:literal, $cap:literal, [$($required:literal),*], [$($optional:literal),*]) => {
        Spec {
            operation: Operation::$op,
            name: concat!("hostctl.", $name),
            capability: $cap,
            required: &[$($required),*],
            optional: &[$($optional),*],
        }
    };
}

pub(super) const SPECS: &[Spec] = &[
    spec!(Read, "fs.read", "fs.read", ["path"], ["offset", "length"]),
    spec!(Write, "fs.write", "fs.write", ["path", "content"], []),
    spec!(Append, "fs.append", "fs.write", ["path", "content"], []),
    spec!(
        Edit,
        "fs.edit",
        "fs.write",
        ["path", "oldText", "newText"],
        []
    ),
    spec!(List, "fs.list", "fs.read", ["path"], ["depth", "limit"]),
    spec!(
        Search,
        "fs.search",
        "fs.read",
        ["path", "query"],
        ["mode", "depth", "limit"]
    ),
    spec!(Stat, "fs.stat", "fs.read", ["path"], []),
    spec!(Mkdir, "fs.mkdir", "fs.write", ["path"], []),
    spec!(Copy, "fs.copy", "fs.write", ["path", "destination"], []),
    spec!(Move, "fs.move", "fs.write", ["path", "destination"], []),
    spec!(Trash, "fs.trash", "hostctl.fs.trash", ["path"], []),
    spec!(
        Exec,
        "proc.exec",
        "shell.exec",
        ["program", "cwd"],
        ["args", "timeoutMs", "env"]
    ),
    spec!(
        Start,
        "proc.start",
        "shell.exec",
        ["program", "cwd"],
        ["args", "timeoutMs", "env"]
    ),
    spec!(
        Shell,
        "proc.shell",
        "shell.exec",
        ["command", "cwd"],
        ["timeoutMs", "env"]
    ),
    spec!(
        ProcessList,
        "proc.list",
        "hostctl.proc.session.read",
        [],
        []
    ),
    spec!(
        ReadOutput,
        "proc.read_output",
        "hostctl.proc.session.read",
        ["id"],
        []
    ),
    spec!(
        WriteStdin,
        "proc.write_stdin",
        "hostctl.proc.session.write",
        ["id", "text"],
        ["eof"]
    ),
    spec!(Kill, "proc.kill", "proc.signal", ["id"], []),
    spec!(
        KillForeign,
        "proc.kill_foreign",
        "hostctl.proc.kill_foreign",
        ["pid"],
        ["signal"]
    ),
    spec!(Info, "sys.info", "sys.read", [], []),
    spec!(Open, "app.open", "apps.launch", ["target"], []),
    spec!(ClipboardRead, "clipboard.read", "clipboard.read", [], []),
    spec!(
        ClipboardWrite,
        "clipboard.write",
        "clipboard.read",
        ["text"],
        []
    ),
    spec!(Notify, "notify", "os.script", ["title"], ["body"]),
];

impl Spec {
    pub fn get(name: &str) -> Option<Self> {
        SPECS.iter().copied().find(|spec| spec.name == name)
    }

    pub fn effect(self) -> &'static str {
        if self.operation == Operation::ClipboardWrite {
            "local-write"
        } else {
            capability(self.capability)
                .map_or("local-destructive", |cap| cap.intrinsic_effect.as_str())
        }
    }

    pub fn risk(self) -> &'static str {
        capability(self.capability).map_or("critical", |cap| cap.base_risk.as_str())
    }

    fn summary(self, config: &Config) -> Value {
        let mut properties: Vec<_> = self.required.iter().chain(self.optional).copied().collect();
        properties.sort_unstable();
        let mut required = self.required.to_vec();
        required.sort_unstable();
        json!({
            "name": self.name,
            "capability": self.capability,
            "effect": self.effect(),
            "risk": self.risk(),
            "properties": properties,
            "required": required,
            "limits": {
                "timeoutMs": num_value((config.timeout_ms + 1000.0).min(300_000.0)),
                "maxResultBytes": num_value((config.output_bytes * 2.0 + 4096.0).min(1_048_576.0)),
            },
        })
    }
}

pub(super) fn definitions(config: &Config) -> Vec<Value> {
    if !config.enabled {
        return Vec::new();
    }
    SPECS.iter().map(|spec| spec.summary(config)).collect()
}
