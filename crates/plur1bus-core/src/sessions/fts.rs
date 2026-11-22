//! `ftsQuery` of `session/store.ts`: free text to an FTS5 `MATCH` string that cannot be a syntax error or an operator
//! injection. Every whitespace-separated token (`/\s+/`, JavaScript's white space) becomes a double-quoted string with its
//! own quotes doubled, all of them required (FTS5's implicit AND).
use super::SessionError;
use crate::js::is_js_space;

/// `ftsQuery(text)`. An empty or all-white-space text is `invalid` / `search-empty`.
pub fn fts_query(text: &str) -> Result<String, SessionError> {
    let tokens: Vec<String> = text
        .split(is_js_space)
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        return Err(SessionError::invalid(
            "search text is empty",
            "search-empty",
        ));
    }
    Ok(tokens.join(" "))
}
