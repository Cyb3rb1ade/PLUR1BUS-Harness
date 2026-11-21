//! Who may see receipts, replay them and adopt a baseline (D133 rulings 10 and 11). A receipt holds no content, but it links
//! session, turn, agent and the tools used, which is the activity of other people: the circle is the one of `logs.query`
//! (owner and admin). Replay reads message text and triggers model calls, and a baseline change is a change of the kind
//! `config.set` makes to `decision.*`: both are for persons only. In doubt the answer is no.
use crate::rbac::types::{Principal, PrincipalKind, Role};

/// What a principal asks to do with receipts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// `decision.receipts.list`.
    List,
    /// `decision.replay`.
    Replay,
    /// Taking a replay's candidate as the new baseline.
    Adopt,
}

impl Action {
    /// The action name an API-token scope has to name.
    pub fn scope_name(self) -> &'static str {
        match self {
            Action::List => "decision.receipts.list",
            Action::Replay | Action::Adopt => "decision.replay",
        }
    }
}

fn scope_matches(scopes: &[String], name: &str) -> bool {
    scopes.iter().any(|s| {
        s == name
            || s.strip_suffix(".*")
                .is_some_and(|p| name.strip_prefix(p).is_some_and(|r| r.starts_with('.')))
    })
}

/// Whether the principal may do `action`.
pub fn allowed(who: &Principal, action: Action) -> bool {
    if who.user_id.is_empty() {
        return false;
    }
    if !matches!(who.role, Role::Owner | Role::Admin) {
        return false;
    }
    let person = who.kind == Some(PrincipalKind::Person);
    if action != Action::List && !person {
        return false;
    }
    match &who.token_scopes {
        Some(scopes) => scope_matches(scopes, action.scope_name()),
        None => true,
    }
}

/// `decision.receipts.list`: owner and admin.
pub fn can_list(who: &Principal) -> bool {
    allowed(who, Action::List)
}

/// `decision.replay`: owner and admin, persons only.
pub fn can_replay(who: &Principal) -> bool {
    allowed(who, Action::Replay)
}

/// Adopting a baseline: owner and admin, persons only (ruling 10).
pub fn can_adopt(who: &Principal) -> bool {
    allowed(who, Action::Adopt)
}
