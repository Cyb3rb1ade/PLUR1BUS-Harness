//! F3/RE-D17: external text omits only unpaired UTF-16 units from Node budget cuts.
//! Pure Node projections remain lossless for reference and hash/ID computation.
use crate::text::js::JsString;
pub(super) fn external(value: &JsString) -> String {
    char::decode_utf16(value.as_utf16_units().iter().copied())
        .filter_map(Result::ok)
        .collect()
}
