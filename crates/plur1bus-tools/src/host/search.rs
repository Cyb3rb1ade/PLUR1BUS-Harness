/// Search already verified text with a case-sensitive literal.
pub fn matches(text: &str, query: &str) -> bool {
    text.contains(query)
}
