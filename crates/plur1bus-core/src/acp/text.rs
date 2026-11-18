//! Bilingual ACP presentation; protocol ids and Core error codes remain language-independent (port of `acp/text.ts`,
//! `failure.ts` and `modes.ts`).
use super::json::V;

/// The two languages of the notices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcpLanguage {
    /// English.
    En,
    /// German.
    De,
}

/// The reasons of a known refusal (`AcpFailure`): fixed explanations, never an arbitrary downstream message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcpFailureReason {
    /// `root-not-granted`.
    RootNotGranted,
    /// `coding-unavailable`.
    CodingUnavailable,
    /// `unknown-session`.
    UnknownSession,
    /// `delivery-unavailable`.
    DeliveryUnavailable,
    /// `mode-unavailable`.
    ModeUnavailable,
    /// `session-limit`.
    SessionLimit,
}

impl AcpFailureReason {
    /// The wire name.
    pub fn key(self) -> &'static str {
        match self {
            AcpFailureReason::RootNotGranted => "root-not-granted",
            AcpFailureReason::CodingUnavailable => "coding-unavailable",
            AcpFailureReason::UnknownSession => "unknown-session",
            AcpFailureReason::DeliveryUnavailable => "delivery-unavailable",
            AcpFailureReason::ModeUnavailable => "mode-unavailable",
            AcpFailureReason::SessionLimit => "session-limit",
        }
    }
}

/// The fixed strings of one language.
#[derive(Debug)]
pub struct AcpText {
    /// Name of the chat mode.
    pub chat_name: &'static str,
    /// Description of the chat mode.
    pub chat_description: &'static str,
    /// Name of the coding mode.
    pub coding_name: &'static str,
    /// Description of the coding mode.
    pub coding_description: &'static str,
    /// Notice after a mode change.
    pub profile_changed: &'static str,
    /// Notice after a refused permission choice.
    pub approval_refused: &'static str,
    /// Option name: once.
    pub allow_once: &'static str,
    /// Option name: task.
    pub allow_task: &'static str,
    /// Option name: session.
    pub allow_session: &'static str,
    /// Option name: always.
    pub always: &'static str,
    /// Option name: deny.
    pub deny: &'static str,
    /// Label: risk.
    pub risk: &'static str,
    /// Label: the agent's reason.
    pub agent_reason: &'static str,
    /// Label: the patch preview.
    pub patch_preview: &'static str,
    /// Label: a unified text patch.
    pub patch: &'static str,
    /// Label: a tool result.
    pub tool_result: &'static str,
    /// Reason: contents unknown.
    pub unknown_contents: &'static str,
    /// Reason: truncated.
    pub truncated: &'static str,
    /// Reason: size limit.
    pub size_limit: &'static str,
    /// Reason: the tool failed.
    pub tool_failed: &'static str,
    /// Reason: no patch.
    pub no_patch: &'static str,
    /// Marker: display clipped.
    pub display_clipped: &'static str,
    failures: [&'static str; 6],
}

impl AcpText {
    /// The explanation of a refusal.
    pub fn failure(&self, reason: AcpFailureReason) -> &'static str {
        self.failures[reason as usize]
    }
}

static EN: AcpText = AcpText {
    chat_name: "Chat",
    chat_description: "Use the agent's conversational tool profile",
    coding_name: "Coding",
    coding_description: "Use the coding profile in the granted worktree",
    profile_changed: "Harness: switching modes changes the tool offer; expect one prompt-cache miss on the next model request.\n",
    approval_refused: "Harness: the editor's permission choice was refused by the core.\n",
    allow_once: "Allow once",
    allow_task: "Allow for this task, until it ends",
    allow_session: "Allow for this session, until it ends",
    always: "Always",
    deny: "Deny",
    risk: "Risk",
    agent_reason: "Agent reason (unverified)",
    patch_preview: "Agent patch preview (unverified)",
    patch: "Unified text patch",
    tool_result: "Tool result",
    unknown_contents: "complete before/after contents unavailable",
    truncated: "truncated",
    size_limit: "size limit",
    tool_failed: "tool failed",
    no_patch: "no unified patch supplied",
    display_clipped: "[display clipped at 32 KiB]",
    failures: [
        "This folder is not granted. Approve it from an interactive local plur1bus code session first.",
        "This Core does not provide the ACP coding profile. Update the Core first.",
        "This ACP connection does not own that session.",
        "This Core does not provide steering or queued delivery.",
        "This Core does not provide ACP session modes.",
        "This ACP connection has reached its session limit.",
    ],
};

static DE: AcpText = AcpText {
    chat_name: "Chat",
    chat_description: "Das Gesprächsprofil des Agenten verwenden",
    coding_name: "Programmieren",
    coding_description: "Das Coding-Profil im freigegebenen Worktree verwenden",
    profile_changed: "Harness: Der Moduswechsel ändert das Werkzeugangebot; beim nächsten Modellaufruf ist ein Prompt-Cache-Miss zu erwarten.\n",
    approval_refused: "Harness: Der Core hat die Freigabeauswahl aus dem Editor abgelehnt.\n",
    allow_once: "Einmal erlauben",
    allow_task: "Für diese Aufgabe erlauben, bis sie endet",
    allow_session: "Für diese Sitzung erlauben, bis sie endet",
    always: "Immer",
    deny: "Ablehnen",
    risk: "Risiko",
    agent_reason: "Begründung des Agenten (ungeprüft)",
    patch_preview: "Patch-Vorschau des Agenten (ungeprüft)",
    patch: "Unified-Text-Patch",
    tool_result: "Werkzeugergebnis",
    unknown_contents: "vollständiger Vorher-/Nachher-Inhalt nicht verfügbar",
    truncated: "gekürzt",
    size_limit: "Größengrenze",
    tool_failed: "Werkzeug fehlgeschlagen",
    no_patch: "kein Unified-Patch geliefert",
    display_clipped: "[Anzeige bei 32 KiB gekürzt]",
    failures: [
        "Dieser Ordner ist nicht freigegeben. Zuerst in einer interaktiven lokalen Sitzung mit plur1bus code freigeben.",
        "Dieser Core bietet das ACP-Coding-Profil nicht an. Zuerst den Core aktualisieren.",
        "Diese ACP-Verbindung besitzt diese Sitzung nicht.",
        "Dieser Core bietet Steering und Folge-Warteschlange nicht an.",
        "Dieser Core bietet keine ACP-Sitzungsmodi an.",
        "Diese ACP-Verbindung hat ihre Sitzungsgrenze erreicht.",
    ],
};

/// Fixed strings only; untrusted provider text is never substituted into these notices.
pub fn acp_text(language: AcpLanguage) -> &'static AcpText {
    match language {
        AcpLanguage::De => &DE,
        AcpLanguage::En => &EN,
    }
}

/// Match the native CLI's existing locale precedence: the first of `LC_ALL`, `LC_MESSAGES`, `LANG` that is set and not empty;
/// German when it starts with `de`.
pub fn acp_language(env: &dyn Fn(&str) -> Option<String>) -> AcpLanguage {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|k| env(k))
        .find(|v| !v.is_empty());
    match locale {
        Some(v) if v.starts_with("de") => AcpLanguage::De,
        _ => AcpLanguage::En,
    }
}

/// The closed mode ids. Neither a mode nor its client label grants filesystem authority: a mode selects tool admission only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcpMode {
    /// The conversational profile.
    Chat,
    /// The coding profile in the granted worktree.
    Coding,
}

impl AcpMode {
    /// The wire id.
    pub fn id(self) -> &'static str {
        match self {
            AcpMode::Chat => "chat",
            AcpMode::Coding => "coding",
        }
    }

    /// `isAcpMode`: validate the closed mode ids without interpreting arbitrary editor text (only a string equal to an id).
    pub fn from_value(value: Option<&V>) -> Option<AcpMode> {
        match value?.as_str()? {
            "chat" => Some(AcpMode::Chat),
            "coding" => Some(AcpMode::Coding),
            _ => None,
        }
    }
}

/// ACP v1 mode metadata with stable ids and localized presentation.
pub fn mode_state(current: AcpMode, language: AcpLanguage) -> V {
    let t = acp_text(language);
    V::obj([
        ("currentModeId", V::s(current.id())),
        (
            "availableModes",
            V::Arr(vec![
                V::obj([
                    ("id", V::s("chat")),
                    ("name", V::s(t.chat_name)),
                    ("description", V::s(t.chat_description)),
                ]),
                V::obj([
                    ("id", V::s("coding")),
                    ("name", V::s(t.coding_name)),
                    ("description", V::s(t.coding_description)),
                ]),
            ]),
        ),
    ])
}
