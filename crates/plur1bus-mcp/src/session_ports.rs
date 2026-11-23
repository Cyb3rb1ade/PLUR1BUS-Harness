//! Explicit capabilities and validated input for peer-to-host MCP requests.
#![expect(
    deprecated,
    reason = "Phase 4 carries the legacy roots and sampling wire contracts"
)]
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use rmcp::{
    model::{
        ClientCapabilities, ClientConfig, ContextInclusion, CreateMessageRequestParams,
        CreateMessageResult, ElicitRequestParams, ElicitResult, ElicitationAction, ErrorCode,
        ErrorData, Implementation, ListRootsResult, ProtocolVersion,
    },
    service::{NotificationContext, RequestContext},
    ClientHandler, RoleClient,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tokio::{sync::Semaphore, task::spawn_blocking};

use crate::{session::Error, session_schema::OutputSchema};

#[derive(Clone, Copy)]
pub enum Feature {
    Roots,
    Sampling,
    Elicitation,
    UrlElicitation,
}

pub trait ClientPorts: Send + Sync {
    fn supports(&self, feature: Feature) -> bool;
    fn invoke(
        &self,
        feature: Feature,
        params: Value,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Value, Error>;
}

pub(crate) struct Handler {
    config: ClientConfig,
    ports: Option<Arc<dyn ClientPorts>>,
    ttl: Duration,
    generation: Arc<AtomicU64>,
    available: Arc<Semaphore>,
}

impl Handler {
    pub(crate) fn new(
        ports: Option<Arc<dyn ClientPorts>>,
        ttl: Duration,
        generation: Arc<AtomicU64>,
        modern: bool,
    ) -> Result<Self, Error> {
        let mut map = serde_json::Map::new();
        if let Some(ports) = ports.as_ref() {
            if ports.supports(Feature::Roots) {
                map.insert(
                    "roots".into(),
                    if modern {
                        json!({})
                    } else {
                        json!({"listChanged":true})
                    },
                );
            }
            if ports.supports(Feature::Sampling) {
                map.insert("sampling".into(), json!({}));
            }
            if ports.supports(Feature::Elicitation) {
                let mut features = json!({"form":{}});
                if ports.supports(Feature::UrlElicitation) {
                    features["url"] = json!({});
                }
                map.insert("elicitation".into(), features);
            }
        }
        let capabilities: ClientCapabilities =
            serde_json::from_value(Value::Object(map)).map_err(|_| Error::Start)?;
        let config = ClientConfig::new(
            capabilities,
            Implementation::new("plur1bus-harness", "0.1.0"),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25);
        Ok(Self {
            config,
            ports,
            ttl,
            generation,
            available: Arc::new(Semaphore::new(8)),
        })
    }

    async fn request<P: Serialize, T: DeserializeOwned>(
        &self,
        feature: Feature,
        params: P,
        context: RequestContext<RoleClient>,
    ) -> Result<T, ErrorData> {
        let Some(ports) = self.ports.as_ref().filter(|ports| ports.supports(feature)) else {
            return Err(ErrorData::new(
                ErrorCode::METHOD_NOT_FOUND,
                "MCP client feature is disabled",
                None,
            ));
        };
        let ports = Arc::clone(ports);
        let permit = self
            .available
            .clone()
            .try_acquire_owned()
            .map_err(|_| refused())?;
        let deadline = Instant::now() + self.ttl;
        let cancel = context.ct.clone();
        let params = serde_json::to_value(params).map_err(|_| invalid())?;
        let task = spawn_blocking(move || {
            let _permit = permit;
            if cancel.is_cancelled() || Instant::now() >= deadline {
                return Err(Error::Timeout);
            }
            ports.invoke(feature, params, deadline, &|| {
                cancel.is_cancelled() || Instant::now() >= deadline
            })
        });
        let result = tokio::select! {
            _ = context.ct.cancelled() => return Err(refused()),
            result = tokio::time::timeout_at(deadline.into(), task) => result.map_err(|_| refused())?
                .map_err(|_| refused())?.map_err(|_| refused())?,
        };
        if serde_json::to_vec(&result).map_err(|_| invalid())?.len() > crate::stdio::MAX_FRAME_BYTES
        {
            return Err(invalid());
        }
        serde_json::from_value(result).map_err(|_| invalid())
    }
}

impl ClientHandler for Handler {
    fn get_info(&self) -> ClientConfig {
        self.config.clone()
    }

    async fn list_roots(
        &self,
        context: RequestContext<RoleClient>,
    ) -> Result<ListRootsResult, ErrorData> {
        let result: ListRootsResult = self.request(Feature::Roots, json!({}), context).await?;
        if result
            .roots
            .iter()
            .any(|root| !root.uri.starts_with("file://"))
        {
            return Err(invalid());
        }
        Ok(result)
    }

    async fn create_message(
        &self,
        params: CreateMessageRequestParams,
        context: RequestContext<RoleClient>,
    ) -> Result<CreateMessageResult, ErrorData> {
        if params.tools.is_some()
            || params.tool_choice.is_some()
            || params
                .include_context
                .as_ref()
                .is_some_and(|context| !matches!(context, ContextInclusion::None))
        {
            return Err(invalid());
        }
        self.request(Feature::Sampling, params, context).await
    }

    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, ErrorData> {
        let schema = match &request {
            ElicitRequestParams::UrlElicitationParams { url, .. } => {
                if !self
                    .ports
                    .as_ref()
                    .is_some_and(|ports| ports.supports(Feature::UrlElicitation))
                {
                    return Err(invalid());
                }
                let parsed = crate::http::checked_url(url).map_err(|_| invalid())?;
                if parsed.scheme() != "https" {
                    return Err(invalid());
                }
                None
            }
            ElicitRequestParams::FormElicitationParams {
                requested_schema, ..
            } => {
                let schema = serde_json::to_value(requested_schema).map_err(|_| invalid())?;
                Some(
                    OutputSchema::compile(schema.as_object().ok_or_else(invalid)?)
                        .map_err(|_| invalid())?,
                )
            }
            _ => return Err(invalid()),
        };
        let result: ElicitResult = self.request(Feature::Elicitation, request, context).await?;
        if result.action == ElicitationAction::Accept {
            if let Some(schema) = schema {
                let data = result
                    .content
                    .as_ref()
                    .map(serde_json::to_value)
                    .transpose()
                    .map_err(|_| invalid())?;
                schema.validate(data.as_ref()).map_err(|_| invalid())?;
            }
        }
        Ok(result)
    }

    async fn on_tool_list_changed(&self, _: NotificationContext<RoleClient>) {
        self.generation.fetch_add(1, Ordering::Release);
    }
}

fn refused() -> ErrorData {
    ErrorData::internal_error("MCP client port failed validation or execution", None)
}

fn invalid() -> ErrorData {
    ErrorData::invalid_params("MCP client request refused", None)
}
