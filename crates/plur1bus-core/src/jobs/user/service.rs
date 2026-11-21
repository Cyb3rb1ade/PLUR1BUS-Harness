//! `UserJobs` (`user-jobs/index.ts`), line by line. See [`super`] and [`crate::jobs`] for the rule.
use super::{store, UserJobOutcome, UserJobsOptions};
use crate::approvals::js_json::J;
use crate::jobs::cron::{is_valid_timezone, next_after, parse_cron};
use crate::jobs::JobsError;
use crate::js::{js_trim, utf16_len};
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, Principal, PrincipalKind, Resource, Role};
use plur1bus_store::rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use plur1bus_store::Store;
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::HashSet;

const ALLOWED_CREATE: [&str; 6] = [
    "name",
    "agentId",
    "prompt",
    "schedule",
    "enabled",
    "deliveryTarget",
];

fn denied() -> JobsError {
    JobsError::rpc("E_DENIED", "user job operation denied")
}

fn invalid() -> JobsError {
    JobsError::rpc("E_INVALID_PARAMS", "invalid user job definition")
}

fn not_available(message: &str) -> JobsError {
    JobsError::rpc("E_NOT_AVAILABLE", message)
}

/// The members of an object, `None` for anything else.
fn members(j: &J) -> Option<&Vec<(String, J)>> {
    match j {
        J::Obj(m) => Some(m),
        _ => None,
    }
}

/// `delete o[key]`.
fn remove(j: &mut J, key: &str) {
    if let J::Obj(m) = j {
        m.retain(|(k, _)| k != key);
    }
}

fn get_str<'a>(j: &'a J, key: &str) -> Option<&'a str> {
    j.get(key).and_then(J::as_str)
}

/// `Boolean(v)` of a parsed value.
fn truthy(v: Option<&J>) -> bool {
    match v {
        None | Some(J::Null) | Some(J::Bool(false)) => false,
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `/^[a-z0-9][a-z0-9_-]{0,63}$/`: ASCII only, no trailing line feed (`$` without the `m` flag matches at the end only).
fn agent_id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// `/[\u0000-\u001f\u007f]/.test(s)`.
fn has_control(s: &str) -> bool {
    s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn num(n: i64) -> J {
    J::Num(n as f64)
}

/// A `visible`-style test over a record of the job or of a run: owner and admin see everything, a person sees what runs as
/// them, anyone holding a right on the agent sees what runs on it.
fn can_see(p: &Principal, run_as: Option<&J>, agent_id: Option<&J>) -> bool {
    if matches!(p.role, Role::Owner | Role::Admin) {
        return true;
    }
    if let Some(J::Str(r)) = run_as {
        if *r == p.user_id {
            return true;
        }
    }
    // `Object.hasOwn(rights, agentId) && ["use", "manage"].includes(rights[agentId])`: a right is `use` or `manage`.
    match (agent_id, &p.agent_rights) {
        (Some(J::Str(a)), Some(rights)) => rights.iter().any(|(k, _)| k == a),
        _ => false,
    }
}

/// The service.
pub struct UserJobs {
    store: Store,
    o: UserJobsOptions,
    audit: RefCell<Box<dyn AuditSink>>,
    running: RefCell<HashSet<String>>,
    closed: Cell<bool>,
}

impl UserJobs {
    /// The constructor: opens the store and turns every run that was interrupted (`running`) into an `abandoned` record. A
    /// claimed slot is never replayed.
    pub fn open(mut o: UserJobsOptions) -> Result<Self, JobsError> {
        let store = store::open(&o.path, o.secure_path.as_ref())?;
        let audit = RefCell::new(std::mem::replace(
            &mut o.audit,
            Box::new(|_: &AuditEvent| Ok(())),
        ));
        let jobs = Self {
            store,
            o,
            audit,
            running: RefCell::new(HashSet::new()),
            closed: Cell::new(false),
        };
        let rows: Vec<(String, String)> = {
            let mut st = jobs
                .conn()?
                .prepare("SELECT id,record FROM user_job_runs")?;
            let it = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            it.collect::<Result<_, _>>()?
        };
        for (id, record) in rows {
            let mut run = parse(&record, "a user job run")?;
            if get_str(&run, "outcome") == Some("running") {
                let finished = jobs.o.clock.now();
                // `finishedAt - startedAt` coerces: a text start (`"5"`) is a number, a missing one is NaN (stored as null).
                let started = run.get("startedAt").map(J::to_value);
                let started =
                    crate::policy::js_value::to_number(started.as_ref()).unwrap_or(f64::NAN);
                run.set("outcome", J::s("abandoned"));
                run.set("finishedAt", num(finished));
                run.set("durationMs", J::Num(finished as f64 - started));
                jobs.conn()?.execute(
                    "UPDATE user_job_runs SET record=? WHERE id=?",
                    params![run.stringify(), id],
                )?;
            }
        }
        Ok(jobs)
    }

    /// The connection; a closed service has none (`database is not open`).
    fn conn(&self) -> Result<&plur1bus_store::rusqlite::Connection, JobsError> {
        if self.closed.get() {
            return Err(JobsError::Other("database is not open".into()));
        }
        Ok(self.store.conn())
    }

    fn now(&self) -> i64 {
        self.o.clock.now()
    }

    fn stopping(&self) -> bool {
        self.o.is_stopping.as_ref().is_some_and(|f| f())
    }

    /// `close()`.
    pub fn close(&self) {
        self.closed.set(true);
    }

    /// `has(id)`.
    pub fn has(&self, id: &str) -> Result<bool, JobsError> {
        Ok(self
            .conn()?
            .query_row("SELECT id FROM user_jobs WHERE id=?", [id], |_| Ok(()))
            .map(|()| true)
            .or_else(|e| match e {
                plur1bus_store::rusqlite::Error::QueryReturnedNoRows => Ok(false),
                other => Err(other),
            })?)
    }

    /// `get(id)`: the job as stored. Unauthenticated, as in TypeScript: the RPC layer authorizes before it calls.
    pub fn get(&self, id: &str) -> Result<J, JobsError> {
        parse(&self.source(id)?, "a user job")
    }

    fn source(&self, id: &str) -> Result<String, JobsError> {
        if self.closed.get() {
            return Err(not_available("user jobs are closed"));
        }
        let row: Option<String> = self
            .conn()?
            .query_row("SELECT definition FROM user_jobs WHERE id=?", [id], |r| {
                r.get(0)
            })
            .map(Some)
            .or_else(|e| match e {
                plur1bus_store::rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        match row {
            Some(text) => Ok(text),
            None if id.starts_with("user:") => Err(JobsError::Rpc {
                code: "E_NOT_FOUND",
                message: "user job not found".into(),
                detail: Some(serde_json::json!({"reason": "job-not-found"})),
            }),
            None => Err(JobsError::Rpc {
                code: "E_DENIED",
                message: "system and engine jobs are immutable".into(),
                detail: Some(serde_json::json!({"reason": "immutable-system-job"})),
            }),
        }
    }

    /// `#person`.
    fn person(&self, p: &Principal) -> Result<(), JobsError> {
        if self.closed.get() || self.stopping() {
            return Err(not_available("the core is stopping"));
        }
        if p.kind != Some(PrincipalKind::Person) || p.user_id.is_empty() {
            return Err(denied());
        }
        Ok(())
    }

    fn allowed(&self, p: &Principal, action: &str, resource: &Resource) -> bool {
        authorize(
            Some(p),
            action,
            resource,
            &AuthorizeContext {
                now: Some(self.now() as f64),
            },
        )
        .is_allow()
    }

    fn agent(id: &str) -> Resource {
        Resource::Agent {
            agent_id: id.to_owned(),
        }
    }

    /// `#read`: `agent.list` on the installation.
    fn read(&self, p: &Principal) -> Result<(), JobsError> {
        self.person(p)?;
        if !self.allowed(p, "agent.list", &Resource::System) {
            return Err(denied());
        }
        Ok(())
    }

    /// `#manage`.
    fn manage(&self, p: &Principal, agent_id: &str) -> Result<(), JobsError> {
        self.person(p)?;
        if !self.allowed(p, "agent.manage", &Self::agent(agent_id)) {
            return Err(denied());
        }
        Ok(())
    }

    /// `#use`.
    fn use_(&self, p: &Principal, agent_id: &str) -> Result<(), JobsError> {
        self.person(p)?;
        if !self.allowed(p, "agent.use", &Self::agent(agent_id)) {
            return Err(denied());
        }
        Ok(())
    }

    /// `#visible`.
    fn visible(&self, p: &Principal, job: &J) -> Result<bool, JobsError> {
        self.person(p)?;
        Ok(can_see(p, job.get("runAs"), job.get("agentId")))
    }

    /// `#delivery`: the delivery target of a definition, checked by the port, for the person the job runs as.
    fn delivery(&self, i: &J, person: &str) -> Result<(), JobsError> {
        match i.get("deliveryTarget") {
            None => Ok(()),
            Some(J::Str(s)) if s.is_empty() => Ok(()),
            Some(J::Str(target)) => match &self.o.validate_delivery {
                Some(f) => f(target, person, get_str(i, "agentId").unwrap_or_default()),
                None => Err(denied()),
            },
            Some(_) => Err(denied()),
        }
    }

    /// `#validate`: the shape of a definition, field by field, as `typeof` and the regular expressions see it.
    fn validate(&self, i: &J) -> Result<(), JobsError> {
        let name = i.get("name");
        let prompt = i.get("prompt");
        let (Some(J::Str(name)), Some(J::Str(prompt))) = (name, prompt) else {
            return Err(invalid());
        };
        if js_trim(name).is_empty()
            || utf16_len(name) > 128
            || has_control(name)
            || js_trim(prompt).is_empty()
            || utf16_len(prompt) > 4000
            || prompt.contains('\0')
            || !matches!(i.get("enabled"), Some(J::Bool(_)))
        {
            return Err(invalid());
        }
        let Some(J::Str(agent_id)) = i.get("agentId") else {
            return Err(invalid());
        };
        if !agent_id_ok(agent_id) || !(self.o.agent_exists)(agent_id) {
            return Err(invalid());
        }
        let Some(schedule) = i.get("schedule").filter(|s| matches!(s, J::Obj(_))) else {
            return Err(invalid());
        };
        let (Some(J::Str(cron)), Some(J::Str(tz))) =
            (schedule.get("cron"), schedule.get("timezone"))
        else {
            return Err(invalid());
        };
        if members(schedule).is_some_and(|m| m.iter().any(|(k, _)| k != "cron" && k != "timezone"))
            || utf16_len(cron) > 128
            || utf16_len(tz) > 128
            || !is_valid_timezone(tz)
        {
            return Err(invalid());
        }
        // An expression that parses but never matches a real date (30 February) would leave an enabled job that never runs.
        match parse_cron(cron).and_then(|c| next_after(&c, tz, self.now())) {
            Ok(Some(_)) => Ok(()),
            _ => Err(invalid()),
        }
    }

    /// `#next`.
    fn next(&self, i: &J, at: i64) -> Result<J, JobsError> {
        if !truthy(i.get("enabled")) {
            return Ok(J::Null);
        }
        let schedule = i.get("schedule");
        let cron = schedule
            .and_then(|s| get_str(s, "cron"))
            .unwrap_or_default();
        let tz = schedule
            .and_then(|s| get_str(s, "timezone"))
            .unwrap_or_default();
        Ok(next_after(&parse_cron(cron)?, tz, at)?.map_or(J::Null, num))
    }

    /// `#audit`: an event that cannot be recorded stops the change before it is made.
    fn audit(
        &self,
        p: &Principal,
        action: &str,
        id: &str,
        detail: Vec<(String, Value)>,
    ) -> Result<(), JobsError> {
        let e = AuditEvent {
            at: self.now(),
            user: p.user_id.clone(),
            host: "core".into(),
            action: action.into(),
            target: id.to_owned(),
            detail,
        };
        self.audit
            .borrow_mut()
            .append(&e)
            .map_err(|_| JobsError::rpc("E_STORAGE", "user job change could not be audited"))
    }

    /// `#save`.
    fn save(&self, j: &J) -> Result<(), JobsError> {
        let id = get_str(j, "id").unwrap_or_default();
        self.conn()?.execute(
            "INSERT INTO user_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition",
            params![id, j.stringify()],
        )?;
        Ok(())
    }

    /// `create(input, principal)`.
    pub fn create(&self, input: &J, p: &Principal) -> Result<J, JobsError> {
        let Some(m) = members(input) else {
            return Err(invalid());
        };
        if m.iter().any(|(k, _)| !ALLOWED_CREATE.contains(&k.as_str())) {
            return Err(invalid());
        }
        // Authorize before looking at the agent, so a caller without rights cannot probe which agents exist.
        self.person(p)?;
        let Some(J::Str(agent_id)) = input.get("agentId") else {
            return Err(invalid());
        };
        if !agent_id_ok(agent_id) {
            return Err(invalid());
        }
        self.manage(p, agent_id)?;
        self.use_(p, agent_id)?;
        self.validate(input)?;
        self.delivery(input, &p.user_id)?;
        let now = self.now();
        let mut job = input.clone();
        let name = js_trim(get_str(input, "name").unwrap_or_default());
        job.set("name", J::s(name));
        job.set("id", J::Str(format!("user:{}", self.o.ids.next_id())));
        job.set("kind", J::s("user"));
        job.set("needsLlm", J::Bool(true));
        job.set("singleton", J::Bool(true));
        job.set("runAs", J::s(&p.user_id));
        job.set("createdBy", J::s(&p.user_id));
        job.set("createdAt", num(now));
        job.set("updatedAt", num(now));
        job.set("nextRunAt", self.next(input, now)?);
        let id = get_str(&job, "id").unwrap_or_default().to_owned();
        self.audit(
            p,
            "jobs.created",
            &id,
            vec![
                ("agentId".into(), Value::String(agent_id.clone())),
                ("runAs".into(), Value::String(p.user_id.clone())),
            ],
        )?;
        self.save(&job)?;
        Ok(job)
    }

    /// Edits a job's definition while retaining its execution identity.
    pub fn update(&self, patch: &J, p: &Principal) -> Result<J, JobsError> {
        let Some(m) = members(patch) else {
            return Err(invalid());
        };
        if m.iter()
            .any(|(k, _)| k != "id" && !ALLOWED_CREATE.contains(&k.as_str()))
        {
            return Err(invalid());
        }
        let Some(J::Str(id)) = patch.get("id") else {
            return Err(invalid());
        };
        let observed = self.source(id)?;
        let old = parse(&observed, "a user job")?;
        self.manage(p, get_str(&old, "agentId").unwrap_or_default())?;
        let mut next = old.clone();
        for (k, v) in m {
            next.set(k, v.clone());
        }
        next.set("updatedAt", num(self.now()));
        self.validate(&next)?;
        self.delivery(&next, &p.user_id)?;
        let run_as = get_str(&old, "runAs").ok_or_else(invalid)?;
        if run_as != p.user_id {
            self.delivery(&next, run_as)?;
        }
        let trimmed = js_trim(get_str(&next, "name").unwrap_or_default());
        next.set("name", J::s(trimmed));
        let agent_id = get_str(&next, "agentId").unwrap_or_default().to_owned();
        self.manage(p, &agent_id)?;
        let live = (self.o.resolve)(&p.user_id);
        let enabled = truthy(next.get("enabled"));
        if enabled {
            match &live {
                Some(l) if l.user_id == p.user_id => {}
                _ => return Err(denied()),
            }
            self.use_(live.as_ref().unwrap_or(p), &agent_id)?;
            remove(&mut next, "disabledReason");
        }
        let at = self.now();
        let nra = self.next(&next, at)?;
        next.set("nextRunAt", nra);
        self.audit(
            p,
            "jobs.updated",
            id,
            vec![
                ("agentId".into(), Value::String(agent_id)),
                ("oldRunAs".into(), Value::String(run_as.to_owned())),
                ("runAs".into(), Value::String(run_as.to_owned())),
            ],
        )?;
        self.save_edit(id, &observed, &next)?;
        Ok(next)
    }

    /// Changes the job to run as the authenticated editor. The caller must explicitly choose this operation.
    pub fn take_over(&self, id: &str, p: &Principal) -> Result<J, JobsError> {
        let observed = self.source(id)?;
        let mut job = parse(&observed, "a user job")?;
        let agent_id = get_str(&job, "agentId").unwrap_or_default().to_owned();
        self.manage(p, &agent_id)?;
        let live = (self.o.resolve)(&p.user_id)
            .filter(|principal| principal.user_id == p.user_id)
            .ok_or_else(denied)?;
        self.manage(&live, &agent_id)?;
        self.use_(&live, &agent_id)?;
        let previous = get_str(&job, "runAs").ok_or_else(invalid)?.to_owned();
        if previous == p.user_id {
            return Ok(job);
        }
        self.delivery(&job, &p.user_id)?;
        self.audit(
            p,
            "jobs.runAs.changed",
            id,
            vec![
                ("agentId".into(), Value::String(agent_id)),
                ("oldRunAs".into(), Value::String(previous)),
                ("runAs".into(), Value::String(p.user_id.clone())),
            ],
        )?;
        job.set("runAs", J::s(&p.user_id));
        job.set("updatedAt", num(self.now()));
        self.save_edit(id, &observed, &job)?;
        Ok(job)
    }

    fn save_edit(&self, id: &str, observed: &str, next: &J) -> Result<(), JobsError> {
        if self.conn()?.execute(
            "UPDATE user_jobs SET definition=? WHERE id=? AND definition=?",
            params![next.stringify(), id, observed],
        )? != 1
        {
            return Err(JobsError::rpc(
                "E_CONFLICT",
                "user job changed before it could be updated",
            ));
        }
        Ok(())
    }

    /// `delete(id, confirm, principal)`.
    pub fn delete(&self, id: &str, confirm: &J, p: &Principal) -> Result<J, JobsError> {
        if !matches!(confirm, J::Bool(true)) {
            return Err(invalid());
        }
        let j = self.get(id)?;
        self.manage(p, get_str(&j, "agentId").unwrap_or_default())?;
        if self.running.borrow().contains(id) {
            return Err(JobsError::rpc("E_CONFLICT", "user job is running"));
        }
        self.audit(
            p,
            "jobs.deleted",
            id,
            vec![(
                "runAs".into(),
                j.get("runAs").map_or(Value::Null, J::to_value),
            )],
        )?;
        self.conn()?
            .execute("DELETE FROM user_jobs WHERE id=?", [id])?;
        Ok(J::obj([("id", J::s(id)), ("deleted", J::Bool(true))]))
    }

    /// `targets(principal)`: the agents the person may manage.
    pub fn targets(&self, p: &Principal) -> Result<Vec<String>, JobsError> {
        self.read(p)?;
        let agents = self.o.agents.as_ref().map(|f| f()).unwrap_or_default();
        Ok(agents
            .into_iter()
            .filter(|a| {
                (self.o.agent_exists)(a) && self.allowed(p, "agent.manage", &Self::agent(a))
            })
            .collect())
    }

    /// `list(principal)`: the jobs the person may see, by id.
    pub fn list(&self, p: &Principal) -> Result<Vec<J>, JobsError> {
        self.read(p)?;
        let texts: Vec<String> = {
            let mut st = self
                .conn()?
                .prepare("SELECT definition FROM user_jobs ORDER BY id")?;
            let rows = st.query_map([], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut out = Vec::new();
        for t in texts {
            let j = parse(&t, "a user job")?;
            if self.visible(p, &j)? {
                out.push(j);
            }
        }
        Ok(out)
    }

    /// `history(id, principal, limit)`: newest first, the runs the person may see, at most `limit` (default 50, at most
    /// 200, at least 1; `NaN` gives none, as `slice(0, NaN)` does).
    pub fn history(
        &self,
        id: Option<&str>,
        p: &Principal,
        limit: Option<f64>,
    ) -> Result<Vec<J>, JobsError> {
        self.read(p)?;
        let texts: Vec<String> = {
            let mut st = self
                .conn()?
                .prepare("SELECT record FROM user_job_runs ORDER BY rowid DESC")?;
            let rows = st.query_map([], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut runs = Vec::new();
        for t in texts {
            let r = parse(&t, "a user job run")?;
            let of_job = id.is_none_or(|i| i.is_empty() || get_str(&r, "jobId") == Some(i));
            if can_see(p, r.get("runAs"), r.get("agentId")) && of_job {
                runs.push(r);
            }
        }
        let n = limit.unwrap_or(50.0);
        let take = if n.is_nan() {
            0
        } else {
            n.clamp(1.0, 200.0).trunc() as usize
        };
        runs.truncate(take);
        Ok(runs)
    }

    /// `tick()`: runs every job whose slot is due, one after the other. A host calls it when its timer fires.
    pub fn tick(&self) -> Result<(), JobsError> {
        if self.closed.get() || self.stopping() {
            return Ok(());
        }
        let texts: Vec<String> = {
            let mut st = self.conn()?.prepare("SELECT definition FROM user_jobs")?;
            let rows = st.query_map([], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut due = Vec::new();
        for t in texts {
            let j = parse(&t, "a user job")?;
            if self.is_due(&j) {
                due.push(j);
            }
        }
        for snapshot in due {
            if self.closed.get() || self.stopping() {
                return Ok(());
            }
            let id = get_str(&snapshot, "id").unwrap_or_default().to_owned();
            if self.running.borrow().contains(&id) || !self.has(&id)? {
                continue;
            }
            // Another overlapping scan or an edit may have advanced this slot while a previous job was awaiting approval.
            let current = self.get(&id)?;
            if self.is_due(&current) && current.get("nextRunAt") == snapshot.get("nextRunAt") {
                self.start(&current, None)?;
            }
        }
        Ok(())
    }

    /// `enabled && nextRunAt !== null && nextRunAt <= clock()`.
    fn is_due(&self, j: &J) -> bool {
        self.is_due_at(j, self.now())
    }

    fn is_due_at(&self, j: &J, at: i64) -> bool {
        truthy(j.get("enabled"))
            && match j.get("nextRunAt") {
                Some(J::Null) => false,
                // `undefined !== null`, and `undefined <= n` is false; a string or boolean converts as `Number(...)` does.
                other => other
                    .map(J::to_value)
                    .and_then(|v| crate::policy::js_value::to_number(Some(&v)).ok())
                    .is_some_and(|n| n <= at as f64),
            }
    }

    /// `run(id, principal)`: a run on request. It claims the next slot like a scheduled one and runs as the job's `runAs`.
    pub fn run(&self, id: &str, p: &Principal) -> Result<J, JobsError> {
        let j = self.get(id)?;
        self.use_(p, get_str(&j, "agentId").unwrap_or_default())?;
        if !truthy(j.get("enabled")) {
            return Err(JobsError::rpc("E_CONFLICT", "user job is disabled"));
        }
        self.start(&j, Some(&p.user_id))?
            .ok_or_else(|| JobsError::rpc("E_CONFLICT", "user job changed before it could run"))
    }

    /// `#run` and `#executeRun`.
    fn start(&self, j: &J, requested_by: Option<&str>) -> Result<Option<J>, JobsError> {
        let id = get_str(j, "id").unwrap_or_default().to_owned();
        if self.running.borrow().contains(&id) {
            return Err(JobsError::rpc("E_CONFLICT", "user job already running"));
        }
        self.running.borrow_mut().insert(id.clone());
        let out = self.execute(j, requested_by);
        self.running.borrow_mut().remove(&id);
        out
    }

    fn execute(&self, j: &J, requested_by: Option<&str>) -> Result<Option<J>, JobsError> {
        let id = get_str(j, "id").unwrap_or_default().to_owned();
        let started_at = self.now();
        let run_as = get_str(j, "runAs").unwrap_or_default().to_owned();
        let agent_id = get_str(j, "agentId").unwrap_or_default().to_owned();
        let display = match self.o.display_name.as_ref().map(|f| f(&run_as)) {
            Some(Ok(Some(d))) => d,
            _ => run_as.clone(),
        };
        let run_id = self.o.ids.next_id();
        let mut record = J::obj([
            ("runId", J::s(&run_id)),
            ("jobId", J::s(&id)),
            ("agentId", J::s(&agent_id)),
            ("job", j.get("name").cloned().unwrap_or(J::Null)),
            ("kind", J::s("user")),
            ("runAs", J::s(&run_as)),
            ("runAsDisplayName", J::s(&display)),
            ("trigger", J::s("recurring")),
        ]);
        if let Some(by) = requested_by.filter(|b| !b.is_empty()) {
            record.set("requestedBy", J::s(by));
        }
        record.set("startedAt", num(started_at));
        record.set("finishedAt", num(started_at));
        record.set("durationMs", num(0));
        record.set("outcome", J::s("abandoned"));
        // The claim and future slot advance are one SQLite transaction, before any turn can start.
        let tx = Transaction::new_unchecked(self.conn()?, TransactionBehavior::Immediate)?;
        let Some(observed) = tx
            .query_row("SELECT definition FROM user_jobs WHERE id=?", [&id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
        else {
            return Ok(None);
        };
        let mut latest = parse(&observed, "a user job")?;
        if latest != *j || (requested_by.is_none() && !self.is_due_at(&latest, started_at)) {
            return Ok(None);
        }
        let next_slot = self.next(&latest, started_at)?;
        latest.set("nextRunAt", next_slot);
        if tx.execute(
            "UPDATE user_jobs SET definition=? WHERE id=? AND definition=?",
            params![latest.stringify(), id, observed],
        )? != 1
        {
            return Ok(None);
        }
        let mut running = record.clone();
        running.set("outcome", J::s("running"));
        tx.execute(
            "INSERT INTO user_job_runs VALUES (?,?,?)",
            params![run_id, id, running.stringify()],
        )?;
        tx.commit()?;
        let outcome = self.decide(j, &run_as, &agent_id, started_at);
        let finished_at = self.now();
        record.set("outcome", J::s(&outcome));
        record.set("finishedAt", num(finished_at));
        record.set("durationMs", num((finished_at - started_at).max(0)));
        self.conn()?.execute(
            "UPDATE user_job_runs SET record=? WHERE id=?",
            params![record.stringify(), run_id],
        )?;
        if [
            "skipped_owner_inactive",
            "skipped_no_rights",
            "skipped_agent_missing",
        ]
        .contains(&outcome.as_str())
        {
            let mut latest = self.get(&id)?;
            latest.set("enabled", J::Bool(false));
            latest.set("nextRunAt", J::Null);
            latest.set("disabledReason", J::Str(outcome.clone()));
            self.save(&latest)?;
            let _ = (self.o.notify)(&record);
        }
        if let Some(f) = &self.o.on_recorded {
            let _ = f(&record);
        }
        Ok(Some(record))
    }

    /// What the run came to: the checks in their order, and the turn when they all pass. Anything a port throws is `failed`.
    fn decide(&self, j: &J, run_as: &str, agent_id: &str, started_at: i64) -> String {
        let person = (self.o.resolve)(run_as);
        if !(self.o.agent_exists)(agent_id) {
            return UserJobOutcome::SkippedAgentMissing.as_str().into();
        }
        let person = match person {
            Some(p) if p.kind == Some(PrincipalKind::Person) && p.user_id == run_as => p,
            _ => return UserJobOutcome::SkippedOwnerInactive.as_str().into(),
        };
        let may = authorize(
            Some(&person),
            "agent.use",
            &Self::agent(agent_id),
            &AuthorizeContext {
                now: Some(started_at as f64),
            },
        )
        .is_allow();
        if !may {
            return UserJobOutcome::SkippedNoRights.as_str().into();
        }
        if self.delivery(j, &person.user_id).is_err() {
            return UserJobOutcome::Failed.as_str().into();
        }
        if (self.o.budget_blocked)(agent_id) {
            return UserJobOutcome::SkippedBudget.as_str().into();
        }
        match (self.o.submit_turn)(j, &person) {
            Ok(o) => o.as_str().into(),
            Err(_) => UserJobOutcome::Failed.as_str().into(),
        }
    }
}

fn parse(text: &str, what: &str) -> Result<J, JobsError> {
    J::parse(text).ok_or_else(|| JobsError::Other(format!("{what} does not parse")))
}
