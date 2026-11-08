//! Genuine T3 composition: authenticated mood, local/host emotion, dynamics and reminders.
//! No background refinement or provider fallback is invented when a route is unavailable.
use super::{
    categorize, dynamics,
    emotion_engine::{AnalysisOptions, EmotionEngine},
    emotion_json::{get, numeric, text},
    emotion_legacy,
    emotion_pool::EmotionalPool,
    pipeline::{CaptureClassification, CaptureClassifier, CaptureDynamics, ClassificationRequest},
    reminder_store::ReminderStore,
    tier1::Tier1Classifier,
};
use crate::{
    context::RequestContext,
    contract::{
        Cancel, EngineError, HostError, HostServices, LlmParams, LlmPort, LlmResult, MemoryRow,
        MessageRole, StoreError, TurnRecord,
    },
    store::directory::TrustedDirectory,
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

/// Native host composition binds the actual feature route to this caller's authority and lease.
/// The returned callback owns model routing and disableThinking at the host;
/// the native capture wrapper supplies the contract's 300-token cap and no temperature.
/// and must observe Cancel. None means genuinely unavailable, never a synthetic empty provider.
pub trait CaptureEmotionRoutes: Send + Sync {
    /// Resolve a new caller-owned route. It is released after this one classification call.
    fn bind(
        &self,
        turn: &TurnRecord,
        cancel: &Cancel,
    ) -> Result<Option<Arc<dyn LlmPort>>, EngineError>;
}
struct EmotionCompletion(Arc<dyn LlmPort>);
impl LlmPort for EmotionCompletion {
    fn complete(&self, mut params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        params.max_tokens = Some(300.into());
        params.temperature = None;
        self.0.complete(params, cancel)
    }
}
#[derive(Hash, PartialEq, Eq)]
struct Binding {
    agent: String,
    owner: String,
    workspace: String,
    directory: Option<std::path::PathBuf>,
}
/// Caller-local emotion history, with the same MoodPool shared with native recall.
pub struct NativeCaptureClassifier {
    host: Arc<dyn HostServices>,
    config: Value,
    routes: Arc<dyn CaptureEmotionRoutes>,
    mood: Arc<EmotionalPool>,
    reminders: Arc<ReminderStore>,
    engines: Mutex<HashMap<Binding, Arc<Mutex<EmotionEngine>>>>,
}
impl NativeCaptureClassifier {
    /// Compose actual providers; no store writes or LLM calls occur during construction.
    pub fn new(
        host: Arc<dyn HostServices>,
        routes: Arc<dyn CaptureEmotionRoutes>,
        mood: Arc<EmotionalPool>,
        reminders: Arc<ReminderStore>,
    ) -> Result<Self, EngineError> {
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::InvalidInput)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        Ok(Self {
            host,
            config,
            routes,
            mood,
            reminders,
            engines: Mutex::new(HashMap::new()),
        })
    }
    fn binding(&self, turn: &TurnRecord, context: &RequestContext) -> Result<Binding, EngineError> {
        let before = self.host.workspace_dir(&turn.principal.agent_id)?;
        let checked = RequestContext::build(&turn.principal, &turn.agent, self.host.as_ref())?;
        if checked != *context
            || turn.agent_id != checked.agent_id
            || before != self.host.workspace_dir(&turn.principal.agent_id)?
        {
            return Err(StoreError::InvalidInput.into());
        }
        let directory = before
            .map(|path| TrustedDirectory::open(&path).map(|dir| dir.path().to_path_buf()))
            .transpose()?;
        Ok(Binding {
            agent: checked.agent_id.to_string(),
            owner: checked.owner_user_id,
            workspace: checked.workspace_key,
            directory,
        })
    }
    fn engine(&self, binding: Binding) -> Result<Arc<Mutex<EmotionEngine>>, EngineError> {
        let mut engines = self.engines.lock().map_err(|_| StoreError::Corrupt)?;
        if let Some(engine) = engines.get(&binding) {
            return Ok(engine.clone());
        }
        let emotion = &self.config["emotion"];
        let config = json!({"tier2":{"enabled":emotion["t2"]["enabled"]!=false},"tier3":{"enabled":emotion["t3"]["enabled"]!=false,"timeoutMs":emotion["t3"]["timeoutMs"].as_f64().unwrap_or(4000.)},"escalationConfidence":emotion["t3"]["escalationConfidence"].as_f64().unwrap_or(0.85)});
        let host = self.host.clone();
        let engine = Arc::new(Mutex::new(EmotionEngine::new(
            &to_json(&config)?,
            None,
            Arc::new(move || host.now_ms()),
        )?));
        engines.insert(binding, engine.clone());
        Ok(engine)
    }
}
impl CaptureClassifier for NativeCaptureClassifier {
    fn classify(
        &self,
        request: ClassificationRequest<'_>,
    ) -> Result<CaptureClassification, EngineError> {
        let ClassificationRequest {
            text: input,
            turn,
            context,
            now,
            cancel,
            ..
        } = request;
        cancel.check()?;
        let binding = self.binding(turn, context)?;
        // Read mood before a provider hop; foreign persisted state never authorizes an LLM call.
        let mood = self
            .mood
            .read(&turn.principal, &turn.agent, cancel, |state, now| {
                state.snapshot(now)
            })?;
        let emotion_config = &self.config["emotion"];
        let route = self
            .routes
            .bind(turn, cancel)?
            .map(|port| Arc::new(EmotionCompletion(port)) as Arc<dyn LlmPort>);
        let enabled = emotion_config["t3"]["enabled"] != false
            && (route.is_some() || emotion_config["t3"]["onlyWhenProviderAvailable"] == false);
        let tier = emotion_config["tier"].as_str().unwrap_or("auto");
        let deferred = emotion_config["t3"]["captureMode"] != "inline" && enabled && tier == "auto";
        let engine = self.engine(binding)?;
        let options = AnalysisOptions {
            force_tier: match tier {
                "t1" => Some(1),
                "t2" => Some(2),
                "t3" => Some(3),
                _ => None,
            },
            skip_tier3: deferred,
        };
        let result = engine
            .lock()
            .map_err(|_| StoreError::Corrupt)?
            .analyze_with_completion(input, "user", options, cancel, route);
        cancel.check()?;
        let emotion = match result {
            Ok(score) => emotion_legacy::from_score(&score),
            Err(_) => emotion_legacy::infer_sync(&Tier1Classifier::new(&Json::Null)?, input, now)?,
        };
        self.binding(turn, context)?;
        let confident = numeric(get(&emotion, "confidence")).is_some_and(|n| {
            n.is_finite()
                && n >= emotion_config["t3"]["escalationConfidence"]
                    .as_f64()
                    .unwrap_or(0.85)
        });
        let minimum = emotion_config["t3"]
            .get("refineImportanceMin")
            .map(|v| dynamics::number(Some(&to_json(v).unwrap_or(Json::Null))))
            .filter(|n| n.is_finite() && *n >= 0.)
            .unwrap_or(0.9);
        let status = if deferred && (!confident || 0.5 >= minimum) {
            "pending_t3"
        } else {
            "final"
        };
        let category = categorize::categorize_memory_with_reason(input)?.category;
        let base = json!({"importance":0.5,"category":category,"emotionalIntensity":numeric(get(&emotion,"emotionalIntensity")).unwrap_or(0.),"emotionalDominant":text(get(&emotion,"emotionalDominant")).unwrap_or_else(||"neutral".into())});
        let options = json!({"intensityHalfLifeFactor":emotion_config["intensityHalfLifeFactor"].as_f64().unwrap_or(1.),"flashbulbEncodingEnabled":self.config["memoryDynamics"]["flashbulbEncoding"]==true});
        let encoded = dynamics::apply_dynamics_defaults(
            &to_json(&base)?,
            now as f64,
            &to_json(&self.config["recall"]["halfLifeDaysMap"])?,
            &to_json(&options)?,
        );
        Ok(CaptureClassification {
            category: category.into(),
            emotional_valence: emotion_legacy::serialize(&emotion),
            emotional_intensity: number(&encoded, "emotionalIntensity")?,
            emotional_dominant: text(get(&encoded, "emotionalDominant"))
                .ok_or(StoreError::InvalidInput)?,
            mood_context_at_capture: emotion_legacy::serialize(&mood),
            emotion_status: status.into(),
            dynamics: CaptureDynamics {
                memory_strength: number(&encoded, "memoryStrength")?,
                half_life_days: number(&encoded, "halfLifeDays")?,
                last_strengthened_at: number(&encoded, "lastStrengthenedAt")?,
                last_dynamics_at: number(&encoded, "lastDynamicsAt")?,
                memory_class: text(get(&encoded, "memoryClass")).ok_or(StoreError::InvalidInput)?,
                never_forget: number(&encoded, "neverForget")?,
                core_memory_score: number(&encoded, "coreMemoryScore")?,
                core_memory_reason: text(get(&encoded, "coreMemoryReason"))
                    .ok_or(StoreError::InvalidInput)?,
            },
        })
    }
    fn post_store(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        _rows: &[MemoryRow],
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        cancel.check()?;
        self.binding(turn, context)?;
        let mut failure = None;
        for message in &turn.messages {
            if !matches!(message.role, MessageRole::User | MessageRole::Assistant)
                || message.content.encode_utf16().count() <= 20
            {
                continue;
            }
            if !super::speaker::media_ids(&JsString::from(message.content.as_str()))?.is_empty() {
                failure = Some(EngineError::NotAvailable {
                    reason: "speaker-media-authority-unavailable".into(),
                });
            }
        }
        // Original selected items, not expanded rows: one reminder per source message.
        for item in super::pipeline::prepare::select_items(turn)? {
            cancel.check()?;
            if let Err(error) = self.reminders.capture(
                &item.text,
                &item.role,
                self.config["reminders"]["autoExtract"] != false,
                &turn.principal,
                &turn.agent,
                cancel,
            ) {
                failure.get_or_insert(error);
            }
        }
        cancel.check()?;
        failure.map_or(Ok(()), Err)
    }
}
fn to_json(value: &Value) -> Result<Json, EngineError> {
    parse_json(&value.to_string()).map_err(|_| StoreError::InvalidInput.into())
}
fn number(value: &Json, key: &str) -> Result<f64, EngineError> {
    numeric(get(value, key))
        .filter(|v| v.is_finite())
        .ok_or_else(|| StoreError::InvalidInput.into())
}
