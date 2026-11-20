use super::{CollabError, CollabService, Principal, PrincipalKind, Project, Resource, C, R};
use crate::collab::replay::{redacted_rows, restore_provenance, ReplaySessions, ReplayTranscript};
use crate::collab::repo::{self, BindRepoPorts};
use crate::policy::fs_paths::PathFs;
use crate::rbac::audit::{AuditEvent, AuditSink};

impl CollabService {
    fn require_repo_lead(&self, principal: &Principal, project_id: &str) -> R<()> {
        if principal.kind != Some(PrincipalKind::Person) {
            return Err(CollabError::with_reason(
                C::Unauthorized,
                "only a person may bind a repository",
                "agent-principal",
            ));
        }
        self.authz(principal, "project.surface.write", &Resource::System)?;
        let project = self.live_project(project_id)?;
        if !project
            .members
            .iter()
            .any(|m| m.user_id == principal.user_id && m.role == "lead")
        {
            return Err(CollabError::with_reason(
                C::Unauthorized,
                "repository binding requires a project lead",
                "lead-required",
            ));
        }
        Ok(())
    }

    fn audit_repo_change(
        &self,
        principal: &Principal,
        project: &str,
        action: &str,
        audit: &mut dyn AuditSink,
    ) -> R<()> {
        audit
            .append(&AuditEvent {
                at: self.store.now(),
                user: principal.user_id.clone(),
                host: String::new(),
                action: action.to_owned(),
                target: project.to_owned(),
                detail: vec![],
            })
            .map_err(|_| CollabError::new(C::Storage, "repository binding audit failed"))?;
        self.require_repo_lead(principal, project)
    }

    /// Validate and bind the canonical repo and existing local branch as a project lead.
    pub fn bind_repo<F: PathFs>(
        &self,
        principal: &Principal,
        project_id: &str,
        path: &str,
        branch: &str,
        ports: &mut BindRepoPorts<'_, F>,
    ) -> R<Project> {
        self.require_repo_lead(principal, project_id)?;
        let binding = repo::validate(path, branch, ports)?;
        self.audit_repo_change(principal, project_id, "project.repo.bind", ports.audit)?;
        self.store.set_repo(project_id, &binding)
    }

    /// Clear a project's repository binding after authorizing and auditing the change.
    pub fn unbind_repo(
        &self,
        principal: &Principal,
        project_id: &str,
        audit: &mut dyn AuditSink,
    ) -> R<Project> {
        self.require_repo_lead(principal, project_id)?;
        self.audit_repo_change(principal, project_id, "project.repo.unbind", audit)?;
        self.store.clear_repo(project_id)
    }

    /// Read a redacted transcript after checking its exact span and stored session ownership.
    pub fn replay(
        &self,
        principal: &Principal,
        trace_id: &str,
        span_id: &str,
        sessions: Option<&dyn ReplaySessions>,
    ) -> R<ReplayTranscript> {
        let not_found = || CollabError::new(C::NotFound, "delegation transcript not found");
        let trace = self.get_trace(principal, trace_id)?;
        let session_id = trace
            .spans
            .iter()
            .find(|s| s.span_id == span_id)
            .and_then(|s| s.session_id.as_deref())
            .ok_or_else(not_found)?;
        let sessions = sessions
            .or_else(|| {
                self.ports
                    .transcripts
                    .as_deref()
                    .map(|store| store as &dyn ReplaySessions)
            })
            .ok_or_else(not_found)?;
        let session = sessions.session(session_id)?.ok_or_else(not_found)?;
        if session.id != session_id
            || session.scope != trace.project_id
            || session.owner != format!("collab-project:{}", trace.project_id)
        {
            return Err(not_found());
        }
        let redactor = self.redactor()?;
        let original = sessions.events(session_id)?;
        let mut events = redacted_rows(original.clone(), redactor)?;
        if events.len() != original.len() {
            return Err(CollabError::new(
                C::Storage,
                "delegation transcript redaction failed",
            ));
        }
        restore_provenance(&original, &mut events, trace_id, span_id);
        let messages = redacted_rows(sessions.messages(session_id)?, redactor)?;
        Ok(ReplayTranscript {
            session_id: session_id.to_owned(),
            trace_id: trace_id.to_owned(),
            span_id: span_id.to_owned(),
            messages,
            events,
        })
    }
}
