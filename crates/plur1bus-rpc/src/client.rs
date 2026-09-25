use crate::error::RpcError;
use crate::transport::{connect as transport_connect, Stream};
use crate::types::ErrorCode;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Hello {
    pub contract: String,
    pub rpc: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    pub pid: u64,
}

#[derive(Debug, Clone)]
pub struct ConnectOptions {
    pub connect_timeout: Duration,
    pub call_timeout: Duration,
}
impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_millis(300),
            call_timeout: Duration::from_secs(30),
        }
    }
}

/// Blocking, strictly request→response: one stream behind a BufReader is enough because the CLI never has two calls in flight.
/// Writes go through `reader.get_mut()`, the one real stream.
pub struct Client {
    reader: BufReader<Box<dyn Stream>>,
    next_id: u64,
    hello: Hello,
}

const MAX_LINE: usize = 4 * 1024 * 1024;

impl Client {
    pub fn connect(address: &str, token: &str, opts: ConnectOptions) -> Result<Client, RpcError> {
        let stream = transport_connect(address, opts.connect_timeout)?;
        let mut client = Client {
            reader: BufReader::new(stream),
            next_id: 1,
            hello: Hello {
                contract: String::new(),
                rpc: String::new(),
                instance_id: String::new(),
                pid: 0,
            },
        };
        client
            .reader
            .get_ref()
            .set_read_timeout(Some(opts.call_timeout))?;
        let hello: Hello = client.call_typed("core.auth", &json!({ "token": token }))?;
        let major: u64 = hello
            .rpc
            .split('.')
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        if major != crate::SUPPORTED_RPC_MAJOR {
            return Err(RpcError::Version { server: hello.rpc });
        }
        client.hello = hello;
        Ok(client)
    }

    pub fn hello(&self) -> &Hello {
        &self.hello
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id;
        self.next_id += 1;
        let line = serde_json::to_string(
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .unwrap();
        {
            let w = self.reader.get_mut();
            w.write_all(line.as_bytes())?;
            w.write_all(b"\n")?;
            w.flush()?;
        }
        loop {
            let mut buf = String::new();
            let n = self.reader.read_line(&mut buf)?;
            if n == 0 {
                return Err(RpcError::Unavailable {
                    reason: "closed".into(),
                    detail: "connection closed by core".into(),
                });
            }
            if n > MAX_LINE {
                return Err(RpcError::Protocol("line too long".into()));
            }
            let msg: Value = serde_json::from_str(buf.trim_end())
                .map_err(|e| RpcError::Protocol(e.to_string()))?;
            // A notification on this connection (no id): the H1 CLI does not subscribe, so skip it.
            if msg.get("id").is_none() {
                continue;
            }
            if msg["id"] != json!(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                let error: ErrorCode = serde_json::from_value(err["data"]["error"].clone())
                    .unwrap_or(ErrorCode::EInternal);
                return Err(RpcError::Call {
                    error,
                    jsonrpc: err["code"].as_i64().unwrap_or(-32000),
                    message: err["message"].as_str().unwrap_or("").to_string(),
                    reason: err["data"]["reason"].as_str().map(String::from),
                    detail: err["data"]["detail"].as_str().map(String::from),
                });
            }
            return Ok(msg["result"].clone());
        }
    }

    pub fn call_typed<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: &P,
    ) -> Result<R, RpcError> {
        let v = self.call(
            method,
            serde_json::to_value(params).map_err(|e| RpcError::Protocol(e.to_string()))?,
        )?;
        serde_json::from_value(v).map_err(|e| RpcError::Protocol(format!("{method} result: {e}")))
    }
}
