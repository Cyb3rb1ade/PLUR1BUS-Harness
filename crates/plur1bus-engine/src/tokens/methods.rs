//! Raw tokenizer encoding and the existing UTF-16 estimator; no provider templates or calibration.

use super::{TokenBounds, TokenError};
use tokenizers::Tokenizer;

pub(super) fn count_text(
    tokenizer: Option<&Tokenizer>,
    text: &str,
) -> Result<TokenBounds, TokenError> {
    match tokenizer {
        Some(tokenizer) => {
            let count = tokenizer
                .encode(text, false)
                .map_err(|error| TokenError::Encoding(error.to_string()))?
                .len() as u64;
            Ok(TokenBounds {
                tokens: count,
                lower: count,
                upper: count,
            })
        }
        None => Ok(TokenBounds {
            tokens: (text.encode_utf16().count() as u64).div_ceil(4),
            lower: 0,
            upper: text.len() as u64,
        }),
    }
}

pub(super) fn add(total: &mut TokenBounds, count: TokenBounds) -> Result<(), TokenError> {
    total.tokens = total
        .tokens
        .checked_add(count.tokens)
        .ok_or(TokenError::Overflow)?;
    total.lower = total
        .lower
        .checked_add(count.lower)
        .ok_or(TokenError::Overflow)?;
    total.upper = total
        .upper
        .checked_add(count.upper)
        .ok_or(TokenError::Overflow)?;
    Ok(())
}

pub(super) fn visible_template_bounds(mut count: TokenBounds, text: &str) -> TokenBounds {
    // A tokenizer-text result covers visible serialization only (RE-D26), never hidden provider framing.
    count.lower = 0;
    count.upper = count.upper.max(text.len() as u64);
    count
}
