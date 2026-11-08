//! RE-D17/F3: visible output never exposes an unpaired UTF-16 code unit.
//!
//! Keep Node's lossless values for identity/hash material. At the presentation
//! boundary a pair split by a budget loses the dangling unit, not U+FFFD.

use crate::text::js::JsString;

pub(super) fn well_formed(value: JsString) -> JsString {
    let text: String = char::decode_utf16(value.into_utf16_units())
        .filter_map(Result::ok)
        .collect();
    JsString::from(text)
}
