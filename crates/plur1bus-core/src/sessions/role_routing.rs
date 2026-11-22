//! `session/role-routing.ts`: the decisions of the summarize-role adapter over the composition router. Admission, auth,
//! retries, cross-billing and D109 stay owned by that router; what is here is what the adapter itself decides: which model
//! profile and candidates the summarize role means, which profiles a chat or the context reservation sees, the output cap of
//! a summary call, the usage measurement and the augmented usage chunk, the last user text a classifier is given, and when
//! one is wired.
//!
//! Not ported (they are the router and the async plumbing): `createTurnProvider` and the provider it returns, the
//! `AsyncLocalStorage` call context, `DecisionClient` / `createRoleBackend`, and the stream wrapper itself. The pieces they
//! call are here as functions, over the [`RoutingOptions`] port.
//!
//! Known deviation: profile and role names are looked up as own keys. TypeScript reads `profiles[name]` on a plain object, so
//! a role named like an `Object.prototype` member (`constructor`, `toString`, `__proto__`) finds that member; Rust finds
//! nothing. A configuration can only name a profile it defines, so this needs a hostile owner and gives no authority.
use crate::approvals::js_json::J;
use std::collections::BTreeMap;

/// One candidate of a profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// The provider.
    pub provider: String,
    /// The model.
    pub model: String,
}

impl Candidate {
    fn key(&self) -> String {
        format!("{}/{}", self.provider, self.model)
    }
}

/// `MODEL_CLASSES`.
pub const MODEL_CLASSES: [&str; 4] = ["small", "medium", "large", "frontier"];

/// `profileForClass` threw (an invalid class table on disk); the context reservation then leaves that class out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClassProfileError;

/// The parts of `TurnProviderOptions` the adapter reads (a port).
pub trait RoutingOptions {
    /// `options.profiles`, in the order the object holds them (see [`js_key_order`]).
    fn profiles(&self) -> Vec<(String, Vec<Candidate>)>;
    /// `options.profile`.
    fn profile(&self) -> Option<String>;
    /// `options.profileForAgent?.(agentId)`; `None` for an absent function or a nullish answer.
    fn profile_for_agent(&self, _agent_id: &str) -> Option<String> {
        None
    }
    /// `options.profileForClass?.(class)`; `Err` when it throws, `Ok(None)` for an absent function or a nullish answer.
    fn profile_for_class(&self, _class: &str) -> Result<Option<String>, ClassProfileError> {
        Ok(None)
    }
    /// `options.modelRouting.contextProfiles(agentId)`; `None` when there is no `modelRouting`.
    fn context_profiles(&self, _agent_id: &str) -> Option<Vec<String>> {
        None
    }
    /// `options.requireTriage`.
    fn require_triage(&self) -> bool {
        false
    }
}

/// `Object.keys` order: array-index keys ascending first, then the others as inserted.
pub fn js_key_order(keys: &[String]) -> Vec<String> {
    let mut indexed: Vec<(usize, &String)> = Vec::new();
    let mut rest: Vec<&String> = Vec::new();
    for k in keys {
        match crate::js::array_index(k) {
            Some(i) if i.to_string() == *k => indexed.push((i, k)),
            _ => rest.push(k),
        }
    }
    indexed.sort_by_key(|(i, _)| *i);
    indexed
        .into_iter()
        .map(|(_, k)| k.clone())
        .chain(rest.into_iter().cloned())
        .collect()
}

/// What `summarizer()` selected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SummarySelection {
    /// The profile the summary router runs under.
    pub profile: String,
    /// Its candidates, the named model first.
    pub candidates: Vec<Candidate>,
    /// True when the router had to be created (the first call, or the candidates changed).
    pub created: bool,
}

/// The decisions of one `createSessionRoleProvider(create, options, roles, summaryMaxTokens, decisions)`.
pub struct SessionRoleRouter<O: RoutingOptions> {
    options: O,
    roles: BTreeMap<String, String>,
    summary_max_tokens: f64,
    summary_key: Option<String>,
    has_summarizer: bool,
}

impl<O: RoutingOptions> SessionRoleRouter<O> {
    /// A router over `options` and the role table.
    pub fn new(options: O, roles: BTreeMap<String, String>, summary_max_tokens: f64) -> Self {
        Self {
            options,
            roles,
            summary_max_tokens,
            summary_key: None,
            has_summarizer: false,
        }
    }

    /// The options.
    pub fn options(&self) -> &O {
        &self.options
    }

    /// The options, for a test that changes them.
    pub fn options_mut(&mut self) -> &mut O {
        &mut self.options
    }

    fn profiles(&self) -> Vec<(String, Vec<Candidate>)> {
        let all = self.options.profiles();
        let names: Vec<String> = all.iter().map(|(n, _)| n.clone()).collect();
        js_key_order(&names)
            .into_iter()
            .map(|n| {
                let list = all.iter().find(|(m, _)| *m == n).map(|(_, l)| l.clone());
                (n, list.unwrap_or_default())
            })
            .collect()
    }

    fn lookup(&self, name: &str) -> Option<Vec<Candidate>> {
        self.profiles()
            .into_iter()
            .find(|(n, _)| n == name)
            .map(|(_, l)| l)
    }

    /// `roles.summarize ?? (profiles.summarize ? 'summarize' : undefined)`.
    fn role(&self) -> Option<String> {
        self.roles
            .get("summarize")
            .cloned()
            .or_else(|| self.lookup("summarize").map(|_| "summarize".to_owned()))
    }

    fn profile_name(&self) -> Option<String> {
        let role = self.role().filter(|r| !r.is_empty())?;
        if self.lookup(&role).is_some() {
            return Some(role);
        }
        self.profiles()
            .into_iter()
            .find(|(_, list)| list.iter().any(|c| c.key() == role))
            .map(|(n, _)| n)
    }

    /// `candidates()`: the profile the role names, or the profile that holds the named model with that model first.
    fn candidates(&self) -> Option<Vec<Candidate>> {
        let role = self.role().filter(|r| !r.is_empty())?;
        let name = self.profile_name().filter(|n| !n.is_empty())?;
        if let Some(own) = self.lookup(&role) {
            return Some(own);
        }
        let list = self.lookup(&name)?;
        let (named, others): (Vec<_>, Vec<_>) = list.into_iter().partition(|c| c.key() == role);
        Some(named.into_iter().chain(others).collect())
    }

    /// `roleModels()`.
    pub fn role_models(&self) -> Vec<Candidate> {
        self.candidates().unwrap_or_default()
    }

    /// `modelProfiles()`: the profiles that have candidates.
    pub fn model_profiles(&self) -> Vec<String> {
        self.profiles()
            .into_iter()
            .filter(|(_, l)| !l.is_empty())
            .map(|(n, _)| n)
            .collect()
    }

    /// `defaultModelProfile(agentId)`.
    pub fn default_model_profile(&self, agent_id: &str) -> String {
        self.options
            .profile_for_agent(agent_id)
            .or_else(|| self.options.profile())
            .unwrap_or_else(|| "default".to_owned())
    }

    /// `contextModels(text, profile)`; `scope_agent` is `currentAgentScope()?.agentId`.
    pub fn context_models(
        &self,
        profile: Option<&str>,
        scope_agent: Option<&str>,
    ) -> Vec<Candidate> {
        if let Some(p) = profile.filter(|p| !p.is_empty()) {
            return self.lookup(p).unwrap_or_default();
        }
        let mut names: Vec<String> = vec![self
            .options
            .profile()
            .unwrap_or_else(|| "default".to_owned())];
        let mut add = |n: String| {
            if !names.contains(&n) {
                names.push(n);
            }
        };
        if let Some(agent) = scope_agent {
            if let Some(list) = self.options.context_profiles(agent) {
                for n in list {
                    add(n);
                }
            }
        }
        for class in MODEL_CLASSES {
            if let Ok(Some(n)) = self.options.profile_for_class(class) {
                if !n.is_empty() {
                    add(n);
                }
            }
        }
        // `new Map(entries)`: the first key keeps its place, a later entry with the same key replaces the value.
        let mut out: Vec<(String, Candidate)> = Vec::new();
        for name in &names {
            for c in self.lookup(name).unwrap_or_default() {
                match out.iter_mut().find(|(k, _)| *k == c.key()) {
                    Some(slot) => slot.1 = c,
                    None => out.push((c.key(), c)),
                }
            }
        }
        out.into_iter().map(|(_, c)| c).collect()
    }

    /// `summarizer()`: the profile and candidates the summary router runs under. `Err("summary-model-unavailable")` when the
    /// role names nothing usable. The router is reused while the candidate list stays the same.
    pub fn summarizer(&mut self) -> Result<SummarySelection, String> {
        let selected = self.candidates();
        let profile = self.profile_name();
        let (Some(selected), Some(profile)) = (
            selected.filter(|s| !s.is_empty()),
            profile.filter(|p| !p.is_empty()),
        ) else {
            return Err("summary-model-unavailable".to_owned());
        };
        let key = J::Arr(
            selected
                .iter()
                .map(|c| J::Arr(vec![J::s(&c.provider), J::s(&c.model)]))
                .collect(),
        )
        .stringify();
        if self.summary_key.as_deref() != Some(&key) {
            self.has_summarizer = false;
        }
        self.summary_key = Some(key);
        let created = !self.has_summarizer;
        self.has_summarizer = true;
        Ok(SummarySelection {
            profile,
            candidates: selected,
            created,
        })
    }

    /// `maxTokens` of the summary router (`summaryMaxTokens`).
    pub fn summary_max_tokens(&self) -> f64 {
        self.summary_max_tokens
    }

    /// `roles.decision || options.requireTriage`: whether a triage classifier is wired into the foreground router.
    pub fn needs_classifier(&self) -> bool {
        self.roles.get("decision").is_some_and(|d| !d.is_empty()) || self.options.require_triage()
    }
}

/// `Math.min(a, b)` for two numbers, NaN-propagating.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// The wire cap of a call: for a summarize request `Math.min(request.maxTokens ?? S, active.request.maxOutputTokens ?? S, S)`,
/// any other request unchanged.
pub fn capped_max_tokens(
    summarize: bool,
    wire_max_tokens: Option<f64>,
    request_max_output_tokens: Option<f64>,
    summary_max_tokens: f64,
) -> Option<f64> {
    if !summarize {
        return wire_max_tokens;
    }
    Some(js_min(
        js_min(
            wire_max_tokens.unwrap_or(summary_max_tokens),
            request_max_output_tokens.unwrap_or(summary_max_tokens),
        ),
        summary_max_tokens,
    ))
}

/// `Math.ceil(JSON.stringify(x).length / 4)` over UTF-16 units.
fn estimate(json: &J) -> f64 {
    (json.stringify().encode_utf16().count() as f64 / 4.0).ceil()
}

/// The usage measurement of a call that ended with a usage: the estimate of what was sent next to what the provider counted.
/// `capped_tools` is `capped.tools ?? []`; the messages are always there on a wire request (TypeScript would throw without).
pub fn usage_measurement(
    model: &str,
    capped_messages: &J,
    capped_tools: Option<&J>,
    input_tokens: f64,
    output_tokens: f64,
) -> J {
    let empty = J::Arr(vec![]);
    let tools = capped_tools
        .filter(|t| !matches!(t, J::Null))
        .unwrap_or(&empty);
    J::obj([
        ("model", J::s(model)),
        (
            "estimatedInputTokens",
            J::Num(estimate(capped_messages) + estimate(tools)),
        ),
        ("inputTokens", J::Num(input_tokens)),
        ("outputTokens", J::Num(output_tokens)),
    ])
}

/// What the stream wrapper makes of a usage chunk: `{ ...chunk, ...(model ? { model } : {}), measurements: [...] }`.
pub fn augment_usage_chunk(chunk: &J, model: Option<&str>, measurements: &[J]) -> J {
    let mut o = chunk.clone();
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        o.set("model", J::s(m));
    }
    o.set("measurements", J::Arr(measurements.to_vec()));
    o
}

/// The text a classifier is given: the last user message's text, or the empty string.
pub fn last_user_text(messages: &[(String, String)]) -> String {
    messages
        .iter()
        .rev()
        .find(|(role, _)| role == "user")
        .map(|(_, t)| t.clone())
        .unwrap_or_default()
}
