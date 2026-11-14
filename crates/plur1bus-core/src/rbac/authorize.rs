//! `authorize(principal, action, resource, ctx)`: pure and side-effect free (no clock, no I/O, no logging). Deny by default.
//! Port of `rbac/authorize.ts`.
//!
//! Two entry points share one evaluation:
//! - [`authorize`] / [`can_see`] take the Rust types of [`super::types`];
//! - [`authorize_js`] / [`can_see_js`] take [`Js`] values and give the decision TypeScript gives for *any* input a caller could
//!   hand it, including input the TypeScript types forbid (a principal that is a string, `tokenScopes` that is a number,
//!   rights tables that are arrays, a `now` that is the string `"1000"`). Where TypeScript throws (a `TypeError` from a
//!   method called on `null` or on a non-array) they return `Err(Throw)`; the vectors record those cases as `{"throws": ...}`.
//!   The typed entry points build the same internal subject from well-formed data and cannot reach a throw.
//!
//! The order of the checks is the order of the TypeScript, and the vectors pin it: no principal, malformed principal (user id,
//! role, kind), unknown action, `humanOnly` against a principal that is not explicitly a person, resource shape, resource id,
//! token scopes, then the role's grants in order, then the most specific reason the role was missing.
use super::loose::{Js, Throw};
use super::policy::policy_for;
use super::types::{
    ActionSpec, AllowReason, AuthorizeContext, BreakGlassGrant, Decision, DenyReason, Grant,
    Principal, PrincipalKind, Resource, Role,
};
use serde_json::{Map, Value};

/// What [`authorize_js`] decides. Like [`Decision`], except that the id of the break-glass grant is whatever JavaScript value
/// the grant carried (the TypeScript copies `live.id` without looking at it).
#[derive(Clone, Debug, PartialEq)]
pub enum JsDecision {
    /// Allowed.
    Allow {
        /// Why.
        reason: AllowReason,
        /// `live.id` of the grant that allowed it (`None` when the grant had no `id`).
        break_glass_id: Option<Js>,
    },
    /// Denied.
    Deny {
        /// Why.
        reason: DenyReason,
    },
}

impl JsDecision {
    /// `{effect, reason, breakGlassId?}` as the parity vectors record it.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        match self {
            JsDecision::Allow {
                reason,
                break_glass_id,
            } => {
                m.insert("effect".into(), "allow".into());
                m.insert("reason".into(), reason.as_str().into());
                if let Some(id) = break_glass_id {
                    if !id.is_undefined() {
                        m.insert("breakGlassId".into(), id.to_value());
                    }
                }
            }
            JsDecision::Deny { reason } => {
                m.insert("effect".into(), "deny".into());
                m.insert("reason".into(), reason.as_str().into());
            }
        }
        Value::Object(m)
    }

    /// Whether the effect is `allow`.
    pub fn is_allow(&self) -> bool {
        matches!(self, JsDecision::Allow { .. })
    }
}

fn deny(reason: DenyReason) -> JsDecision {
    JsDecision::Deny { reason }
}

// --- the subject: a principal after the checks that do not depend on the action -------------------------------------------------

/// A rights table as the principal carries it. Looked up with `Object.hasOwn(table, id)`, whatever the table is.
enum Table {
    /// `undefined`.
    Absent,
    /// Any other JavaScript value (`null` makes the lookup throw).
    Value(Js),
}

enum Scopes {
    Absent,
    /// Not an array: `.some` throws.
    Throws,
    /// `None`: a non-string element, on which `.endsWith` throws when the walk reaches it.
    List(Vec<Option<String>>),
}

enum GlassItem {
    /// `null` or `undefined`: `g.holderUserId` throws when `find` reaches it.
    Throws,
    Item {
        id: Js,
        holder: Option<String>,
        target: Option<String>,
        revoked: bool,
        /// `ToNumber(issuedAt)`: what `now >= g.issuedAt` compares against.
        issued: f64,
        expires: f64,
    },
}

enum Glass {
    Absent,
    /// Not an array: `.find` is not a function.
    Throws,
    List(Vec<GlassItem>),
}

struct Subject {
    user_id: String,
    kind: Option<PrincipalKind>,
    role: Role,
    agent_rights: Table,
    project_rights: Table,
    scopes: Scopes,
    glass: Glass,
}

fn table_of(v: &Js) -> Table {
    if v.is_undefined() {
        Table::Absent
    } else {
        Table::Value(v.clone())
    }
}

fn subject_from_js(p: &Js) -> Result<Subject, DenyReason> {
    match p {
        Js::Undefined | Js::Null => return Err(DenyReason::Unauthenticated),
        Js::Obj(_) | Js::Arr(_) => {}
        _ => return Err(DenyReason::InvalidPrincipal),
    }
    let user_id = match p.get("userId") {
        Js::Str(s) if !s.is_empty() => s.clone(),
        _ => return Err(DenyReason::InvalidPrincipal),
    };
    let role = match p.get("role") {
        Js::Str(s) => Role::parse(s).ok_or(DenyReason::InvalidPrincipal)?,
        _ => return Err(DenyReason::InvalidPrincipal),
    };
    let kind = match p.get("kind") {
        Js::Undefined => None,
        Js::Str(s) => Some(PrincipalKind::parse(s).ok_or(DenyReason::InvalidPrincipal)?),
        _ => return Err(DenyReason::InvalidPrincipal),
    };
    let scopes = match p.get("tokenScopes") {
        Js::Undefined => Scopes::Absent,
        Js::Arr(list) => Scopes::List(list.iter().map(|s| s.as_str().map(str::to_owned)).collect()),
        _ => Scopes::Throws,
    };
    let glass = match p.get("breakGlass") {
        Js::Undefined | Js::Null => Glass::Absent,
        Js::Arr(list) => Glass::List(
            list.iter()
                .map(|g| match g {
                    Js::Undefined | Js::Null => GlassItem::Throws,
                    g => GlassItem::Item {
                        id: g.get("id").clone(),
                        holder: g.get("holderUserId").as_str().map(str::to_owned),
                        target: g.get("targetUserId").as_str().map(str::to_owned),
                        revoked: !g.get("revokedAt").is_undefined(),
                        issued: g.get("issuedAt").to_number(),
                        expires: g.get("expiresAt").to_number(),
                    },
                })
                .collect(),
        ),
        _ => Glass::Throws,
    };
    Ok(Subject {
        user_id,
        kind,
        role,
        agent_rights: table_of(p.get("agentRights")),
        project_rights: table_of(p.get("projectRights")),
        scopes,
        glass,
    })
}

fn rights_table<R>(rights: &Option<Vec<(String, R)>>, name: impl Fn(&R) -> &'static str) -> Table {
    match rights {
        None => Table::Absent,
        Some(list) => {
            let mut obj: Vec<(String, Js)> = Vec::new();
            for (id, r) in list {
                let v = Js::Str(name(r).to_owned());
                match obj.iter_mut().find(|(k, _)| k == id) {
                    Some(slot) => slot.1 = v,
                    None => obj.push((id.clone(), v)),
                }
            }
            Table::Value(Js::Obj(obj))
        }
    }
}

fn glass_item(g: &BreakGlassGrant) -> GlassItem {
    GlassItem::Item {
        id: Js::Str(g.id.clone()),
        holder: Some(g.holder_user_id.clone()),
        target: Some(g.target_user_id.clone()),
        revoked: g.revoked_at.is_some(),
        issued: g.issued_at,
        expires: g.expires_at,
    }
}

fn subject_from_typed(p: Option<&Principal>) -> Result<Subject, DenyReason> {
    let p = p.ok_or(DenyReason::Unauthenticated)?;
    if p.user_id.is_empty() {
        return Err(DenyReason::InvalidPrincipal);
    }
    Ok(Subject {
        user_id: p.user_id.clone(),
        kind: p.kind,
        role: p.role,
        agent_rights: rights_table(&p.agent_rights, |r| r.as_str()),
        project_rights: rights_table(&p.project_rights, |r| r.as_str()),
        scopes: match &p.token_scopes {
            None => Scopes::Absent,
            Some(l) => Scopes::List(l.iter().cloned().map(Some).collect()),
        },
        glass: match &p.break_glass {
            None => Glass::Absent,
            Some(l) => Glass::List(l.iter().map(glass_item).collect()),
        },
    })
}

// --- the resource: shape and id as `shapeOf` and `idOf` read them ---------------------------------------------------------------

struct ResView {
    /// `shapeOf(r)`, `None` when it is not a string (never equal to a policy shape).
    shape: Option<String>,
    /// `idOf(r)` when it is a string.
    id: Option<String>,
    /// `r.kind === "system"`.
    is_system: bool,
    /// `r.kind === "project"`.
    is_project: bool,
}

/// `None`: the resource is not an object (`typeof resource !== "object" || resource === null`).
fn resource_from_js(r: &Js) -> Option<ResView> {
    if !matches!(r, Js::Obj(_) | Js::Arr(_)) {
        return None;
    }
    let kind = r.get("kind");
    let kind_str = kind.as_str();
    let scope = r.get("scope");
    let user_scope = scope.as_str() == Some("user");
    let shape = if kind_str != Some("memory") {
        kind_str.map(str::to_owned)
    } else if user_scope {
        Some("memory-user".to_owned())
    } else {
        Some(format!("memory-agent:{}", scope.to_js_string()))
    };
    let string_member = |k: &str| r.get(k).as_str().map(str::to_owned);
    let id = match kind_str {
        Some("system") => Some(String::new()),
        Some("user") => string_member("userId"),
        Some("agent") => string_member("agentId"),
        Some("project") => string_member("projectId"),
        Some("memory") => {
            if user_scope {
                string_member("ownerUserId")
            } else {
                string_member("agentId")
            }
        }
        _ => None,
    };
    Some(ResView {
        shape,
        id,
        is_system: kind_str == Some("system"),
        is_project: kind_str == Some("project"),
    })
}

fn resource_from_typed(r: &Resource) -> ResView {
    let (shape, id) = match r {
        Resource::System => ("system".to_owned(), String::new()),
        Resource::User { user_id } => ("user".to_owned(), user_id.clone()),
        Resource::Agent { agent_id } => ("agent".to_owned(), agent_id.clone()),
        Resource::Project { project_id } => ("project".to_owned(), project_id.clone()),
        Resource::MemoryUser { owner_user_id } => ("memory-user".to_owned(), owner_user_id.clone()),
        Resource::MemoryAgent { scope, agent_id } => {
            (format!("memory-agent:{}", scope.as_str()), agent_id.clone())
        }
    };
    ResView {
        shape: Some(shape),
        id: Some(id),
        is_system: matches!(r, Resource::System),
        is_project: matches!(r, Resource::Project { .. }),
    }
}

// --- the evaluation -------------------------------------------------------------------------------------------------------------

/// `ctx.now`, read lazily: `ctx` that is `null` makes the read throw, and the read happens only where TypeScript performs it.
struct Ctx {
    now: Result<Js, Throw>,
}

fn ctx_from_js(c: &Js) -> Ctx {
    Ctx {
        now: match c {
            Js::Null => Err(Throw),
            other => Ok(other.get("now").clone()),
        },
    }
}

fn ctx_from_typed(c: &AuthorizeContext) -> Ctx {
    Ctx {
        now: Ok(c.now.map_or(Js::Undefined, Js::Num)),
    }
}

fn scope_matches(scopes: &[Option<String>], action: &str) -> Result<bool, Throw> {
    for s in scopes {
        let s = s.as_deref().ok_or(Throw)?;
        if s == action {
            return Ok(true);
        }
        if let Some(prefix) = s.strip_suffix('*').filter(|p| p.ends_with('.')) {
            if action.starts_with(prefix) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn agent_rank(right: &str) -> Option<u8> {
    match right {
        "use" => Some(1),
        "manage" => Some(2),
        _ => None,
    }
}

fn project_rank(right: &str) -> Option<u8> {
    match right {
        "member" | "worker" | "reviewer" => Some(1),
        "lead" => Some(2),
        _ => None,
    }
}

/// `Object.hasOwn(table, id) ? table[id] : undefined`, for whatever the table is.
fn right_of(table: &Table, id: &str) -> Result<Option<Js>, Throw> {
    let t = match table {
        Table::Absent => return Ok(None),
        Table::Value(t) => t,
    };
    let canonical_index = |id: &str| -> Option<usize> {
        let n: u32 = id.parse().ok()?;
        (n != u32::MAX && n.to_string() == id).then_some(n as usize)
    };
    Ok(match t {
        Js::Null | Js::Undefined => return Err(Throw), // Object.hasOwn(null, id)
        Js::Obj(_) => t.own(id).cloned(),
        Js::Arr(list) => {
            if id == "length" {
                Some(Js::Num(list.len() as f64))
            } else {
                canonical_index(id).and_then(|i| list.get(i)).cloned()
            }
        }
        Js::Str(s) => {
            let units: Vec<u16> = s.encode_utf16().collect();
            if id == "length" {
                Some(Js::Num(units.len() as f64))
            } else {
                canonical_index(id)
                    .and_then(|i| units.get(i))
                    .map(|u| Js::Str(String::from_utf16_lossy(&[*u])))
            }
        }
        Js::Num(_) | Js::Bool(_) => None,
    })
}

fn holds_object_right(
    s: &Subject,
    spec: &ActionSpec,
    r: &ResView,
    id: &str,
) -> Result<bool, Throw> {
    let needs = match spec.needs {
        Some(n) => n,
        None => return Ok(false),
    };
    let (table, rank): (&Table, fn(&str) -> Option<u8>) = if r.is_project {
        (&s.project_rights, project_rank)
    } else {
        (&s.agent_rights, agent_rank)
    };
    let have = match right_of(table, id)? {
        Some(h) if !h.is_undefined() => h,
        _ => return Ok(false),
    };
    // `(RANK[have] ?? 0) >= (RANK[needs] ?? Infinity)`. `RANK[have]` is looked up with `String(have)` as the key, so `["use"]`
    // reads as `use`; a key that names something inherited (`constructor`, `__proto__`) is a function or object, which
    // compares false; any other key is 0, which is below every right. All of those are "no right".
    Ok(match (rank(&have.to_js_string()), rank(needs.as_str())) {
        (Some(h), Some(n)) => h >= n,
        _ => false,
    })
}

fn live_break_glass(s: &Subject, target: &str, ctx: &Ctx) -> Result<Option<Js>, Throw> {
    let now = ctx.now.clone()?;
    let now = match now.as_finite() {
        Some(n) => n,
        None => return Ok(None),
    };
    match &s.glass {
        Glass::Absent => Ok(None),
        Glass::Throws => Err(Throw),
        Glass::List(list) => {
            for g in list {
                match g {
                    GlassItem::Throws => return Err(Throw),
                    GlassItem::Item {
                        id,
                        holder,
                        target: t,
                        revoked,
                        issued,
                        expires,
                    } => {
                        if holder.as_deref() == Some(s.user_id.as_str())
                            && t.as_deref() == Some(target)
                            && !revoked
                            && now >= *issued
                            && now < *expires
                        {
                            return Ok(Some(id.clone()));
                        }
                    }
                }
            }
            Ok(None)
        }
    }
}

fn evaluate(
    g: Grant,
    s: &Subject,
    spec: &ActionSpec,
    r: &ResView,
    id: &str,
    ctx: &Ctx,
) -> Result<Option<JsDecision>, Throw> {
    let allow = |reason, id| {
        Some(JsDecision::Allow {
            reason,
            break_glass_id: id,
        })
    };
    Ok(match g {
        Grant::Allow => allow(AllowReason::Role, None),
        Grant::Own => (!id.is_empty() && id == s.user_id)
            .then(|| allow(AllowReason::Own, None))
            .flatten(),
        Grant::Object => holds_object_right(s, spec, r, id)?
            .then(|| allow(AllowReason::ObjectRight, None))
            .flatten(),
        Grant::BreakGlass => {
            let live = if !id.is_empty() && id != s.user_id {
                live_break_glass(s, id, ctx)?
            } else {
                None
            };
            live.map(|gid| JsDecision::Allow {
                reason: AllowReason::BreakGlass,
                break_glass_id: Some(gid),
            })
        }
    })
}

fn decide(
    subject: &Result<Subject, DenyReason>,
    action: Option<&str>,
    resource: &Option<ResView>,
    ctx: &Ctx,
) -> Result<JsDecision, Throw> {
    let s = match subject {
        Ok(s) => s,
        Err(d) => return Ok(deny(*d)),
    };
    let spec = match action.and_then(policy_for) {
        Some(spec) => spec,
        None => return Ok(deny(DenyReason::UnknownAction)),
    };
    let action = spec.action.as_str();
    // D109 D6, before anything else can say yes: a human-only action needs a principal that is explicitly a person.
    if spec.human_only && s.kind != Some(PrincipalKind::Person) {
        return Ok(deny(DenyReason::AgentPrincipal));
    }
    let r = match resource {
        Some(r) if r.shape.as_deref() == Some(spec.resource.as_str()) => r,
        _ => return Ok(deny(DenyReason::ResourceMismatch)),
    };
    let id = match &r.id {
        Some(id) if r.is_system || !id.is_empty() => id.as_str(),
        _ => return Ok(deny(DenyReason::ResourceMismatch)),
    };
    match &s.scopes {
        Scopes::Absent => {}
        Scopes::Throws => return Err(Throw),
        Scopes::List(list) => {
            if !scope_matches(list, action)? {
                return Ok(deny(DenyReason::TokenScope));
            }
        }
    }
    let grants = spec.grants_of(s.role);
    for g in grants {
        if let Some(d) = evaluate(*g, s, spec, r, id, ctx)? {
            return Ok(d);
        }
    }
    if grants.is_empty() {
        return Ok(deny(DenyReason::RoleDenied));
    }
    // The most specific thing the role was missing, so a UI or an audit line can say why.
    if grants.contains(&Grant::BreakGlass) {
        return Ok(deny(DenyReason::BreakGlassRequired));
    }
    if grants.contains(&Grant::Own) {
        return Ok(deny(DenyReason::NotOwner));
    }
    Ok(deny(DenyReason::ObjectRightRequired))
}

/// `authorize(principal, action, resource, ctx)` for input of any shape. `ctx` is `Js::Undefined` for "not passed".
/// `Err(Throw)` is a `TypeError` in TypeScript.
pub fn authorize_js(
    principal: &Js,
    action: &Js,
    resource: &Js,
    ctx: &Js,
) -> Result<JsDecision, Throw> {
    decide(
        &subject_from_js(principal),
        action.as_str(),
        &resource_from_js(resource),
        &ctx_from_js(ctx),
    )
}

/// `canSee(principal, action, resources, ctx)` for input of any shape: the indices of the resources that are allowed.
/// `resources` that is not an array makes `.filter` throw, and so does any throw of `authorize` on an element.
pub fn can_see_js(
    principal: &Js,
    action: &Js,
    resources: &Js,
    ctx: &Js,
) -> Result<Vec<usize>, Throw> {
    let list = match resources {
        Js::Arr(list) => list,
        _ => return Err(Throw),
    };
    let mut allowed = Vec::new();
    for (i, r) in list.iter().enumerate() {
        if authorize_js(principal, action, r, ctx)?.is_allow() {
            allowed.push(i);
        }
    }
    Ok(allowed)
}

/// `authorize` over the Rust types. `principal` `None` is "no principal at all".
pub fn authorize(
    principal: Option<&Principal>,
    action: &str,
    resource: &Resource,
    ctx: &AuthorizeContext,
) -> Decision {
    let outcome = decide(
        &subject_from_typed(principal),
        Some(action),
        &Some(resource_from_typed(resource)),
        &ctx_from_typed(ctx),
    );
    match outcome {
        Ok(JsDecision::Allow {
            reason,
            break_glass_id,
        }) => Decision::Allow {
            reason,
            break_glass_id: break_glass_id.and_then(|j| j.as_str().map(str::to_owned)),
        },
        Ok(JsDecision::Deny { reason }) => Decision::Deny { reason },
        // Unreachable by construction: a typed principal has no `null` rights table, no non-array scopes and no `null` grant.
        // Fail closed all the same.
        Err(Throw) => Decision::Deny {
            reason: DenyReason::InvalidPrincipal,
        },
    }
}

/// `canSee`: the resources the principal may see under `action`.
pub fn can_see<'a>(
    principal: Option<&Principal>,
    action: &str,
    resources: &'a [Resource],
    ctx: &AuthorizeContext,
) -> Vec<&'a Resource> {
    resources
        .iter()
        .filter(|r| authorize(principal, action, r, ctx).is_allow())
        .collect()
}
