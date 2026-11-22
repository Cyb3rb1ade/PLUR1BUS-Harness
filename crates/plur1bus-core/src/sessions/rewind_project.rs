//! `session/rewind-project.ts`: the D115 card link and the shared worktree, read-only. A rewind with files or an automatic
//! rewind needs exactly one unambiguous place to restore into: one active card of one active project that links the session
//! and assigns the session's agent, with a worktree root known to the shared worktree port. Any ambiguity yields no root, and
//! no binding is ever created here.
//!
//! The collaboration service (`collab/service.ts`) is not ported yet; what this function reads of it is the trait
//! [`CollabPort`] (R-K-2), and the worktree port is [`WorktreePort`]. The board pages are read to the end, 100 cards at a time.
use super::rewind_checkpoints::ProjectBinding;
use super::types::{SessionKind, SessionRecord};

/// One project as the listing shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct CollabProject {
    /// The id.
    pub id: String,
    /// Whether the project is archived.
    pub archived: bool,
    /// The agent members.
    pub agents: Vec<String>,
}

/// One card of a board page.
#[derive(Clone, Debug, PartialEq)]
pub struct CollabCard {
    /// The id.
    pub id: String,
    /// `links`: `(kind, id)`.
    pub links: Vec<(String, String)>,
    /// `assignees`: `(kind, id)`.
    pub assignees: Vec<(String, String)>,
}

/// A page of active cards.
#[derive(Clone, Debug, PartialEq)]
pub struct CardPage {
    /// The cards of the page.
    pub cards: Vec<CollabCard>,
    /// The cursor of the next page.
    pub next_cursor: Option<String>,
}

/// The part of `Collab` this module reads. `list_projects` is `listProjects(person)`: the host binds the person.
pub trait CollabPort {
    /// The projects the person can see.
    fn list_projects(&self) -> Vec<CollabProject>;
    /// `boardStore.cards(projectId, { archived: false, limit: 100, cursor })`.
    fn cards(&self, project_id: &str, cursor: Option<&str>) -> CardPage;
}

/// `ProjectWorktreePort.root`.
pub trait WorktreePort {
    /// The canonical root of the agent's worktree for this card, if one is bound.
    fn root(&self, agent_id: &str, project_id: &str, card_id: &str) -> Option<String>;
}

/// `rewindProjectContext`: a unique active card must link this session and assign its stored agent; ambiguity refuses
/// automatic and file rewind. `person_is_person` is `person.kind === "person"`.
pub fn rewind_project_context(
    session: &SessionRecord,
    person_is_person: bool,
    collab: &dyn CollabPort,
    worktrees: &dyn WorktreePort,
) -> Option<ProjectBinding> {
    if session.kind != SessionKind::Card || session.archived_at.is_some() || !person_is_person {
        return None;
    }
    let mut found: Option<ProjectBinding> = None;
    for project in collab.list_projects() {
        if project.archived || !project.agents.contains(&session.agent_id) {
            continue;
        }
        let mut cursor: Option<String> = None;
        loop {
            let page = collab.cards(&project.id, cursor.as_deref());
            for card in &page.cards {
                if !card
                    .links
                    .iter()
                    .any(|(k, id)| k == "session" && *id == session.id)
                    || !card
                        .assignees
                        .iter()
                        .any(|(k, id)| k == "agent" && *id == session.agent_id)
                {
                    continue;
                }
                let root = worktrees
                    .root(&session.agent_id, &project.id, &card.id)
                    .filter(|r| !r.is_empty());
                match (root, &found) {
                    (Some(root), None) => {
                        found = Some(ProjectBinding {
                            project_id: project.id.clone(),
                            card_id: card.id.clone(),
                            root,
                        });
                    }
                    _ => return None,
                }
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
    }
    found
}
