//! `inbox/migrate.ts`: the durable break-glass notices (`admin_notices`) stay the fail-closed record behind
//! `breakglass.notices`; this copies them into the inbox once, keyed by grant id, so nothing a person was told before the
//! inbox existed is lost.
use super::store::InboxStore;
use super::{InboxDraft, InboxError, InboxRef};
use crate::rbac::break_glass::BreakGlassNotice;
use serde_json::Value;

/// `breakglassDraft`: metadata only. The reason text stays in `breakglass.notices` and is not copied.
pub fn breakglass_draft(n: &BreakGlassNotice) -> InboxDraft {
    InboxDraft {
        user_id: n.user_id.clone(),
        kind: "breakglass".into(),
        severity: "critical".into(),
        title_key: "inbox.breakglass.granted".into(),
        params: Some(vec![
            (
                "holderUserId".into(),
                Value::String(n.holder_user_id.clone()),
            ),
            ("expiresAt".into(), Value::from(n.expires_at)),
        ]),
        reference: Some(InboxRef {
            route: Some("/inbox".into()),
            object_id: Some(n.grant_id.clone()),
        }),
        dedupe_key: format!("breakglass:{}", n.grant_id),
    }
}

/// Returns how many notices were new to the inbox. The first notice the store refuses stops the run with its error.
pub fn migrate_breakglass_notices(
    store: &mut InboxStore,
    notices: &[BreakGlassNotice],
) -> Result<usize, InboxError> {
    let mut created = 0;
    for n in notices {
        if store.publish(&breakglass_draft(n))?.created {
            created += 1;
        }
    }
    Ok(created)
}
