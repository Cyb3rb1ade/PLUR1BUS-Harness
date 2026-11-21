//! `session/context-fit.ts`: the conservative context policy that counts the complete serialized message and tool input,
//! reserves the output, and refuses before any I/O. UTF-16 length divided by three is policy from the de/en samples of AF0, not
//! an exact tokenizer.
use super::jstext::len16;
use crate::approvals::js_json::J;
use crate::metrics::registry::js_number_to_string;

/// `MIN_CONTEXT_AGENT_ROLE` (`@plur1bus/config-schema`). `plur1bus-config` holds the same constant in a private module; the
/// replay compares both with TypeScript's value.
pub const MIN_CONTEXT_AGENT_ROLE: u64 = 16_384;
/// `APPLE_FM_CONTEXT_WINDOW`.
pub const APPLE_FM_CONTEXT_WINDOW: i64 = 4096;
/// The reserve a request without `maxTokens` gets.
pub const DEFAULT_RESERVE: i64 = 512;

const AGENT_ROLES: [&str; 5] = ["chat", "reasoning", "dream", "capture", "engine"];

/// `Pick<ChatRequest, "messages" | "tools" | "maxTokens">`; `messages` and `tools` are the JSON the request holds.
#[derive(Clone, Debug, PartialEq)]
pub struct FitRequest {
    /// `messages`.
    pub messages: J,
    /// `tools`, `None` for an absent member (counted as `[]`).
    pub tools: Option<J>,
    /// `maxTokens`, `None` for an absent member.
    pub max_tokens: Option<f64>,
}

/// What the two refusals carry. `ProviderError("invalid_request", .., { retryable: false })` and the `E_CONFIG_INVALID`
/// `RpcError` of `assertRoleContext`.
#[derive(Clone, Debug, PartialEq)]
pub enum FitError {
    /// `ProviderError`: `kind` is always `invalid_request` here, `retryable` always false.
    Provider {
        /// The message.
        message: String,
        /// `code`, where set (`context_overflow`).
        code: Option<&'static str>,
    },
    /// `RpcError("E_CONFIG_INVALID", .., { reason: "context-too-small" })`.
    Rpc {
        /// The message.
        message: String,
    },
}

/// `{ prompt, reserve }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextCost {
    /// `Math.ceil(serialized.length / 3)`.
    pub prompt: i64,
    /// The output reserve.
    pub reserve: i64,
}

fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

/// `assertRoleContext`: a known small model cannot serve an agent role; decision and short summarization have a per-call guard
/// instead.
pub fn assert_role_context(role: &str, window: Option<f64>) -> Result<(), FitError> {
    let Some(window) = window else {
        return Ok(());
    };
    if !AGENT_ROLES.contains(&role) || window >= MIN_CONTEXT_AGENT_ROLE as f64 {
        return Ok(());
    }
    Err(FitError::Rpc {
        message: format!(
            "model context window {} is below the {MIN_CONTEXT_AGENT_ROLE} floor for {role}",
            js_number_to_string(window)
        ),
    })
}

/// `contextCost`. The serialisation of `{ messages, tools: tools ?? [] }` cannot fail on a parsed value (TypeScript's
/// "cannot be measured" refusal needs a cycle or a BigInt, neither of which a JSON value holds).
pub fn context_cost(request: &FitRequest) -> Result<ContextCost, FitError> {
    let serialized = J::obj([
        ("messages", request.messages.clone()),
        ("tools", request.tools.clone().unwrap_or(J::Arr(vec![]))),
    ])
    .stringify();
    let reserve = request.max_tokens.unwrap_or(DEFAULT_RESERVE as f64);
    if !is_safe_integer(reserve) || reserve < 1.0 {
        return Err(FitError::Provider {
            message: "invalid output context reserve".to_owned(),
            code: None,
        });
    }
    Ok(ContextCost {
        prompt: len16(&serialized).div_ceil(3) as i64,
        reserve: reserve as i64,
    })
}

/// `assertContextFit`: refuse oversize work before a request exists. `window` defaults to [`APPLE_FM_CONTEXT_WINDOW`].
pub fn assert_context_fit(request: &FitRequest, window: Option<f64>) -> Result<(), FitError> {
    let cost = context_cost(request)?;
    let window = window.unwrap_or(APPLE_FM_CONTEXT_WINDOW as f64);
    if !is_safe_integer(window) || window < 1.0 || (cost.prompt + cost.reserve) as f64 > window {
        return Err(FitError::Provider {
            message: "request exceeds the model context policy".to_owned(),
            code: Some("context_overflow"),
        });
    }
    Ok(())
}
