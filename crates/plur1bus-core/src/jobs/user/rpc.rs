//! The logic of `user-jobs/rpc.ts` (`attachUserJobMethods`): which caller may use the user paths of `jobs.list`, `jobs.history`
//! and `jobs.run`, how their answers merge with the legacy handlers' answers, the filters on a history and the refusals of a
//! run. The routing itself (a method table, the call context, `authenticatedPrincipal`) is the front door's and is not here:
//! the host resolves the caller once, hands the legacy handler over as a function, and gets the answer the TypeScript handler
//! gives. `jobs.create`, `jobs.update` and `jobs.delete` only pass the authenticated principal through to the service and are
//! called on [`UserJobs`] directly.
//!
//! The parameters are what a client sent, so every read is the JavaScript one: `p.job?.startsWith` throws for a value that is
//! no string, a `since` is compared with `>=` as JavaScript does (two strings by code unit, otherwise as numbers), a
//! `limit` goes through `Math.max`.
use super::UserJobs;
use crate::approvals::js_json::J;
use crate::jobs::JobsError;
use crate::policy::js_value::{strict_eq, to_js_string, to_number, truthy};
use crate::rbac::types::{Principal, PrincipalKind};
use serde_json::Value;

/// The legacy handler of the same method, called with the parameters as they came.
pub type Legacy<'a> = &'a dyn Fn(&J) -> Result<J, JobsError>;

/// The service behind the user paths.
pub struct UserJobsRpc<'a> {
    jobs: &'a UserJobs,
}

fn type_error(m: &str) -> JobsError {
    JobsError::Other(format!("TypeError: {m}"))
}

/// `who(ctx, method, p)`: a resolved person, or a refusal that says why.
pub fn who(resolved: Option<&Principal>) -> Result<&Principal, JobsError> {
    let person =
        resolved.ok_or_else(|| JobsError::rpc("E_UNAUTHORIZED", "authentication required"))?;
    if person.kind != Some(PrincipalKind::Person) {
        return Err(JobsError::rpc("E_DENIED", "user jobs are human-only"));
    }
    Ok(person)
}

/// `p.x` of the parameters: absent for anything that is no object (a string or a number has no such members).
fn member<'a>(p: &'a J, key: &str) -> Option<&'a J> {
    match p {
        J::Obj(_) => p.get(key),
        _ => None,
    }
}

fn is_str(v: Option<&J>, expected: &str) -> bool {
    matches!(v, Some(J::Str(s)) if s == expected)
}

/// `p.job?.startsWith("user:")`: nothing for `null` and `undefined`, a `TypeError` for a value that is no string.
fn user_job_id(p: &J) -> Result<bool, JobsError> {
    match member(p, "job") {
        None | Some(J::Null) => Ok(false),
        Some(J::Str(s)) => Ok(s.starts_with("user:")),
        Some(_) => Err(type_error("p.job?.startsWith is not a function")),
    }
}

/// The object a handler reads its parameters from: `p = {}` where none were sent, a `TypeError` for `null`.
fn params(p: Option<&J>) -> Result<J, JobsError> {
    match p {
        None => Ok(J::Obj(Vec::new())),
        Some(J::Null) => Err(type_error("Cannot read properties of null")),
        Some(other) => Ok(other.clone()),
    }
}

/// `[...x]`: the elements of an array, the code points of a string, a `TypeError` for anything else.
fn spread(x: Option<&J>, what: &str) -> Result<Vec<J>, JobsError> {
    match x {
        Some(J::Arr(a)) => Ok(a.clone()),
        Some(J::Str(s)) => Ok(s.chars().map(|c| J::Str(c.to_string())).collect()),
        _ => Err(type_error(&format!("{what} is not iterable"))),
    }
}

fn v(j: Option<&J>) -> Option<Value> {
    j.map(J::to_value)
}

/// `ToPrimitive` of a JSON value for a comparison: an array or object is its string form.
fn primitive(v: &Value) -> Result<Value, JobsError> {
    match v {
        Value::Array(_) | Value::Object(_) => {
            Ok(Value::String(to_js_string(v).map_err(|_| {
                type_error("Cannot convert object to primitive value")
            })?))
        }
        other => Ok(other.clone()),
    }
}

/// `a >= b`: two strings compare by UTF-16 code unit, anything else as numbers (`NaN` is never greater or equal).
fn js_ge(a: Option<&Value>, b: &Value) -> Result<bool, JobsError> {
    let a = a.map(primitive).transpose()?;
    let b = primitive(b)?;
    if let (Some(Value::String(x)), Value::String(y)) = (&a, &b) {
        return Ok(x.encode_utf16().cmp(y.encode_utf16()) != std::cmp::Ordering::Less);
    }
    let na = to_number(a.as_ref())
        .map_err(|_| type_error("Cannot convert object to primitive value"))?;
    let nb =
        to_number(Some(&b)).map_err(|_| type_error("Cannot convert object to primitive value"))?;
    Ok(na >= nb)
}

impl<'a> UserJobsRpc<'a> {
    /// The user paths over this service.
    pub fn new(jobs: &'a UserJobs) -> Self {
        Self { jobs }
    }

    fn user_list(&self, person: &Principal) -> Result<(J, J), JobsError> {
        let jobs = J::Arr(self.jobs.list(person)?);
        let agents = J::Arr(self.jobs.targets(person)?.iter().map(|a| J::s(a)).collect());
        Ok((jobs, agents))
    }

    /// `"jobs.list"`.
    pub fn list(
        &self,
        p: Option<&J>,
        resolved: Option<&Principal>,
        legacy: Legacy<'_>,
    ) -> Result<J, JobsError> {
        let p = params(p)?;
        let kind = member(&p, "kind");
        if is_str(kind, "user") {
            let person = who(resolved)?;
            let (jobs, agents) = self.user_list(person)?;
            return Ok(J::obj([("jobs", jobs), ("manageableAgents", agents)]));
        }
        let mut old = legacy(&p)?;
        if !is_str(kind, "all") {
            return Ok(old);
        }
        let person = resolved.filter(|r| r.kind == Some(PrincipalKind::Person));
        let mut jobs = spread(old.get("jobs"), "old.jobs")?;
        let mut agents = None;
        if let Some(person) = person {
            let (user, targets) = self.user_list(person)?;
            if let J::Arr(user) = user {
                jobs.extend(user);
            }
            agents = Some(targets);
        }
        old.set("jobs", J::Arr(jobs));
        if let Some(a) = agents {
            old.set("manageableAgents", a);
        }
        Ok(old)
    }

    /// `jobs.history(p.job, person, p.limit)` as the handler calls it.
    fn runs(&self, p: &J, person: &Principal) -> Result<Vec<J>, JobsError> {
        // `!id` is false for a truthy value that is no string; no job id equals one, so it stands for "no run".
        let job = member(p, "job");
        let id: Option<String> = match job {
            Some(J::Str(s)) => Some(s.clone()),
            other if truthy(v(other).as_ref()) => Some("\u{0}not a job id".into()),
            _ => None,
        };
        let limit = match member(p, "limit") {
            None => None,
            Some(l) => Some(
                to_number(Some(&l.to_value()))
                    .map_err(|_| type_error("Cannot convert object to primitive value"))?,
            ),
        };
        self.jobs.history(id.as_deref(), person, limit)
    }

    fn since(p: &J, runs: Vec<J>) -> Result<Vec<J>, JobsError> {
        let Some(since) = member(p, "since") else {
            return Ok(runs);
        };
        let since = since.to_value();
        let mut out = Vec::new();
        for r in runs {
            if js_ge(v(r.get("startedAt")).as_ref(), &since)? {
                out.push(r);
            }
        }
        Ok(out)
    }

    /// `"jobs.history"`.
    pub fn history(
        &self,
        p: Option<&J>,
        resolved: Option<&Principal>,
        legacy: Legacy<'_>,
    ) -> Result<J, JobsError> {
        let p = params(p)?;
        let kind = member(&p, "kind");
        if is_str(kind, "user") || user_job_id(&p)? {
            let person = who(resolved)?;
            let mut runs = Self::since(&p, self.runs(&p, person)?)?;
            if let Some(agent) = member(&p, "agentId") {
                let want = agent.to_value();
                runs.retain(|r| strict_eq(v(r.get("agentId")).as_ref(), Some(&want)));
            }
            return Ok(J::obj([("runs", J::Arr(runs))]));
        }
        let old = legacy(&p)?;
        if !is_str(kind, "all") {
            return Ok(old);
        }
        let person = who(resolved)?;
        let mut runs = spread(old.get("runs"), "old.runs")?;
        let user = self.jobs.history(
            None,
            person,
            match member(&p, "limit") {
                None => None,
                Some(l) => Some(
                    to_number(Some(&l.to_value()))
                        .map_err(|_| type_error("Cannot convert object to primitive value"))?,
                ),
            },
        )?;
        runs.extend(Self::since(&p, user)?);
        Ok(J::obj([("runs", J::Arr(runs))]))
    }

    /// `"jobs.run"`.
    pub fn run(
        &self,
        p: Option<&J>,
        resolved: Option<&Principal>,
        legacy: Legacy<'_>,
    ) -> Result<J, JobsError> {
        let p = params(p)?;
        if !user_job_id(&p)? {
            return legacy(&p);
        }
        if truthy(v(member(&p, "dryRun")).as_ref()) || member(&p, "args").is_some() {
            return Err(JobsError::rpc(
                "E_INVALID_PARAMS",
                "user jobs do not accept dryRun or args",
            ));
        }
        let principal = who(resolved)?;
        let id = match member(&p, "job") {
            Some(J::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let job = self.jobs.get(&id)?;
        if let Some(agent) = member(&p, "agentId") {
            if !strict_eq(Some(&agent.to_value()), v(job.get("agentId")).as_ref()) {
                return Err(JobsError::rpc(
                    "E_INVALID_PARAMS",
                    "agentId does not match the job",
                ));
            }
        }
        self.jobs.run(&id, principal)
    }
}
