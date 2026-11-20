//! Provider adapter for a scoped collaboration turn.
use crate::collab::limits::{CallClass, DelegationWorkBudget};
use crate::collab::ports::{RunInput, RunOutput};
use crate::collab::scope::AgentScopeValue;
use crate::collab::{CollabError, CollabErrorCode as C};
use crate::logs::methods::AbortSignal;
use crate::rbac::types::{Principal, PrincipalKind};

type R<T> = Result<T, CollabError>;

/// Trusted inputs to the provider runner.
pub struct RunnerInput<'a> {
    /// Explicitly scoped agent/profile.
    pub scope: Option<&'a AgentScopeValue>,
    /// Task question and context.
    pub run: &'a RunInput,
    /// Contract-defined tool subset.
    pub tools: &'a [String],
    /// Read-only checkout provided by authenticated review dispatch, if any.
    pub read_only_worktree: Option<&'a str>,
    /// Session holding the run.
    pub session_id: Option<&'a str>,
    /// Authenticated identity, never a grant or approval surface.
    pub principal: Option<&'a Principal>,
    /// Shared delegated allocation.
    pub budget: Option<&'a DelegationWorkBudget>,
    /// Maximum rounds for this task.
    pub max_rounds: Option<i64>,
    /// Cancels the stream.
    pub abort: &'a AbortSignal,
}

/// Authority and prompt sent to an isolated provider port.
pub struct ProviderRequest<'a> {
    /// Provider agent.
    pub agent: &'a str,
    /// Project scope.
    pub project: &'a str,
    /// Session name.
    pub session: &'a str,
    /// Untrusted user text, with no borrowed assistant memory.
    pub prompt: &'a str,
    /// Exact narrowed tool view.
    pub tools: &'a [String],
    /// Optional trusted read-only checkout.
    pub read_only_worktree: Option<&'a str>,
    /// The authenticated triggering identity.
    pub principal: Option<&'a str>,
    /// Present only when the issuer is a person.
    pub person: Option<&'a str>,
    /// Shared delegated allocation.
    pub budget: Option<&'a DelegationWorkBudget>,
    /// Bound on turns.
    pub max_rounds: Option<i64>,
    /// Cancels execution.
    pub abort: &'a AbortSignal,
}

/// Events the scoped provider sends to its runner.
pub enum ProviderEvent {
    /// Public response text.
    Delta(String),
    /// Verified progress, including a text-free tool step.
    Progress,
    /// Current usage counters.
    Usage {
        /// Input tokens.
        input: i64,
        /// Output tokens.
        output: i64,
    },
}

/// Streaming turn-execution port.
pub trait RunnerProvider {
    /// Run the provider adapter. Stop when the event sink returns an error.
    fn stream(
        &self,
        request: &ProviderRequest<'_>,
        event: &mut dyn FnMut(ProviderEvent) -> R<()>,
    ) -> R<()>;
}

fn scoped_view(input: &RunnerInput<'_>, scope: &AgentScopeValue) -> Vec<String> {
    if input.read_only_worktree.is_some() {
        return scope
            .tool_view
            .iter()
            .filter(|name| {
                matches!(name.as_str(), "file.read" | "file.list" | "file.stat")
                    && input.tools.contains(name)
            })
            .cloned()
            .collect();
    }
    match scope.delegation.as_ref().map(|d| d.call_class) {
        Some(CallClass::Write) => scope
            .tool_view
            .iter()
            .filter(|name| input.tools.contains(name))
            .cloned()
            .collect(),
        Some(_) if !scope.tool_view.is_empty() => {
            let mut names = scope.tool_view.clone();
            names.extend(["consult_agent".to_owned(), "await_delegations".to_owned()]);
            names
        }
        _ => scope.tool_view.clone(),
    }
}

fn check(abort: &AbortSignal) -> R<()> {
    if abort.is_aborted() {
        return Err(CollabError::new(C::Aborted, "collaboration turn cancelled"));
    }
    Ok(())
}

/// Run only inside the matching scoped agent. Reports text-free steps without exposing provider reasoning.
pub fn run(
    input: &RunnerInput<'_>,
    provider: &dyn RunnerProvider,
    progress: &mut dyn FnMut(&RunOutput),
) -> R<RunOutput> {
    let scope = input
        .scope
        .filter(|s| s.agent_id == input.run.agent_id && s.project_id == input.run.project_id)
        .ok_or_else(|| {
            CollabError::new(
                C::NoScope,
                "target agent must run inside its own AgentScope",
            )
        })?;
    check(input.abort)?;
    let default_session = format!("collab:{}", scope.project_id);
    let text = if input.run.context.is_empty() {
        input.run.text.clone()
    } else {
        format!("{}\n\n{}", input.run.text, input.run.context)
    };
    let tools = scoped_view(input, scope);
    let person = input
        .principal
        .filter(|p| p.kind == Some(PrincipalKind::Person));
    let request = ProviderRequest {
        agent: &scope.agent_id,
        project: &scope.project_id,
        session: input.session_id.unwrap_or(&default_session),
        prompt: &text,
        tools: &tools,
        read_only_worktree: input.read_only_worktree,
        principal: input.principal.map(|p| p.user_id.as_str()),
        person: person.map(|p| p.user_id.as_str()),
        budget: input.budget,
        max_rounds: input.max_rounds,
        abort: input.abort,
    };
    let mut output = RunOutput::default();
    provider.stream(&request, &mut |event| {
        check(input.abort)?;
        match event {
            ProviderEvent::Delta(piece) => {
                output.text.push_str(&piece);
                progress(&output);
            }
            ProviderEvent::Progress => progress(&output),
            ProviderEvent::Usage {
                input,
                output: tokens,
            } => {
                if input < 0 || tokens < 0 || input.checked_add(tokens).is_none() {
                    return Err(CollabError::new(C::Invalid, "invalid provider usage"));
                }
                output.input_tokens = input;
                output.output_tokens = tokens;
            }
        }
        Ok(())
    })?;
    check(input.abort)?;
    Ok(output)
}

#[cfg(test)]
#[path = "runner_vectors.rs"]
mod vectors;
