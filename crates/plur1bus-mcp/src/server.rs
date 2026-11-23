//! Authenticated server protocol for the host's HTTP endpoint or stdio pipes.
use std::{
    borrow::Cow,
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};

use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ClientRequest, ContentBlock,
        ErrorCode, ErrorData, Implementation, JsonObject, ListToolsResult, PaginatedRequestParams,
        ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
    },
    service::{RequestContext, ServiceExt},
    RoleServer, ServerHandler,
};
use serde_json::{json, Value};
use tokio::{
    sync::{watch, Semaphore},
    task::spawn_blocking,
};
use ureq::http::{HeaderMap, Method};

use crate::{
    connection_fault::Fault,
    replies, runtime,
    session::{Reader, Writer},
    stdio,
};

mod headers;

const VERSION: &str = "2026-07-28";
const LEGACY: &str = "2025-11-25";
const BODY_LIMIT: usize = 256 * 1024;
const MAX_TOOLS: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    Unavailable,
    Timeout,
    Refused,
    Backpressure,
}

pub struct Actor {
    agent: String,
    principal: String,
}

impl Actor {
    pub fn new(agent: &str, principal: &str) -> Result<Self, Error> {
        if [agent, principal].into_iter().any(|value| {
            value.is_empty() || value.len() > 256 || value.chars().any(char::is_control)
        }) {
            return Err(Error::Invalid);
        }
        Ok(Self {
            agent: agent.to_owned(),
            principal: principal.to_owned(),
        })
    }
    pub fn agent_id(&self) -> &str {
        &self.agent
    }
    pub fn principal(&self) -> &str {
        &self.principal
    }
}

pub trait Host: Send + Sync {
    fn admit(&self, actor: &Actor, name: &str) -> bool;
    fn call(
        &self,
        actor: &Actor,
        name: &str,
        args: JsonObject,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Value, Error>;
}

struct Entry {
    tool: Tool,
    rules: Vec<headers::Rule>,
}

struct Shared {
    actor: Actor,
    entries: BTreeMap<String, Entry>,
    host: Arc<dyn Host>,
    ttl: u64,
    slots: Arc<Semaphore>,
    call_budget: Duration,
}

#[derive(Clone)]
pub struct Server(Arc<Shared>);

pub struct Response {
    pub status: u16,
    pub message: Value,
}

impl Server {
    pub fn new(
        actor: Actor,
        tools: Vec<Tool>,
        host: Arc<dyn Host>,
        ttl_ms: u64,
    ) -> Result<Self, Error> {
        if tools.len() > MAX_TOOLS {
            return Err(Error::Invalid);
        }
        let mut entries = BTreeMap::new();
        for tool in tools {
            let name = tool.name.to_string();
            if name.is_empty()
                || name.len() > 128
                || name.chars().any(char::is_control)
                || tool.input_schema.get("type").and_then(Value::as_str) != Some("object")
            {
                return Err(Error::Invalid);
            }
            let rules = headers::rules(&tool.input_schema)?;
            if entries.insert(name, Entry { tool, rules }).is_some() {
                return Err(Error::Invalid);
            }
        }
        Ok(Self(Arc::new(Shared {
            actor,
            entries,
            host,
            ttl: ttl_ms,
            slots: Arc::new(Semaphore::new(8)),
            call_budget: Duration::from_secs(30),
        })))
    }

    /// The host authenticates the actor before calling this method and transmits
    /// the returned JSON over its own HTTP endpoint.
    pub fn respond(&self, headers: &HeaderMap, bytes: &[u8], deadline: Instant) -> Response {
        self.respond_http(&Method::POST, headers, bytes, deadline, &|| false)
    }

    pub fn respond_http(
        &self,
        http_method: &Method,
        headers: &HeaderMap,
        bytes: &[u8],
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Response {
        if *http_method != Method::POST {
            return Response {
                status: 405,
                message: json!({ "error": "method_not_allowed" }),
            };
        }
        if bytes.len() > BODY_LIMIT {
            return Response {
                status: 413,
                message: json!({ "error": "payload_too_large" }),
            };
        }
        let Ok(request) = serde_json::from_slice::<Value>(bytes) else {
            return failure(200, Value::Null, -32700, "Parse error");
        };
        if !request.is_object() {
            return failure(
                200,
                Value::Null,
                -32600,
                "Invalid Request: batch or non-object payload",
            );
        }
        let id = match request.get("id") {
            None | Some(Value::Null) => Value::Null,
            Some(value)
                if value.is_i64()
                    || value
                        .as_str()
                        .is_some_and(|id| id.encode_utf16().count() <= 128) =>
            {
                value.clone()
            }
            _ => return failure(200, Value::Null, -32600, "Invalid JSON-RPC 2.0 request"),
        };
        let Some(method) = request["method"]
            .as_str()
            .filter(|method| !method.is_empty())
        else {
            return failure(200, id, -32600, "Invalid JSON-RPC 2.0 request");
        };
        if request["jsonrpc"] != "2.0" {
            return failure(200, id, -32600, "Invalid JSON-RPC 2.0 request");
        }
        if request.get("id").is_none() {
            return Response {
                status: 202,
                message: Value::Null,
            };
        }
        let params = &request["params"];
        let versions = [
            headers::single(headers, "mcp-protocol-version"),
            params["_meta"]["io.modelcontextprotocol/protocolVersion"].as_str(),
        ];
        let init_version = (method == "initialize")
            .then(|| params["protocolVersion"].as_str())
            .flatten();
        if versions
            .iter()
            .copied()
            .chain([init_version])
            .flatten()
            .any(|version| {
                !matches!(
                    version,
                    VERSION | LEGACY | "2025-06-18" | "2025-03-26" | "2024-11-05" | "2024-10-07"
                )
            })
        {
            return Response {
                status: 200,
                message: json!({"jsonrpc":"2.0","id":id,"error":{
                    "code":-32022,"message":"Unsupported MCP protocol version",
                    "data":{"supported":[VERSION,LEGACY,"2025-06-18","2025-03-26","2024-11-05","2024-10-07"]}
                }}),
            };
        }
        let modern = versions.contains(&Some(VERSION)) || method == "server/discover";
        if !modern {
            return self.legacy_call(id, method, params, deadline, cancelled);
        }
        if versions != [Some(VERSION), Some(VERSION)] {
            return failure(
                200,
                id,
                -32020,
                "Modern MCP requires matching 2026-07-28 version in header and _meta",
            );
        }
        if headers::single(headers, "mcp-method") != Some(method) {
            return failure(200, id, -32020, "Mcp-Method header missing or mismatched");
        }
        match method {
            "server/discover" => success(
                id,
                json!({
                    "resultType":"complete", "ttlMs":self.0.ttl, "cacheScope":"private",
                    "supportedVersions":[VERSION,LEGACY], "capabilities":{"tools":{}},
                    "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"plur1bus-harness","version":"0.1.0"}}
                }),
            ),
            "tools/list" => success(
                id,
                json!({
                    "resultType":"complete","ttlMs":self.0.ttl,"cacheScope":"private",
                    "tools":self.visible_tools(),
                }),
            ),
            "tools/call" => self.http_call(id, headers, params, deadline, cancelled),
            _ => failure(200, id, -32601, "MCP method is unavailable"),
        }
    }

    fn legacy_call(
        &self,
        id: Value,
        method: &str,
        params: &Value,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Response {
        match method {
            "initialize" => {
                if !params["capabilities"].is_object()
                    || !params["clientInfo"]["name"].is_string()
                    || !params["clientInfo"]["version"].is_string()
                    || !params["protocolVersion"].is_string()
                {
                    return failure(200, id, -32602, "MCP initialize parameters invalid");
                }
                let requested = params["protocolVersion"].as_str().unwrap_or(LEGACY);
                let version = if requested == VERSION {
                    LEGACY
                } else {
                    requested
                };
                success(
                    id,
                    json!({
                        "protocolVersion":version, "capabilities":{"tools":{}},
                        "serverInfo":{"name":"plur1bus-harness","version":"0.1.0"}
                    }),
                )
            }
            "ping" => success(id, json!({})),
            "tools/list" => success(id, json!({"tools":self.visible_tools()})),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or("");
                let args = params["arguments"].as_object().cloned().unwrap_or_default();
                let Ok(_permit) = self.0.slots.try_acquire() else {
                    return failure(200, id, -32000, "MCP tool service busy");
                };
                tool_response(
                    id,
                    self.invoke(name, args, deadline, cancelled, false),
                    false,
                )
            }
            _ => failure(200, id, -32601, "MCP method is unavailable"),
        }
    }

    fn http_call(
        &self,
        id: Value,
        headers: &HeaderMap,
        params: &Value,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Response {
        let name = params["name"].as_str().unwrap_or("");
        if headers::single(headers, "mcp-name") != Some(headers::encode(name).as_str()) {
            return failure(200, id, -32020, "Mcp-Name header missing or mismatched");
        }
        let Some(tool) = self.allowed(name) else {
            return failure(200, id, -32601, "MCP tool unavailable");
        };
        let args = params["arguments"].as_object().cloned().unwrap_or_default();
        if !headers::valid(&tool.rules, &args, headers) {
            return failure(
                200,
                id,
                -32020,
                "MCP parameter header missing or mismatched",
            );
        }
        let Ok(_permit) = self.0.slots.try_acquire() else {
            return failure(200, id, -32000, "MCP tool service busy");
        };
        tool_response(id, self.invoke(name, args, deadline, cancelled, true), true)
    }

    fn invoke(
        &self,
        name: &str,
        args: JsonObject,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
        modern: bool,
    ) -> Result<String, Error> {
        if self.allowed(name).is_none() {
            return Err(Error::Refused);
        }
        if Instant::now() >= deadline || cancelled() {
            return Err(Error::Timeout);
        }
        let out = self
            .0
            .host
            .call(&self.0.actor, name, args, deadline, cancelled)?;
        if Instant::now() >= deadline || cancelled() {
            return Err(Error::Timeout);
        }
        let encoded = match out {
            Value::String(text) if !modern => text,
            value => serde_json::to_string(&value).map_err(|_| Error::Invalid)?,
        };
        if encoded.len() > stdio::MAX_FRAME_BYTES {
            return Err(Error::Invalid);
        }
        Ok(encoded)
    }

    fn allowed(&self, name: &str) -> Option<&Entry> {
        self.0
            .entries
            .get(name)
            .filter(|_| self.0.host.admit(&self.0.actor, name))
    }

    fn visible_tools(&self) -> Vec<Tool> {
        self.0
            .entries
            .values()
            .filter(|entry| self.0.host.admit(&self.0.actor, &entry.tool.name))
            .map(|entry| entry.tool.clone())
            .collect()
    }

    /// Serve the SDK protocol over an already authorized pair of pipes.
    /// The host owns process and pipe lifetime and may send true to stop.
    pub fn serve_stdio(
        self,
        reader: Reader,
        writer: Writer,
        mut stop: watch::Receiver<bool>,
        frame_deadline: Duration,
    ) -> Result<(), Error> {
        runtime::quiet(
            || async move {
                let transport = stdio::Framed::<RoleServer, _, _>::new(
                    reader,
                    writer,
                    BODY_LIMIT,
                    frame_deadline,
                )
                .map_err(|_| Error::Invalid)?;
                let fault = Fault::new();
                let transport = replies::Bounded::new(
                    transport,
                    BODY_LIMIT,
                    frame_deadline,
                    fault.clone(),
                    |request| matches!(request, ClientRequest::PingRequest(_)),
                );
                if *stop.borrow() {
                    return Ok(());
                }
                let running = tokio::select! {
                    result = tokio::time::timeout(frame_deadline, self.serve(transport)) => {
                        result.map_err(|_| Error::Timeout)?.map_err(|_| Error::Unavailable)?
                    }
                    _ = stop.changed() => return Ok(()),
                };
                let cancel = running.cancellation_token();
                let waiting = running.waiting();
                tokio::pin!(waiting);
                tokio::select! {
                    biased;
                    _ = fault.wait() => {
                        cancel.cancel();
                        return Err(Error::Backpressure);
                    }
                    _ = &mut waiting => {}
                    _ = stop.changed() => {
                        cancel.cancel();
                        let _ = tokio::time::timeout(frame_deadline, &mut waiting).await;
                    }
                }
                Ok(())
            },
            frame_deadline,
        )
        .map_err(|_| Error::Unavailable)?
    }
}

impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
            .with_server_info(Implementation::new("plur1bus-harness", "0.1.0"))
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28, ProtocolVersion::V_2025_11_25])
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.visible_tools())
            .with_ttl_ms(self.0.ttl)
            .with_cache_scope(rmcp::model::CacheScope::Private))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let permit = self
            .0
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| protocol_error(Error::Unavailable))?;
        let server = self.clone();
        let deadline = Instant::now() + self.0.call_budget;
        let cancelled = context.ct.clone();
        let modern = context
            .protocol_version()
            .is_some_and(|version| version.as_str() == VERSION);
        let task = spawn_blocking(move || {
            let _permit = permit;
            server.invoke(
                &request.name,
                request.arguments.unwrap_or_default(),
                deadline,
                &|| cancelled.is_cancelled(),
                modern,
            )
        });
        let value = tokio::select! {
            _ = context.ct.cancelled() => return Err(protocol_error(Error::Timeout)),
            result = tokio::time::timeout_at(deadline.into(), task) => {
                result.map_err(|_| protocol_error(Error::Timeout))?
                    .map_err(|_| protocol_error(Error::Unavailable))?.map_err(protocol_error)?
            }
        };
        Ok(CallToolResult::success(vec![ContentBlock::text(value)]).into())
    }
}

fn tool_response(id: Value, outcome: Result<String, Error>, modern: bool) -> Response {
    let (text, is_error) = match outcome {
        Ok(text) => (text, false),
        Err(Error::Invalid) => ("Tool execution failed".into(), true),
        Err(Error::Unavailable) => {
            return Response {
                status: 200,
                message: json!({
                    "jsonrpc":"2.0","id":id, "error":{"code":-32000,"message":"Core service unavailable",
                    "data":{"error":"E_CORE_UNAVAILABLE","reason":"core-unavailable"}}
                }),
            }
        }
        Err(error) => return failure(200, id, protocol_error(error).code.0, error_message(error)),
    };
    let mut result = json!({"content":[{"type":"text","text":text}],"isError":is_error});
    if modern {
        result["resultType"] = json!("complete");
    }
    success(id, result)
}

fn success(id: Value, result: Value) -> Response {
    Response {
        status: 200,
        message: rpc_body(id, "result", result),
    }
}

fn failure(status: u16, id: Value, code: i32, message: &str) -> Response {
    Response {
        status,
        message: rpc_body(id, "error", json!({"code":code,"message":message})),
    }
}

fn rpc_body(id: Value, kind: &'static str, content: Value) -> Value {
    Value::Object(
        [
            ("jsonrpc".into(), json!("2.0")),
            ("id".into(), id),
            (kind.into(), content),
        ]
        .into_iter()
        .collect(),
    )
}

fn error_message(error: Error) -> &'static str {
    match error {
        Error::Invalid => "MCP tool input or result invalid",
        Error::Backpressure => "MCP reply budget exhausted",
        Error::Unavailable => "Core service unavailable",
        Error::Refused => "MCP tool unavailable",
        Error::Timeout => "MCP tool deadline reached",
    }
}

fn protocol_error(error: Error) -> ErrorData {
    let code = match error {
        Error::Invalid => ErrorCode::INVALID_PARAMS,
        Error::Unavailable | Error::Backpressure => ErrorCode(-32000),
        Error::Refused => ErrorCode::METHOD_NOT_FOUND,
        Error::Timeout => ErrorCode(-32001),
    };
    ErrorData::new(code, error_message(error), None)
}

#[cfg(test)]
mod tests {
    use super::{Actor, Error, Host, Server};
    use rmcp::model::{JsonObject, Tool};
    use serde_json::{json, Value};
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };
    use ureq::http::{HeaderMap, HeaderValue};

    struct Echo;

    impl Host for Echo {
        fn admit(&self, _: &Actor, _: &str) -> bool {
            true
        }
        fn call(
            &self,
            _: &Actor,
            _: &str,
            _: JsonObject,
            _: Instant,
            _: &dyn Fn() -> bool,
        ) -> Result<Value, Error> {
            Ok(json!({"fixture":true}))
        }
    }

    #[test]
    fn modern_http_refuses_dispatch_while_call_slots_are_unavailable() -> Result<(), Error> {
        let tool: Tool =
            serde_json::from_value(json!({"name":"fixture","inputSchema":{"type":"object"}}))
                .map_err(|_| Error::Invalid)?;
        let server = Server::new(
            Actor::new("agent", "person")?,
            vec![tool],
            Arc::new(Echo),
            100,
        )?;
        let _available = server
            .0
            .slots
            .try_acquire_many(8)
            .map_err(|_| Error::Unavailable)?;
        let headers = [
            ("mcp-protocol-version", "2026-07-28"),
            ("mcp-method", "tools/call"),
            ("mcp-name", "fixture"),
        ]
        .into_iter()
        .fold(HeaderMap::new(), |mut headers, (name, value)| {
            headers.insert(name, HeaderValue::from_static(value));
            headers
        });
        let response = server.respond(&headers,
            br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fixture","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#,
            Instant::now() + Duration::from_secs(1));
        assert_eq!(
            response.message["error"]["message"],
            "MCP tool service busy"
        );
        Ok(())
    }
}
