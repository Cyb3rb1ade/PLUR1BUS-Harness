//! `deliveryAllowed` (`delivery/policy.ts`): may the configuration's allowlist of a channel deliver to this handle. Re-read for
//! every attempt; the channel adapter checks it again when it sends.
use super::ChannelIdentity;
use serde_json::Value;

/// `String(n)` of a JavaScript number (`Number::toString`, radix 10): the shortest digits that round-trip, positional between
/// 1e-6 and 1e21, exponent form (`1e+21`, `1.5e+300`, `1e-7`) outside.
pub fn js_number_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity" } else { "Infinity" }.into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // `{:e}` gives the shortest round-trip digits as `d.ddde<exp>`.
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // `n` is the position of the decimal point relative to the digits.
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = format!("{}{}", if e < 0 { "-" } else { "+" }, e.abs());
        if k == 1 {
            format!("{digits}e{es}")
        } else {
            format!("{}.{}e{es}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `deliveryAllowed(config, identity)`. `channels` is `config.channels`; `buzz_key` is the Buzz channel's `publicKey` (the
/// decoder of `npub` strings belongs to the channel, P4-W): it answers `None` where TypeScript's throws.
///
/// A channel is enabled only when `enabled` is the boolean `true`. The list is `senderAllowlist` (Buzz), `dmAllowlist`
/// (Discord, Matrix, Slack) or `allowlist`; anything that is not an array denies. An entry matches when it is a string or a
/// number whose JavaScript `String()` equals the sender id (a Telegram id may be numeric in the file); Buzz entries match
/// through their public key.
pub fn delivery_allowed(
    channels: &Value,
    identity: &ChannelIdentity,
    buzz_key: &dyn Fn(&str) -> Option<String>,
) -> bool {
    let Some(c) = channels.get(identity.channel.as_str()) else {
        return false;
    };
    if c.get("enabled") != Some(&Value::Bool(true)) {
        return false;
    }
    let key = match identity.channel.as_str() {
        "buzz" => "senderAllowlist",
        "discord" | "matrix" | "slack" => "dmAllowlist",
        _ => "allowlist",
    };
    let Some(list) = c.get(key).and_then(Value::as_array) else {
        return false;
    };
    if identity.channel == "buzz" {
        return list.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| buzz_key(s).as_deref() == Some(identity.user_id.as_str()))
        });
    }
    list.iter().any(|v| match v {
        Value::String(s) => *s == identity.user_id,
        Value::Number(n) => n
            .as_f64()
            .is_some_and(|f| js_number_string(f) == identity.user_id),
        _ => false,
    })
}
