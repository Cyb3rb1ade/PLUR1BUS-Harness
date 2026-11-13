//! D111 §4 redaction of the audit `detail`: the CLI's face of the one redactor in `plur1bus_log_schema::redact`.
//!
//! The algorithm and its data (`packages/log-schema/schema/redaction.json`) live in `plur1bus-log-schema`, where the
//! core uses them too, so the two cannot drift apart. This module only picks the CLI's options: none. Rule 1 (the
//! registry of secret values: an offline CLI process holds none) and rule 6 (PII, off by default, `logs.redactPii` is a
//! core setting) are options of that redactor the CLI does not set. The audit writers call [`redact_detail`] once,
//! before the record reaches the chain or `audit.log`, so both hold the same redacted line. A redaction that cannot be
//! set up returns an error and nothing is written: an audit line never falls back to the raw detail.
use plur1bus_log_schema::redact::Redactor;
use serde_json::Value;
use std::io;

fn redactor() -> io::Result<&'static Redactor> {
    Redactor::shared().map_err(|e| io::Error::other(format!("audit {e}")))
}

/// `detail` with every secret redacted. An error (the redaction data cannot be read) means: write nothing.
pub(crate) fn redact_detail(detail: &Value) -> io::Result<Value> {
    redact_detail_preserving_references(detail, &[])
}

/// Preserve only exact schema-validated reference subtrees; all other audit values keep the central backstops.
pub(crate) fn redact_detail_preserving_references(
    detail: &Value,
    references: &[String],
) -> io::Result<Value> {
    Ok(redactor()?.value_preserving_references(detail, references))
}

/// One string through the rules (used by the tests; the audit writers only go through [`redact_detail`]).
pub(crate) fn redact_text(text: &str) -> io::Result<String> {
    Ok(redactor()?.text(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use plur1bus_log_schema::redact::MAX_DEPTH;
    use serde_json::json;

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/log-schema/fixtures/vectors.json"
        ))
        .unwrap()
    }

    fn parts(v: &Value) -> String {
        strings(v).concat()
    }

    #[test]
    fn a_reference_exception_keeps_heuristic_siblings_and_other_text_backstops_protected() {
        let literal = uuid::Uuid::new_v4().to_string();
        let token = format!(
            "ghp_{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let detail = json!({"apiKey":{"handle":"service.reference","ordinary":literal},
            "public":{"text":token,"path":"/home/fixture/.ssh/id_rsa"}});
        let redacted =
            redact_detail_preserving_references(&detail, &["/apiKey/handle".to_owned()]).unwrap();
        assert_eq!(redacted["apiKey"]["handle"], "service.reference");
        assert_eq!(redacted["apiKey"]["ordinary"], "[REDACTED:key]");
        assert!(!redacted.to_string().contains(&literal));
        assert!(!redacted.to_string().contains(&token));
        assert!(!redacted["public"]["path"]
            .as_str()
            .unwrap()
            .contains("id_rsa"));
    }

    /// Output of the TypeScript redactor (`createRedactor().text`) for the same input.
    #[test]
    fn text_matches_the_typescript_redactor() {
        let cases = [
            (
                "see https://user:hunter2@example.com/a/b?token=abc123&x=1#frag now",
                "see https://example.com/a/b?token=[REDACTED:url]&x=[REDACTED:url]#[REDACTED:url] now",
            ),
            (
                "Authorization: Bearer abcdef123456 trailing",
                "Authorization: [REDACTED:key]",
            ),
            (
                "failed with password=hunter2 and retry",
                "failed with password=[REDACTED:key] and retry",
            ),
            (
                "{\"apiKey\":\"zzz\",\"model\":\"m\"}",
                "{\"apiKey\":\"[REDACTED:key]\",\"model\":\"m\"}",
            ),
            (
                "opened /home/alice/.ssh/id_rsa for read",
                "opened <deny:ssh>/…#fe53c4 for read",
            ),
            (
                "read C:\\Users\\bob\\.aws\\credentials today",
                "read <deny:cloud-cli>/…#c0c7f0 today",
            ),
            (
                "cfg at ~/.config/gh/hosts.yml ok",
                "cfg at <deny:cloud-cli>/…#ac3241 ok",
            ),
            (
                "file /srv/app/.env.local here",
                "file <deny:dotenv>/…#8a9285 here",
            ),
            (
                "PLUR1BUS_TOKEN=abcd1234 set",
                "PLUR1BUS_TOKEN=[REDACTED:pattern] set",
            ),
            (
                "x QkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQk y",
                "x [REDACTED:pattern] y",
            ),
            (
                "Basic info and Basic dXNlcjpwYXNzd29yZA== end",
                "Basic info and [REDACTED:pattern] end",
            ),
            (
                "plain text stays: backend=file purpose=embedding",
                "plain text stays: backend=file purpose=embedding",
            ),
            (
                "/Users/me/Library/Application Support/Google/Chrome/Default/Cookies done",
                "<deny:browser-profile>/…#b712f8 done",
            ),
            (
                "line one\nCookie: a=1; b=2\nline three",
                "line one\nCookie: [REDACTED:key]\nline three",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(redact_text(input).unwrap(), want, "{input}");
        }
    }

    #[test]
    fn shared_redaction_removes_entire_quoted_free_bearer_values() {
        for input in [
            "sent Bearer \"first-fragment last-fragment\" to host",
            "sent bearer 'first-fragment last-fragment' to host",
        ] {
            let out = redact_text(input).unwrap();
            assert_eq!(out, "sent [REDACTED:pattern] to host", "{input}");
            assert_eq!(redact_text(&out).unwrap(), out);
        }
    }

    #[test]
    fn shared_redaction_removes_folded_authorization_continuations() {
        for header in ["Authorization", "Proxy-Authorization"] {
            let input = format!(
                "{header}: Bearer first-fragment\r\n\tcontinued-fragment more-fragment\r\nX-Request-Id: public-fixture"
            );
            let out = redact_text(&input).unwrap();
            for secret in ["first-fragment", "continued-fragment", "more-fragment"] {
                assert!(!out.contains(secret), "{secret} survived in {out:?}");
            }
            assert!(out.ends_with("\r\nX-Request-Id: public-fixture"), "{out:?}");
            assert_eq!(redact_text(&out).unwrap(), out);
        }
    }

    #[test]
    fn shared_redaction_removes_access_key_and_credential_assignments() {
        let cases = [
            (
                "access_key=fixture-access-value",
                "access_key=[REDACTED:key]",
            ),
            (
                "access-key-id=fixture-access-id",
                "access-key-id=[REDACTED:key]",
            ),
            (
                "credential=fixture-credential-value",
                "credential=[REDACTED:key]",
            ),
        ];
        let actual: Vec<_> = cases
            .iter()
            .map(|(input, _)| redact_text(input).unwrap())
            .collect();
        let expected: Vec<_> = cases.iter().map(|(_, want)| *want).collect();
        assert_eq!(actual, expected);
        for out in actual {
            assert_eq!(redact_text(&out).unwrap(), out);
        }
    }

    #[test]
    fn shared_redaction_removes_bare_telegram_bot_credentials() {
        for token in [
            ["123456", ":", "ABCDEFGHIJKLMNOPQRST"].concat(),
            ["123456789012", ":", "ABCDEFGHIJKLMNOPQRST_uv-"].concat(),
        ] {
            let input = format!("sent {token} to host");
            let out = redact_text(&input).unwrap();
            assert_eq!(out, "sent [REDACTED:pattern] to host", "{input}");
            assert_eq!(redact_text(&out).unwrap(), out);
        }
    }

    #[test]
    fn shared_redaction_keeps_deliberate_vendor_token_length_thresholds() {
        for token in [
            format!("{}{}", "gho_", "Z".repeat(30)),
            format!("{}{}", "gho_", "Z".repeat(35)),
            format!("{}{}", "sk-", "z".repeat(19)),
        ] {
            assert_eq!(redact_text(&token).unwrap(), token);
        }
        for token in [
            format!("{}{}", "gho_", "Z".repeat(36)),
            format!("{}{}", "sk-", "z".repeat(20)),
        ] {
            assert_eq!(redact_text(&token).unwrap(), "[REDACTED:pattern]");
        }
    }

    #[test]
    fn values_follow_the_key_rule_and_keep_what_is_not_secret() {
        let got = redact_detail(&json!({
            "a": { "token": "x", "n": 1, "list": ["Bearer abc.def", "ok"] },
            "input_tokens": 5,
            "nul": null,
            "password": null,
        }))
        .unwrap();
        assert_eq!(
            got,
            json!({
                "a": { "token": "[REDACTED:key]", "n": 1, "list": ["[REDACTED:pattern]", "ok"] },
                "input_tokens": 5,
                "nul": null,
                "password": null,
            })
        );
    }

    /// The canaries of `vectors.json` (generated from the same `redaction.json` by the TypeScript package): the Rust
    /// redactor masks every one of them, in any detail field, and leaves the non-matches alone.
    #[test]
    fn the_shared_canaries_are_masked_and_the_non_matches_are_not() {
        let v = vectors();
        let canaries = v["redactionCanaries"].as_array().unwrap();
        assert!(!canaries.is_empty());
        for c in canaries {
            if c["rule"] == "pii" {
                continue;
            }
            let text = parts(&c["parts"]);
            let secret = parts(&c["matches"]);
            let out = redact_text(&text).unwrap();
            assert!(!out.contains(&secret), "{} survives: {out}", c["pattern"]);
            assert!(
                out.contains("[REDACTED:"),
                "{} leaves no marker",
                c["pattern"]
            );
            let nested = redact_detail(&json!({ "reason": text, "list": [text] })).unwrap();
            assert!(
                !nested.to_string().contains(&secret),
                "{} survives in a detail",
                c["pattern"]
            );
        }
        for n in v["redactionNonMatches"].as_array().unwrap() {
            let text = n["text"].as_str().unwrap();
            assert_eq!(redact_text(text).unwrap(), text, "{}", n["note"]);
        }
    }

    #[test]
    fn key_names_follow_the_shared_list() {
        let v = vectors();
        for n in strings(&v["keyNames"]["redact"]) {
            let got = redact_detail(&json!({ n.clone(): "plain-value" })).unwrap();
            assert_eq!(got[n.as_str()], "[REDACTED:key]", "{n}");
        }
        for n in strings(&v["keyNames"]["keep"]) {
            let got = redact_detail(&json!({ n.clone(): "plain-value" })).unwrap();
            assert_eq!(got[n.as_str()], "plain-value", "{n}");
        }
    }

    #[test]
    fn ordinary_details_come_back_byte_identical() {
        let detail = json!({
            "target": "linux-x64", "channel": "stable", "core": "bundled", "profile": "standard",
            "id": "demo/demo-skill", "version": "1.0.0", "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "keyId": null, "acknowledged": ["unsigned"], "replaced": false, "via": "offline",
            "moved": ["data/ext/fixture", "modules.fixture"], "message": "ünï ✓ 😀 a\nb",
            "from": "0.1.0", "to": "0.2.0", "n": 3,
        });
        let got = redact_detail(&detail).unwrap();
        assert_eq!(got, detail);
        assert_eq!(got.to_string(), detail.to_string());
    }

    #[test]
    fn nesting_beyond_the_bound_is_replaced_not_passed_on() {
        let mut v = json!("Bearer abcdef123456");
        for _ in 0..(MAX_DEPTH + 5) {
            v = json!([v]);
        }
        let got = redact_detail(&v).unwrap().to_string();
        assert!(!got.contains("abcdef123456"));
        assert!(got.contains("[TRUNCATED:depth]"));
    }
}
