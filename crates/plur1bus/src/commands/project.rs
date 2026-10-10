use super::surfaces::{call, emit};
use crate::{output::Out, paths::Layout};
use clap::Subcommand;
use serde_json::{json, Value};
#[derive(Debug, Subcommand)]
pub enum ProjectCmd {
    #[command(about = "[experimental] Show the project board grouped by column")]
    Board { project: String },
    /// Work with project board cards
    Card {
        #[command(subcommand)]
        sub: super::project_board::CardCmd,
    },
    /// Manage project board columns (project lead required)
    Column {
        #[command(subcommand)]
        sub: super::project_board::ColumnCmd,
    },
    #[command(about = "[experimental] Create a project")]
    Create { name: String },
    #[command(about = "[experimental] List records")]
    List,
    #[command(about = "[experimental] Show a record")]
    Show { id: String },
    #[command(about = "[experimental] Archive a project")]
    Archive { id: String },
    #[command(
        about = "Project membership and roles",
        long_about = "Project membership and roles"
    )]
    Member {
        #[command(subcommand)]
        sub: MemberCmd,
    },
    #[command(
        about = "Assigned project agents",
        long_about = "Assigned project agents"
    )]
    Agent {
        #[command(subcommand)]
        sub: AgentCmd,
    },
}
#[derive(Debug, Subcommand)]
pub enum MemberCmd {
    #[command(about = "[experimental] Add a member or agent")]
    Add {
        project: String,
        user: String,
        #[arg(long,default_value="member",value_parser=["member","lead"])]
        role: String,
    },
    #[command(about = "[experimental] Remove a member or agent")]
    Remove { project: String, user: String },
    #[command(about = "[experimental] Change a member role")]
    Role {
        project: String,
        user: String,
        #[arg(value_parser=["member","lead"])]
        role: String,
    },
}
#[derive(Debug, Subcommand)]
pub enum AgentCmd {
    #[command(about = "[experimental] Add a member or agent")]
    Add { project: String, agent: String },
    #[command(about = "[experimental] Remove a member or agent")]
    Remove { project: String, agent: String },
}
#[derive(Debug, Subcommand)]
pub enum TraceCmd {
    #[command(about = "[experimental] Show a record")]
    Show { id: String },
    #[command(about = "[experimental] List records")]
    List { project: String },
}
pub fn request(cmd: &ProjectCmd) -> (&'static str, Value) {
    match cmd {
        ProjectCmd::Board { project } => ("project.column.list", json!({"projectId":project})),
        ProjectCmd::Card { sub } => super::project_board::card_request(sub),
        ProjectCmd::Column { sub } => super::project_board::column_request(sub),
        ProjectCmd::Create { name } => ("project.create", json!({"name":name})),
        ProjectCmd::List => ("project.list", json!({})),
        ProjectCmd::Show { id } => ("project.get", json!({"projectId":id})),
        ProjectCmd::Archive { id } => ("project.archive", json!({"projectId":id})),
        ProjectCmd::Member { sub } => match sub {
            MemberCmd::Add {
                project,
                user,
                role,
            } => (
                "project.member.add",
                json!({"projectId":project,"userId":user,"role":role}),
            ),
            MemberCmd::Remove { project, user } => (
                "project.member.remove",
                json!({"projectId":project,"userId":user}),
            ),
            MemberCmd::Role {
                project,
                user,
                role,
            } => (
                "project.member.role",
                json!({"projectId":project,"userId":user,"role":role}),
            ),
        },
        ProjectCmd::Agent { sub } => match sub {
            AgentCmd::Add { project, agent } => (
                "project.agent.add",
                json!({"projectId":project,"agentId":agent}),
            ),
            AgentCmd::Remove { project, agent } => (
                "project.agent.remove",
                json!({"projectId":project,"agentId":agent}),
            ),
        },
    }
}
pub fn run(out: &Out, layout: &Layout, cmd: ProjectCmd) {
    match &cmd {
        ProjectCmd::Board { project } => return super::project_board::board(out, layout, project),
        ProjectCmd::Card { sub } => return super::project_board::card(out, layout, sub),
        ProjectCmd::Column { sub } => return super::project_board::column(out, layout, sub),
        _ => {}
    }
    let (m, p) = request(&cmd);
    emit(out, m, &call(out, layout, m, p));
}
pub fn trace(out: &Out, layout: &Layout, cmd: TraceCmd) {
    let (m, p) = match cmd {
        TraceCmd::Show { id } => ("collab.trace.get", json!({"traceId":id})),
        TraceCmd::List { project } => ("collab.trace.list", json!({"projectId":project})),
    };
    emit(out, m, &call(out, layout, m, p));
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;
    #[test]
    fn roles_are_closed() {
        assert!(
            Cli::try_parse_from(["plur1bus", "project", "member", "role", "p", "u", "owner"])
                .is_err()
        );
        let cli = Cli::try_parse_from([
            "plur1bus", "--json", "project", "member", "role", "p", "u", "lead",
        ])
        .unwrap();
        let Cmd::Project { sub } = cli.cmd else {
            panic!()
        };
        assert_eq!(request(&sub).0, "project.member.role");
    }
}
