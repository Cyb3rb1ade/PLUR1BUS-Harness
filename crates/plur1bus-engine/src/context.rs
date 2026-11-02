//! Request identity for recall and later memory operations.
//!
//! Ports the pure parts of `lib/memory-request-context.js`, `engine/identity/principal.js`
//! (`memoryContextFromPrincipal`, `libChatKind`, the seeded channel registry) and
//! `shouldSkipAutoRecallForInternalTurn` from `lib/runtime-scheduler.js`. The host supplies
//! the workspace directory. Host routing, hook tickets and pool-label dashboards stay out.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use sha2::{Digest, Sha256};

use crate::{
    contract::{
        limits::{
            validate_input, ValidationOptions, ACCOUNT_ID, AGENT_ID, CHANNEL_ID, CHAT_ID,
            SESSION_KEY,
        },
        AgentContext, AgentId, EngineError, HostServices, MemoryScope, Principal,
    },
    text::js::{self, JsString},
};

const WORKSPACE_KEY_PREFIX: &str = "workspace:v1:";
const WORKSPACE_DIR_PREFIX: &str = "workspace-dir:v1:";
const RESERVED_CHANNELS: &[&str] = &[
    "direct", "dm", "group", "channel", "main", "cron", "webchat",
];

/// One path-to-workspace binding inside a frozen alias snapshot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkspacePathBinding {
    /// Canonical directory path.
    pub path: String,
    /// Workspace principal this path resolves to.
    pub workspace_key: String,
}

/// One alias lookup key inside a frozen alias snapshot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkspaceAliasBinding {
    /// Lookup key. Normalization stores every key the Node map would.
    pub alias: String,
    /// Workspace principal this key resolves to.
    pub workspace_key: String,
}

/// Normalized workspace alias snapshot (`paths` and `aliases`).
///
/// `None` at an ACL boundary is the Node `null` snapshot and is distinct from this empty value.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkspaceAliases {
    /// Directory bindings, in insertion order.
    pub paths: Vec<WorkspacePathBinding>,
    /// Alias lookup keys, in insertion order.
    pub aliases: Vec<WorkspaceAliasBinding>,
}

/// Process channel vocabulary seeded the way `engine/identity/principal.js` seeds it.
///
/// `register` returns [`Result`] because a reserved name throws in Node. The contract
/// [`crate::contract::ChannelRegistry`] cannot express that failure, so this type does not
/// implement the trait. RE-08 maps the result when it wires `channels.register`.
#[derive(Debug)]
pub struct RouteVocabulary {
    names: Mutex<Vec<String>>,
}

impl RouteVocabulary {
    /// A fresh registry containing `telegram`, `discord`, `slack` and `mattermost`.
    #[must_use]
    pub fn seeded() -> Self {
        Self {
            names: Mutex::new(vec![
                "telegram".to_owned(),
                "discord".to_owned(),
                "slack".to_owned(),
                "mattermost".to_owned(),
            ]),
        }
    }

    /// The process-wide seed. Callers that register a channel use [`Self::seeded`] instead.
    #[must_use]
    pub fn shared() -> &'static Self {
        static SHARED: OnceLock<RouteVocabulary> = OnceLock::new();
        SHARED.get_or_init(Self::seeded)
    }

    /// Register a channel and return its canonical lower-case name.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::Invalid`] when the name is empty, too long, or reserved.
    pub fn register(&self, name: &str) -> Result<String, EngineError> {
        let validated = validated_identity(Some(name), CHANNEL_ID, "channel", true)
            .map_err(|message| invalid("channel", message))?;
        let normalized = js::js_to_lower_case(&validated);
        if RESERVED_CHANNELS.contains(&normalized.as_str()) {
            return Err(invalid(
                "channel",
                format!(
                    "\"{normalized}\" is a reserved name and cannot be registered as a channel"
                ),
            ));
        }
        let mut names = lock(&self.names);
        if !names.iter().any(|existing| existing == &normalized) {
            names.push(normalized.clone());
        }
        Ok(normalized)
    }

    /// Report whether `name` is registered. The check lower-cases, matching Node `has`.
    #[must_use]
    pub fn has(&self, name: &str) -> bool {
        let normalized = js::js_to_lower_case(name);
        lock(&self.names)
            .iter()
            .any(|existing| existing == &normalized)
    }

    /// Registered names in insertion order.
    #[must_use]
    pub fn list(&self) -> Vec<String> {
        lock(&self.names).clone()
    }
}

fn lock(names: &Mutex<Vec<String>>) -> MutexGuard<'_, Vec<String>> {
    names.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Identity passed to recall, capture and memory operations.
///
/// The public fields are the brief's `RequestContext`. Further identity is available
/// through the accessors; constructing a context any other way would skip Node's checks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestContext {
    /// Agent the request acts as.
    pub agent_id: AgentId,
    /// Canonical workspace identity. Empty when the request has no workspace.
    pub workspace_id: String,
    /// Same canonical workspace identity Node stores on `workspaceIdentity`.
    pub workspace_key: String,
    /// Proved user principal, or empty when the request has no user scope.
    pub owner_user_id: String,
    /// Scopes this request may read, in the order agent-private, workspace, user.
    pub visible_scopes: Vec<MemoryScope>,
    /// Same value as `owner_user_id`: `user:v1:` plus the sha256 hex, or empty.
    pub principal_key: String,
    origin: String,
    background: bool,
    channel: String,
    account_id: String,
    chat_id: String,
    chat_kind: String,
    aliases: WorkspaceAliases,
    trust: String,
}

impl RequestContext {
    /// Build a context with the process channel vocabulary.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::Invalid`] for an agent id Node would reject, a missing proved
    /// workspace directory, or two workspace facts that disagree. A host failure is
    /// [`EngineError::Host`].
    pub fn build(
        principal: &Principal,
        agent: &AgentContext,
        host: &dyn HostServices,
    ) -> Result<Self, EngineError> {
        Self::build_with(principal, agent, host, RouteVocabulary::shared())
    }

    /// [`Self::build`] against an explicit channel vocabulary.
    ///
    /// # Errors
    ///
    /// See [`Self::build`].
    pub fn build_with(
        principal: &Principal,
        agent: &AgentContext,
        host: &dyn HostServices,
        vocabulary: &RouteVocabulary,
    ) -> Result<Self, EngineError> {
        let claim = PrincipalClaim::read(principal)?;
        let (origin, background) = read_agent(agent);
        let agent_id = require_agent(&claim.agent_id)?;
        let directory = host_directory(host, &agent_id)?;
        let proved = claim.trust == "proved";
        let base = base_context(&claim.agent_id, directory.as_deref(), proved)?;
        if !proved {
            return finish(base, origin, background, &BuiltIdentity::inferred());
        }
        prove_claims(
            &claim,
            base,
            directory.as_deref(),
            vocabulary,
            origin,
            background,
        )
    }

    /// Lower-cased channel. Empty when trust was inferred.
    #[must_use]
    pub fn channel(&self) -> &str {
        &self.channel
    }

    /// Trimmed account id. Empty when trust was inferred.
    #[must_use]
    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    /// Trimmed chat id. Empty when trust was inferred.
    #[must_use]
    pub fn chat_id(&self) -> &str {
        &self.chat_id
    }

    /// Lib chat kind: `private`, `group`, or `unknown`.
    #[must_use]
    pub fn chat_kind(&self) -> &str {
        &self.chat_kind
    }

    /// `proved` or `inferred`.
    #[must_use]
    pub fn trust(&self) -> &str {
        &self.trust
    }

    /// Agent-context background flag. Unknown input fails closed to `true`.
    #[must_use]
    pub fn background(&self) -> bool {
        self.background
    }

    /// Wire origin from the agent context (`user`, `cron`, `subagent`, `heartbeat`, `system`).
    #[must_use]
    pub fn origin_wire(&self) -> &str {
        &self.origin
    }

    /// Alias snapshot used when this context checks stored ownership.
    #[must_use]
    pub fn aliases(&self) -> &WorkspaceAliases {
        &self.aliases
    }
}

/// `user:v1:` plus the sha256 hex of `JSON.stringify([channel, accountId, userId])`.
///
/// The digest matches `channelIdentityUserPrincipal`. The `user:v1:` prefix is part of the
/// value both the Node engine and `packages/core` compare.
#[must_use]
pub fn principal_key(channel: &str, account_id: &str, user_id: &str) -> String {
    let payload = format!(
        "[{},{},{}]",
        json_string(channel),
        json_string(account_id),
        json_string(user_id)
    );
    format!("user:v1:{}", sha256_hex(&payload))
}

/// `user:v2:` plus the sha256 hex of `to_user`, matching `harnessUserPrincipal`.
#[must_use]
pub fn harness_user_principal(to_user: &str) -> String {
    format!("user:v2:{}", sha256_hex(to_user))
}

/// Fixed-size workspace pool directory name (`w-` plus 62 hex characters).
#[must_use]
pub fn workspace_pool_key(workspace_identity: &str) -> String {
    format!("w-{}", &sha256_hex(workspace_identity)[..62])
}

/// Fixed-size user pool directory name (`u-` plus 62 hex characters).
#[must_use]
pub fn user_pool_key(user_principal: &str) -> String {
    format!("u-{}", &sha256_hex(user_principal)[..62])
}

/// `true` when `value` matches `^user:v[12]:[0-9a-f]{64}$`.
#[must_use]
pub fn is_user_principal(value: &str) -> bool {
    let Some(hex) = value
        .strip_prefix("user:v1:")
        .or_else(|| value.strip_prefix("user:v2:"))
    else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Fields a turn carries into [`should_skip_auto_recall_for_internal_turn`].
///
/// Empty strings are absent, matching Node's `||` selection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnSignal {
    /// Prompt text. Only the event prompt is read.
    pub prompt: String,
    /// Turn origin.
    pub origin: String,
    /// Origin fallback used when `origin` is empty.
    pub source: String,
    /// Turn kind.
    pub kind: String,
    /// Kind fallback (`event.type` / `ctx.type`).
    pub type_name: String,
    /// Turn trigger.
    pub trigger: String,
    /// Session key.
    pub session_key: String,
    /// Session-id fallback.
    pub session_id: String,
    /// Run-id fallback.
    pub run_id: String,
}

/// Whether this turn must not run automatic recall.
///
/// Ports `shouldSkipAutoRecallForInternalTurn` only. Capture admission stays in RE-05.
#[must_use]
pub fn should_skip_auto_recall_for_internal_turn(event: &TurnSignal, ctx: &TurnSignal) -> bool {
    let prompt = js::js_to_lower_case(&event.prompt);
    let session_key = lower_present(&[
        ctx.session_key.as_str(),
        event.session_key.as_str(),
        event.session_id.as_str(),
        event.run_id.as_str(),
    ]);
    if session_key.contains(":active-memory:") {
        return true;
    }
    if explicit_memory_command(&prompt) {
        return false;
    }
    if is_background_turn(event, ctx) {
        return true;
    }
    let origin = lower_present(&[
        event.origin.as_str(),
        event.source.as_str(),
        ctx.origin.as_str(),
        ctx.source.as_str(),
    ]);
    let kind = lower_present(&[
        event.kind.as_str(),
        event.type_name.as_str(),
        ctx.kind.as_str(),
        ctx.type_name.as_str(),
    ]);
    if contains_internal(&origin) || contains_internal(&kind) || contains_internal(&session_key) {
        return true;
    }
    if magic_markers().iter().any(|marker| prompt.contains(marker)) {
        return true;
    }
    prompt.contains("[cron:") || prompt.contains("heartbeat_ok")
}

fn explicit_memory_command(prompt: &str) -> bool {
    const COMMANDS: &[&str] = &[
        "/memory",
        "/mem",
        "/recall",
        "/knowledge_update",
        "memory_store",
        "memory_recall",
        "memory_search",
        "memory_forget",
    ];
    COMMANDS.iter().any(|command| prompt.contains(command))
}

fn is_background_turn(event: &TurnSignal, ctx: &TurnSignal) -> bool {
    let session_key = lower_present(&[
        ctx.session_key.as_str(),
        event.session_key.as_str(),
        event.session_id.as_str(),
        event.run_id.as_str(),
    ]);
    let origin = lower_present(&[
        event.origin.as_str(),
        event.source.as_str(),
        ctx.origin.as_str(),
        ctx.source.as_str(),
    ]);
    let prompt = js::js_to_lower_case(&event.prompt);
    let kind = lower_present(&[
        event.kind.as_str(),
        event.type_name.as_str(),
        ctx.kind.as_str(),
        ctx.type_name.as_str(),
    ]);
    let trigger = lower_present(&[event.trigger.as_str(), ctx.trigger.as_str()]);
    origin == "cron"
        || origin == "internal"
        || kind == "cron"
        || kind == "heartbeat"
        || kind == "background"
        || matches!(
            trigger.as_str(),
            "cron" | "heartbeat" | "background" | "manual"
        )
        || session_key.contains(":cron:")
        || session_key.contains(":heartbeat")
        || prompt.contains("[cron:")
        || prompt.contains("heartbeat_ok")
}

fn contains_internal(value: &str) -> bool {
    value.contains("background") || value.contains("dreaming") || value.contains("promotion")
}

fn lower_present(values: &[&str]) -> String {
    js::js_to_lower_case(
        values
            .iter()
            .copied()
            .find(|value| !value.is_empty())
            .unwrap_or(""),
    )
}

fn magic_markers() -> [String; 3] {
    let stem = format!("{}{}", "open", "claw");
    [
        format!("__{stem}_memory_core_short_term_promotion_dream__"),
        format!("__{stem}_memory_core_light_sleep__"),
        format!("__{stem}_memory_core_rem_sleep__"),
    ]
}

struct PrincipalClaim {
    agent_id: String,
    workspace: String,
    user: String,
    channel: String,
    account_id: String,
    chat_id: String,
    chat_kind: String,
    trust: String,
}

impl PrincipalClaim {
    fn read(principal: &Principal) -> Result<Self, EngineError> {
        let value = serde_json::to_value(principal)
            .map_err(|_| invalid("principal", "principal could not be read".to_owned()))?;
        let chat = value.get("chat");
        Ok(Self {
            agent_id: json_str(&value, "agentId"),
            workspace: json_str(&value, "workspace"),
            user: json_str(&value, "user"),
            channel: json_str(&value, "channel"),
            account_id: json_str(&value, "accountId"),
            chat_id: chat.map(|item| json_str(item, "id")).unwrap_or_default(),
            chat_kind: chat.map(|item| json_str(item, "kind")).unwrap_or_default(),
            trust: json_str(&value, "trust"),
        })
    }
}

struct BuiltIdentity {
    user: String,
    channel: String,
    account_id: String,
    chat_id: String,
    chat_kind: String,
    trust: &'static str,
}

impl BuiltIdentity {
    fn inferred() -> Self {
        Self {
            user: String::new(),
            channel: String::new(),
            account_id: String::new(),
            chat_id: String::new(),
            chat_kind: "unknown".to_owned(),
            trust: "inferred",
        }
    }
}

#[derive(Clone)]
struct BaseContext {
    agent_id: String,
    workspace_identity: String,
    aliases: WorkspaceAliases,
}

fn prove_claims(
    claim: &PrincipalClaim,
    base: BaseContext,
    directory: Option<&str>,
    vocabulary: &RouteVocabulary,
    origin: String,
    background: bool,
) -> Result<RequestContext, EngineError> {
    if let Some(identity) = proved_identity(claim, vocabulary) {
        let scoped = scoped_workspace(&base, &claim.workspace, directory)?;
        return finish(scoped, origin, background, &identity);
    }
    finish(base, origin, background, &BuiltIdentity::inferred())
}

fn proved_identity(claim: &PrincipalClaim, vocabulary: &RouteVocabulary) -> Option<BuiltIdentity> {
    if !claim.user.is_empty() && !is_user_principal(&claim.user) {
        return None;
    }
    let channel = js::js_to_lower_case(&claim.channel);
    if !channel.is_empty() && !vocabulary.has(&channel) {
        return None;
    }
    let account_id =
        validated_identity(Some(&claim.account_id), ACCOUNT_ID, "accountId", false).ok()?;
    let chat_id = validated_identity(Some(&claim.chat_id), CHAT_ID, "chatId", false).ok()?;
    if !claim.user.is_empty() && (channel.is_empty() || account_id.is_empty()) {
        return None;
    }
    Some(BuiltIdentity {
        user: claim.user.clone(),
        channel,
        account_id,
        chat_id,
        chat_kind: lib_chat_kind(&claim.chat_kind),
        trust: "proved",
    })
}

fn scoped_workspace(
    base: &BaseContext,
    workspace: &str,
    directory: Option<&str>,
) -> Result<BaseContext, EngineError> {
    if workspace.is_empty() {
        return Ok(base.clone());
    }
    resolve_with(&base.agent_id, Some(workspace), directory).map_err(map_base_error)
}

fn finish(
    base: BaseContext,
    origin: String,
    background: bool,
    identity: &BuiltIdentity,
) -> Result<RequestContext, EngineError> {
    let user = if is_user_principal(&identity.user) {
        identity.user.clone()
    } else {
        String::new()
    };
    Ok(RequestContext {
        agent_id: require_agent(&base.agent_id)?,
        workspace_id: base.workspace_identity.clone(),
        workspace_key: base.workspace_identity.clone(),
        owner_user_id: user.clone(),
        visible_scopes: visible_scopes(&base.workspace_identity, &user)?,
        principal_key: user,
        origin,
        background,
        channel: identity.channel.clone(),
        account_id: identity.account_id.clone(),
        chat_id: identity.chat_id.clone(),
        chat_kind: identity.chat_kind.clone(),
        aliases: base.aliases,
        trust: identity.trust.to_owned(),
    })
}

fn visible_scopes(workspace: &str, user: &str) -> Result<Vec<MemoryScope>, EngineError> {
    let mut scopes = vec![parse_scope("agent-private")?];
    if !workspace.is_empty() {
        scopes.push(parse_scope("workspace")?);
    }
    if is_user_principal(user) {
        scopes.push(parse_scope("user")?);
    }
    Ok(scopes)
}

fn parse_scope(wire: &str) -> Result<MemoryScope, EngineError> {
    serde_json::from_value(serde_json::Value::String(wire.to_owned()))
        .map_err(|_| invalid("scope", "unknown memory scope".to_owned()))
}

fn base_context(
    agent: &str,
    directory: Option<&str>,
    proved: bool,
) -> Result<BaseContext, EngineError> {
    match resolve_with(agent, None, directory) {
        Ok(base) => Ok(base),
        Err(_) if !proved && directory.is_some() => {
            resolve_with(agent, None, None).map_err(map_base_error)
        }
        Err(message) => Err(map_base_error(message)),
    }
}

fn host_directory(host: &dyn HostServices, agent: &AgentId) -> Result<Option<String>, EngineError> {
    match host.workspace_dir(agent) {
        Ok(Some(path)) => Ok(Some(path.to_string_lossy().into_owned())),
        Ok(None) => Ok(None),
        Err(error) => Err(EngineError::Host(error)),
    }
}

fn read_agent(agent: &AgentContext) -> (String, bool) {
    let Ok(value) = serde_json::to_value(agent) else {
        return (String::new(), true);
    };
    (
        json_str(&value, "origin"),
        value
            .get("background")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
    )
}

fn require_agent(id: &str) -> Result<AgentId, EngineError> {
    id.parse::<AgentId>()
        .map_err(|_| identity_error(invalid_agent_message(id)))
}

fn resolve_with(
    agent: &str,
    workspace_id: Option<&str>,
    directory: Option<&str>,
) -> Result<BaseContext, String> {
    let aliases = normalize_aliases(&WorkspaceAliases::default())?;
    let raw_agent = validated_identity(Some(agent), AGENT_ID, "agentId", true)?;
    let agent_id = safe_agent_id(&raw_agent)?;
    let explicit_id = match workspace_id {
        Some(value) if !value.is_empty() => Some(validated_identity(
            Some(value),
            workspace_target_limit(),
            "workspaceId",
            false,
        )?),
        _ => None,
    };
    let canonical_dir = match directory {
        Some(path) if !path.is_empty() => Some(node_realpath(path)?),
        _ => None,
    };
    let workspace_identity = resolve_canonical_snapshot(
        explicit_id.as_deref(),
        None,
        canonical_dir.as_deref(),
        &aliases,
    )?;
    Ok(BaseContext {
        agent_id,
        workspace_identity,
        aliases,
    })
}

fn lib_chat_kind(kind: &str) -> String {
    let mapped = match kind {
        "direct" | "dm" => "private",
        "group" | "channel" => "group",
        other => other,
    };
    if mapped == "private" || mapped == "group" {
        mapped.to_owned()
    } else {
        "unknown".to_owned()
    }
}

pub(crate) fn validated_identity(
    value: Option<&str>,
    max_length: usize,
    name: &str,
    required: bool,
) -> Result<String, String> {
    let Some(value) = value.filter(|text| !text.is_empty()) else {
        return if required {
            Err(format!("{name} is required"))
        } else {
            Ok(String::new())
        };
    };
    let canonical = js::js_trim(value);
    if required && canonical.is_empty() {
        return Err(format!("{name} is required"));
    }
    validate_input(
        Some(canonical),
        ValidationOptions {
            max_length: Some(max_length),
            name,
            required,
            ..ValidationOptions::default()
        },
    )
    .map(|validated| validated.unwrap_or(canonical).to_owned())
}

pub(crate) fn safe_agent_id(id: &str) -> Result<String, String> {
    if is_safe_agent_id(id) {
        Ok(id.to_owned())
    } else {
        Err(invalid_agent_message(id))
    }
}

fn is_safe_agent_id(id: &str) -> bool {
    let mut count = 0usize;
    for character in id.chars() {
        if !character.is_ascii_alphanumeric() && character != '_' && character != '-' {
            return false;
        }
        count += 1;
        if count > 64 {
            return false;
        }
    }
    count >= 1
}

fn invalid_agent_message(id: &str) -> String {
    let rendered = js::utf16_slice(&json_string(id), 0, 80).to_utf8_lossy();
    format!("Invalid agent ID: {rendered}")
}

fn workspace_target_limit() -> usize {
    WORKSPACE_DIR_PREFIX.encode_utf16().count() + SESSION_KEY
}

pub(crate) fn normalize_workspace_target(value: &str, name: &str) -> Result<String, String> {
    let target = validated_identity(Some(value), workspace_target_limit(), name, true)?;
    for (prefix, limit) in [
        (WORKSPACE_KEY_PREFIX, AGENT_ID),
        (WORKSPACE_DIR_PREFIX, SESSION_KEY),
    ] {
        if !target.starts_with(prefix) {
            continue;
        }
        let suffix = validated_identity(Some(&target[prefix.len()..]), limit, name, true)?;
        if suffix.starts_with(WORKSPACE_KEY_PREFIX) || suffix.starts_with(WORKSPACE_DIR_PREFIX) {
            return Err(format!("invalid {name}"));
        }
        return Ok(format!("{prefix}{suffix}"));
    }
    if target.starts_with("workspace:") || target.starts_with("workspace-dir:") {
        return Err(format!("invalid {name}"));
    }
    let bare = validated_identity(Some(&target), AGENT_ID, name, true)?;
    Ok(format!("{WORKSPACE_KEY_PREFIX}{bare}"))
}

pub(crate) fn normalize_aliases(source: &WorkspaceAliases) -> Result<WorkspaceAliases, String> {
    let mut paths = Vec::new();
    for entry in &source.paths {
        let path = node_realpath(&validated_identity(
            Some(&entry.path),
            SESSION_KEY,
            "workspace path",
            true,
        )?)?;
        let target = normalize_workspace_target(&entry.workspace_key, "workspace alias target")?;
        insert_path(&mut paths, path, &target)?;
    }
    let mut aliases = Vec::new();
    for entry in &source.aliases {
        let alias = validated_identity(Some(&entry.alias), AGENT_ID, "workspace alias", true)?;
        let target = normalize_workspace_target(&entry.workspace_key, "workspace alias target")?;
        for key in alias_lookup_keys(&alias) {
            insert_alias(&mut aliases, key, &target)?;
        }
    }
    Ok(WorkspaceAliases { paths, aliases })
}

fn insert_path(
    paths: &mut Vec<WorkspacePathBinding>,
    path: String,
    target: &str,
) -> Result<(), String> {
    if let Some(existing) = paths.iter().find(|entry| entry.path == path) {
        if existing.workspace_key != target {
            return Err("conflicting workspace path declaration".to_owned());
        }
        return Ok(());
    }
    paths.push(WorkspacePathBinding {
        path,
        workspace_key: target.to_owned(),
    });
    Ok(())
}

fn insert_alias(
    aliases: &mut Vec<WorkspaceAliasBinding>,
    alias: String,
    target: &str,
) -> Result<(), String> {
    if let Some(existing) = aliases.iter().find(|entry| entry.alias == alias) {
        if existing.workspace_key != target {
            return Err("conflicting workspace alias declaration".to_owned());
        }
        return Ok(());
    }
    aliases.push(WorkspaceAliasBinding {
        alias,
        workspace_key: target.to_owned(),
    });
    Ok(())
}

fn alias_lookup_keys(value: &str) -> Vec<String> {
    let mut keys = Vec::new();
    push_unique(&mut keys, value.to_owned());
    push_unique(&mut keys, js::js_to_lower_case(&sanitize_alias(value)));
    push_unique(&mut keys, js::js_to_lower_case(value));
    keys
}

fn sanitize_alias(raw: &str) -> String {
    let mut out = String::new();
    let mut in_gap = false;
    for character in js::js_trim(raw).chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            in_gap = false;
            out.push(character);
        } else if !in_gap {
            in_gap = true;
            out.push('_');
        }
    }
    let stripped = out.trim_matches('_');
    let base = if stripped.is_empty() {
        "default"
    } else {
        stripped
    };
    js::utf16_slice(base, 0, 120).to_utf8_lossy()
}

pub(crate) fn resolve_canonical(
    explicit_id: Option<&str>,
    explicit_key: Option<&str>,
    canonical_dir: Option<&str>,
    aliases: &WorkspaceAliases,
) -> Result<String, String> {
    let snapshot = normalize_aliases(aliases)?;
    resolve_canonical_snapshot(explicit_id, explicit_key, canonical_dir, &snapshot)
}

fn resolve_canonical_snapshot(
    explicit_id: Option<&str>,
    explicit_key: Option<&str>,
    canonical_dir: Option<&str>,
    snapshot: &WorkspaceAliases,
) -> Result<String, String> {
    let mut principals = Vec::new();
    for raw in [explicit_id, explicit_key] {
        let Some(raw) = raw.filter(|value| !value.is_empty()) else {
            continue;
        };
        let validated = validated_identity(
            Some(raw),
            workspace_target_limit(),
            "workspace identity",
            true,
        )?;
        let canonical = canonical_explicit(&validated, snapshot)?;
        push_unique(&mut principals, canonical);
    }
    if let Some(dir) = canonical_dir.filter(|value| !value.is_empty()) {
        let found = snapshot
            .paths
            .iter()
            .find(|entry| entry.path == dir)
            .map(|entry| entry.workspace_key.clone());
        push_unique(
            &mut principals,
            found.unwrap_or_else(|| format!("{WORKSPACE_DIR_PREFIX}{dir}")),
        );
    }
    if principals.len() > 1 {
        return Err("conflicting workspace identity".to_owned());
    }
    Ok(principals.into_iter().next().unwrap_or_default())
}

fn canonical_explicit(validated: &str, snapshot: &WorkspaceAliases) -> Result<String, String> {
    if validated.starts_with(WORKSPACE_KEY_PREFIX) || validated.starts_with(WORKSPACE_DIR_PREFIX) {
        return normalize_workspace_target(validated, "workspace identity");
    }
    let found = lookup_alias(snapshot, validated);
    if found.is_empty() {
        normalize_workspace_target(validated, "workspace identity")
    } else {
        Ok(found)
    }
}

fn lookup_alias(snapshot: &WorkspaceAliases, value: &str) -> String {
    for key in alias_lookup_keys(value) {
        if let Some(entry) = snapshot.aliases.iter().find(|entry| entry.alias == key) {
            if !entry.workspace_key.is_empty() {
                return entry.workspace_key.clone();
            }
        }
    }
    String::new()
}

pub(crate) fn canonical_stored_workspace(
    value: &str,
    aliases: &WorkspaceAliases,
) -> Result<String, String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.starts_with(WORKSPACE_KEY_PREFIX) || value.starts_with(WORKSPACE_DIR_PREFIX) {
        return normalize_workspace_target(value, "memory workspace binding");
    }
    resolve_canonical(Some(value), None, None, aliases)
}

fn node_realpath(path: &str) -> Result<String, String> {
    match std::fs::canonicalize(Path::new(path)) {
        Ok(canonical) => Ok(strip_verbatim(&canonical)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err("path does not exist".to_owned())
        }
        Err(_) => Err("path cannot be resolved".to_owned()),
    }
}

fn strip_verbatim(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return rest.to_owned();
    }
    text.into_owned()
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn map_base_error(message: String) -> EngineError {
    if message == "path does not exist" {
        return invalid("workspaceDir", "workspace path does not exist".to_owned());
    }
    if message == "path cannot be resolved" {
        return invalid(
            "workspaceDir",
            "workspace path cannot be resolved".to_owned(),
        );
    }
    identity_error(message)
}

fn identity_error(message: String) -> EngineError {
    let field = if message.starts_with("Invalid agent ID:") || !message.contains("workspace") {
        "agentId"
    } else {
        "workspace"
    };
    invalid(field, message)
}

fn invalid(field: &str, message: String) -> EngineError {
    EngineError::Invalid {
        field: field.to_owned(),
        message,
    }
}

fn json_str(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn json_string(value: &str) -> String {
    JsString::from_utf8_str(value)
        .to_json()
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write_hex(&mut encoded, byte);
    }
    encoded
}

fn write_hex(out: &mut String, byte: u8) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(char::from(HEX[usize::from(byte >> 4)]));
    out.push(char::from(HEX[usize::from(byte & 0x0f)]));
}
