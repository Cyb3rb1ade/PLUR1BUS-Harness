use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CallerIdentity {
    pub channel: &'static str,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "userId")]
    pub user_id: String,
}

/// hostname + OS user: the CLI principal (spec §6.2). The core hashes these; the CLI never does.
pub fn caller() -> CallerIdentity {
    let host = gethostname::gethostname().to_string_lossy().to_string();
    let user = whoami::username();
    CallerIdentity {
        channel: "cli",
        account_id: if host.is_empty() {
            "localhost".into()
        } else {
            host
        },
        user_id: if user.is_empty() { "user".into() } else { user },
    }
}
