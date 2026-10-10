use super::surfaces::{call, emit};
use crate::{output::Out, paths::Layout};
use clap::Subcommand;
use serde_json::{json, Value};

#[derive(Debug, Subcommand)]
pub enum CardCmd {
    #[command(about = "[experimental] List project cards, ordered by column and position")]
    List {
        project: String,
        #[arg(long)]
        column: Option<String>,
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        text: Option<String>,
        #[arg(long)]
        archived: bool,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long)]
        assignee: Option<String>,
        #[arg(long, default_value = "person", value_parser = ["person", "agent"])]
        assignee_kind: String,
    },
    #[command(about = "[experimental] Show a project card")]
    Show { project: String, card: String },
    #[command(about = "[experimental] Create a card; description is plain Markdown text")]
    Create {
        project: String,
        column: String,
        title: String,
        #[arg(long, default_value = "")]
        description: String,
        #[arg(long)]
        label: Vec<String>,
        #[arg(long, default_value = "normal", value_parser = ["none", "low", "normal", "high", "urgent"])]
        priority: String,
        #[arg(long)]
        due_at: Option<u64>,
        #[arg(long)]
        position: Option<u32>,
        #[arg(long)]
        override_wip: bool,
    },
    #[command(
        about = "[experimental] Move a card to a zero-based position; WIP override requires project manage"
    )]
    Move {
        project: String,
        card: String,
        column: String,
        position: u32,
        #[arg(long)]
        override_wip: bool,
    },
    #[command(
        about = "[experimental] Assign or unassign a person or agent belonging to this project"
    )]
    Assign {
        project: String,
        card: String,
        #[arg(value_parser = ["person", "agent"])]
        kind: String,
        assignee: String,
        #[arg(long)]
        remove: bool,
    },
    #[command(about = "[experimental] Add a Markdown comment")]
    Comment {
        project: String,
        card: String,
        text: String,
    },
    #[command(about = "[experimental] Archive a card, or unarchive with --undo")]
    Archive {
        project: String,
        card: String,
        #[arg(long)]
        undo: bool,
        #[arg(long, requires = "undo")]
        override_wip: bool,
    },
}
#[derive(Debug, Subcommand)]
pub enum ColumnCmd {
    #[command(about = "[experimental] List board columns")]
    List { project: String },
    #[command(about = "[experimental] Create a column with a display title or an i18n key")]
    Create {
        project: String,
        title: String,
        #[arg(long)]
        title_key: bool,
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
        wip_limit: Option<u32>,
        #[arg(long)]
        position: Option<u32>,
    },
    #[command(about = "[experimental] Move a column to a zero-based position")]
    Move {
        project: String,
        column: String,
        position: u32,
    },
    #[command(about = "[experimental] Delete an empty column, or move its cards to --target")]
    Delete {
        project: String,
        column: String,
        #[arg(long)]
        target: Option<String>,
        #[arg(long)]
        override_wip: bool,
    },
}
fn optional(p: &mut Value, key: &str, value: &Option<impl serde::Serialize>) {
    if let Some(v) = value {
        p[key] = json!(v);
    }
}
pub fn card_request(cmd: &CardCmd) -> (&'static str, Value) {
    match cmd {
        CardCmd::List {
            project,
            column,
            label,
            text,
            archived,
            cursor,
            limit,
            assignee,
            assignee_kind,
        } => {
            let mut p = json!({"projectId":project,"archived":archived,"limit":limit});
            optional(&mut p, "columnId", column);
            optional(&mut p, "label", label);
            optional(&mut p, "text", text);
            optional(&mut p, "cursor", cursor);
            if let Some(id) = assignee {
                p["assignee"] = json!({"kind":assignee_kind,"id":id});
            }
            ("project.card.list", p)
        }
        CardCmd::Show { project, card } => (
            "project.card.get",
            json!({"projectId":project,"cardId":card}),
        ),
        CardCmd::Create {
            project,
            column,
            title,
            description,
            label,
            priority,
            due_at,
            position,
            override_wip,
        } => {
            let mut p = json!({"projectId":project,"columnId":column,"title":title,"description":description,"labels":label,"priority":priority,"overrideWip":override_wip});
            optional(&mut p, "dueAt", due_at);
            optional(&mut p, "position", position);
            ("project.card.create", p)
        }
        CardCmd::Move {
            project,
            card,
            column,
            position,
            override_wip,
        } => (
            "project.card.move",
            json!({"projectId":project,"cardId":card,"columnId":column,"position":position,"overrideWip":override_wip}),
        ),
        CardCmd::Assign {
            project,
            card,
            kind,
            assignee,
            remove,
        } => (
            if *remove {
                "project.card.unassign"
            } else {
                "project.card.assign"
            },
            json!({"projectId":project,"cardId":card,"assignee":{"kind":kind,"id":assignee}}),
        ),
        CardCmd::Comment {
            project,
            card,
            text,
        } => (
            "project.card.comment.add",
            json!({"projectId":project,"cardId":card,"text":text}),
        ),
        CardCmd::Archive {
            project,
            card,
            undo,
            override_wip,
        } => {
            let mut p = json!({"projectId":project,"cardId":card});
            if *undo {
                p["overrideWip"] = json!(override_wip);
            }
            (
                if *undo {
                    "project.card.unarchive"
                } else {
                    "project.card.archive"
                },
                p,
            )
        }
    }
}
pub fn column_request(cmd: &ColumnCmd) -> (&'static str, Value) {
    match cmd {
        ColumnCmd::List { project } => ("project.column.list", json!({"projectId":project})),
        ColumnCmd::Create {
            project,
            title,
            title_key,
            wip_limit,
            position,
        } => {
            let mut p = json!({"projectId":project});
            p[if *title_key { "titleKey" } else { "title" }] = json!(title);
            optional(&mut p, "wipLimit", wip_limit);
            optional(&mut p, "position", position);
            ("project.column.create", p)
        }
        ColumnCmd::Move {
            project,
            column,
            position,
        } => (
            "project.column.move",
            json!({"projectId":project,"columnId":column,"position":position}),
        ),
        ColumnCmd::Delete {
            project,
            column,
            target,
            override_wip,
        } => {
            let mut p = json!({"projectId":project,"columnId":column,"overrideWip":override_wip});
            optional(&mut p, "targetColumnId", target);
            ("project.column.delete", p)
        }
    }
}
/// The overview follows every page, then groups cards by column. No RPC result text is interpreted.
pub fn board(out: &Out, layout: &Layout, project: &str) {
    let columns = call(
        out,
        layout,
        "project.column.list",
        json!({"projectId":project}),
    );
    let mut cards = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut p = json!({"projectId":project,"limit":100});
        optional(&mut p, "cursor", &cursor);
        let page = call(out, layout, "project.card.list", p);
        if let Some(items) = page["cards"].as_array() {
            cards.extend(items.iter().cloned());
        }
        cursor = page["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    let grouped: Vec<Value> = columns["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let mut c = c.clone();
            c["cards"] = json!(cards
                .iter()
                .filter(|card| card["columnId"] == c["id"])
                .collect::<Vec<_>>());
            c
        })
        .collect();
    let value = json!({"projectId":project,"columns":grouped});
    out.ok("project.board/1", &value, || render_board(&value));
}
fn render_board(value: &Value) -> String {
    let mut text = String::new();
    for column in value["columns"].as_array().into_iter().flatten() {
        let name = column["title"]
            .as_str()
            .or_else(|| column["titleKey"].as_str())
            .unwrap_or("?");
        text.push_str(&format!(
            "{name} [{}]\n",
            column["id"].as_str().unwrap_or("?")
        ));
        for card in column["cards"].as_array().into_iter().flatten() {
            text.push_str(&format!(
                "  {}  {}\n",
                card["id"].as_str().unwrap_or("?"),
                card["title"].as_str().unwrap_or("?")
            ));
        }
    }
    text
}
pub fn card(out: &Out, layout: &Layout, cmd: &CardCmd) {
    let (m, p) = card_request(cmd);
    emit(out, m, &call(out, layout, m, p));
}
pub fn column(out: &Out, layout: &Layout, cmd: &ColumnCmd) {
    let (m, p) = column_request(cmd);
    emit(out, m, &call(out, layout, m, p));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;
    #[test]
    fn closed_assignment_kinds_and_move_wire_shape() {
        assert!(Cli::try_parse_from([
            "plur1bus", "project", "card", "assign", "p", "c", "owner", "x"
        ])
        .is_err());
        let cli = Cli::try_parse_from([
            "plur1bus",
            "project",
            "card",
            "move",
            "p",
            "c",
            "col",
            "2",
            "--override-wip",
            "--json",
        ])
        .unwrap();
        let Cmd::Project {
            sub: super::super::project::ProjectCmd::Card { sub },
        } = cli.cmd
        else {
            panic!()
        };
        assert_eq!(
            card_request(&sub),
            (
                "project.card.move",
                json!({"projectId":"p","cardId":"c","columnId":"col","position":2,"overrideWip":true})
            )
        );
    }
}
