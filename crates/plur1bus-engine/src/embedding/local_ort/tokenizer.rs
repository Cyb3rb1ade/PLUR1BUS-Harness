//! Tokenization with Transformers.js-compatible post-encoding truncation and padding.
//!
//! The caller verifies the complete artifact profile before loading these files. Existing
//! tokenizer JSON truncation and padding are disabled: Node encodes the entire input pair,
//! including its special tokens, then cuts the arrays and pads them to the longest row.

use std::fs;
use std::path::Path;

use crate::embedding::artifacts::Artifact;
use serde_json::Value;
use tokenizers::{Encoding, Tokenizer};

use super::LocalModelError;

/// Row-major int64 model inputs after special-token insertion, cutting, and padding.
#[derive(Clone, Debug)]
pub struct EncodedBatch {
    /// Flattened token IDs, with shape `[batch, sequence]`.
    pub input_ids: Vec<i64>,
    /// One for encoded tokens and zero for padding, with the same shape.
    pub attention_mask: Vec<i64>,
    /// Segment IDs from the tokenizer postprocessor; padding always has segment zero.
    pub token_type_ids: Vec<i64>,
    /// Number of rows.
    pub batch: usize,
    /// Number of columns after truncation and padding to the longest row.
    pub sequence: usize,
}

/// A locally loaded tokenizer whose files were verified by artifact resolution first.
pub struct ModelTokenizer {
    tokenizer: Tokenizer,
    maximum: Option<usize>,
    pad_id: i64,
    pad_left: bool,
}

fn metadata(directory: &Path, name: &str) -> Result<Value, LocalModelError> {
    let bytes = fs::read(directory.join(name)).map_err(|_| LocalModelError::InvalidTokenizer)?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| LocalModelError::InvalidTokenizer)?;
    if !value.is_object() {
        return Err(LocalModelError::InvalidTokenizer);
    }
    Ok(value)
}

fn special_token<'a>(metadata: &'a Value, name: &str) -> Result<Option<&'a str>, LocalModelError> {
    match metadata.get(name) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(None),
        Some(Value::String(value)) => Ok((!value.is_empty()).then_some(value.as_str())),
        Some(Value::Object(value))
            if value.get("__type").and_then(Value::as_str) == Some("AddedToken") =>
        {
            value
                .get("content")
                .and_then(Value::as_str)
                .map(Some)
                .ok_or(LocalModelError::InvalidTokenizer)
        }
        _ => Err(LocalModelError::InvalidTokenizer),
    }
}

fn model_maximum(metadata: &Value) -> Result<Option<usize>, LocalModelError> {
    let Some(value) = metadata
        .get("model_max_length")
        .filter(|value| !value.is_null())
    else {
        return Ok(None);
    };
    let number = value.as_f64().ok_or(LocalModelError::InvalidTokenizer)?;
    if !number.is_finite() || number < 1.0 || number.fract() != 0.0 {
        return Err(LocalModelError::InvalidTokenizer);
    }
    // Hugging Face represents an unbounded length with a very large integer sentinel.
    if number >= usize::MAX as f64 {
        return Ok(None);
    }
    Ok(Some(number as usize))
}

impl ModelTokenizer {
    /// Load only files in an already SHA-verified model revision directory.
    /// E5 and classifiers use the tokenizer's model length; specialized embedding
    /// runtimes additionally apply the configured token cap (512 by default).
    pub fn from_artifact(
        profile: &Artifact,
        directory: &Path,
        configured_cap: Option<usize>,
    ) -> Result<Self, LocalModelError> {
        let _model_config = metadata(directory, "config.json")?;
        let config = metadata(directory, "tokenizer_config.json")?;
        let mut tokenizer = Tokenizer::from_file(directory.join("tokenizer.json"))
            .map_err(|_| LocalModelError::InvalidTokenizer)?;
        tokenizer
            .with_truncation(None)
            .map_err(|_| LocalModelError::InvalidTokenizer)?;
        tokenizer.with_padding(None);
        let maximum = model_maximum(&config)?;
        let capped_runtime = profile.role == "embedding"
            && matches!(
                profile.runtime.as_deref(),
                Some("jina-v3" | "jina-v5" | "embeddinggemma-2")
            );
        let maximum = if capped_runtime {
            let cap = configured_cap.unwrap_or(512);
            if !(32..=8192).contains(&cap) {
                return Err(LocalModelError::InvalidConfig);
            }
            Some(maximum.map_or(cap, |maximum| maximum.min(cap)))
        } else {
            maximum
        };
        let token = special_token(&config, "pad_token")?
            .or(special_token(&config, "eos_token")?)
            .ok_or(LocalModelError::InvalidTokenizer)?;
        let pad_id = tokenizer
            .token_to_id(token)
            .ok_or(LocalModelError::InvalidTokenizer)?;
        let default_left = config
            .get("tokenizer_class")
            .and_then(Value::as_str)
            .is_some_and(|class| matches!(class, "LlamaTokenizer" | "LlamaTokenizerFast"));
        let pad_left = match config.get("padding_side").filter(|value| !value.is_null()) {
            None => default_left,
            Some(Value::String(side)) => side != "right",
            _ => return Err(LocalModelError::InvalidTokenizer),
        };
        Ok(Self {
            tokenizer,
            maximum,
            pad_id: i64::from(pad_id),
            pad_left,
        })
    }

    fn encode(&self, text: &str, pair: Option<&str>) -> Result<Encoding, LocalModelError> {
        // No tokenizer truncation strategy is used: LongestFirst would remove tokens
        // from the query and retain the closing separator, unlike Transformers.js.
        // Transformers.js treats an empty `text_pair` as absent: an empty document is encoded as the query alone.
        match pair.filter(|pair| !pair.is_empty()) {
            Some(pair) => self.tokenizer.encode((text, pair), true),
            None => self.tokenizer.encode(text, true),
        }
        .map_err(|_| LocalModelError::InvalidTokenizer)
    }

    /// Encode complete sequences, cut each tensor, then pad to the longest retained row.
    pub fn encode_batch(
        &self,
        texts: &[String],
        pairs: Option<&[String]>,
    ) -> Result<EncodedBatch, LocalModelError> {
        if texts.is_empty() || pairs.is_some_and(|pairs| pairs.len() != texts.len()) {
            return Err(LocalModelError::InvalidTensor);
        }
        // Iterate sequentially rather than creating a tokenizer-owned Rayon pool.
        let encodings = texts
            .iter()
            .enumerate()
            .map(|(index, text)| self.encode(text, pairs.map(|pairs| pairs[index].as_str())))
            .collect::<Result<Vec<_>, _>>()?;
        let sequence = encodings
            .iter()
            .map(|encoding| encoding.get_ids().len())
            .max()
            .ok_or(LocalModelError::InvalidTensor)?;
        let sequence = self.maximum.map_or(sequence, |cap| sequence.min(cap));
        let elements = texts
            .len()
            .checked_mul(sequence)
            .ok_or(LocalModelError::InvalidTensor)?;
        if sequence == 0 {
            return Err(LocalModelError::InvalidTensor);
        }
        let mut output = EncodedBatch {
            input_ids: Vec::with_capacity(elements),
            attention_mask: Vec::with_capacity(elements),
            token_type_ids: Vec::with_capacity(elements),
            batch: texts.len(),
            sequence,
        };
        for encoding in encodings {
            let retained = encoding.get_ids().len().min(sequence);
            if encoding.get_attention_mask().len() != encoding.get_ids().len()
                || encoding.get_type_ids().len() != encoding.get_ids().len()
            {
                return Err(LocalModelError::InvalidTensor);
            }
            let padding = sequence - retained;
            if self.pad_left {
                self.pad(&mut output, padding);
            }
            output.input_ids.extend(
                encoding.get_ids()[..retained]
                    .iter()
                    .copied()
                    .map(i64::from),
            );
            output.attention_mask.extend(
                encoding.get_attention_mask()[..retained]
                    .iter()
                    .copied()
                    .map(i64::from),
            );
            output.token_type_ids.extend(
                encoding.get_type_ids()[..retained]
                    .iter()
                    .copied()
                    .map(i64::from),
            );
            if !self.pad_left {
                self.pad(&mut output, padding);
            }
        }
        Ok(output)
    }

    fn pad(&self, output: &mut EncodedBatch, length: usize) {
        output
            .input_ids
            .extend(std::iter::repeat_n(self.pad_id, length));
        output.attention_mask.extend(std::iter::repeat_n(0, length));
        output.token_type_ids.extend(std::iter::repeat_n(0, length));
    }

    /// Encode one complete sequence or pair and cut token IDs without adding padding.
    pub fn encode_ids(&self, text: &str, pair: Option<&str>) -> Result<Vec<u32>, LocalModelError> {
        let encoding = self.encode(text, pair)?;
        let retained = self.maximum.map_or(encoding.get_ids().len(), |cap| {
            cap.min(encoding.get_ids().len())
        });
        Ok(encoding.get_ids()[..retained].to_vec())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::embedding::artifacts::pinned_profile;
    use serde_json::json;
    use std::fs;

    // This tiny vocabulary and its special-token template are generated by the tests.
    // They contain no model-derived tokens or third-party weights.
    fn fixture(maximum: usize, side: &str) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        let special = |id: &str| json!({"SpecialToken":{"id":id,"type_id":0}});
        let sequence = |id: &str, kind| json!({"Sequence":{"id":id,"type_id":kind}});
        let tokenizer = json!({
            "version":"1.0", "truncation":{"direction":"Right","max_length":2,"strategy":"LongestFirst","stride":0},
            "padding":{"strategy":{"Fixed":10},"direction":"Right","pad_to_multiple_of":null,"pad_id":0,"pad_type_id":0,"pad_token":"[PAD]"},
            "added_tokens":[], "normalizer":null, "pre_tokenizer":{"type":"Whitespace"},
            "post_processor":{"type":"TemplateProcessing",
                "single":[special("[CLS]"),sequence("A",0),special("[SEP]")],
                "pair":[special("[CLS]"),sequence("A",0),special("[SEP]"),sequence("B",1),{"SpecialToken":{"id":"[SEP]","type_id":1}}],
                "special_tokens":{"[CLS]":{"id":"[CLS]","ids":[2],"tokens":["[CLS]"]},"[SEP]":{"id":"[SEP]","ids":[3],"tokens":["[SEP]"]}}},
            "decoder":null, "model":{"type":"WordLevel","vocab":{"[PAD]":0,"[UNK]":1,"[CLS]":2,"[SEP]":3,"a":4,"b":5,"c":6,"d":7,"e":8},"unk_token":"[UNK]"}
        });
        fs::write(
            directory.path().join("tokenizer.json"),
            serde_json::to_vec(&tokenizer).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.path().join("config.json"),
            b"{\"model_type\":\"bert\",\"pad_token_id\":0}",
        )
        .unwrap();
        fs::write(directory.path().join("tokenizer_config.json"), serde_json::to_vec(&json!({
            "model_max_length":maximum,"padding_side":side,"pad_token":{"__type":"AddedToken","content":"[PAD]"},"eos_token":"[SEP]","tokenizer_class":"BertTokenizer"
        })).unwrap()).unwrap();
        directory
    }
    fn e5(directory: &Path, cap: Option<usize>) -> ModelTokenizer {
        ModelTokenizer::from_artifact(
            pinned_profile("intfloat/multilingual-e5-small", None).unwrap(),
            directory,
            cap,
        )
        .unwrap()
    }
    fn words(count: usize) -> String {
        std::iter::repeat_n("a", count)
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn truncation_cuts_the_fully_encoded_sequence_and_loses_the_closing_special_token() {
        let directory = fixture(4, "right");
        let tokenizer = e5(directory.path(), Some(32));
        assert_eq!(
            tokenizer.encode_ids("a b c d e", None).unwrap(),
            [2, 4, 5, 6]
        );
    }
    #[test]
    fn an_empty_document_is_encoded_as_the_query_alone_like_transformers_js() {
        let directory = fixture(16, "right");
        let tokenizer = e5(directory.path(), Some(16));
        assert_eq!(
            tokenizer.encode_ids("a b", Some("")).unwrap(),
            tokenizer.encode_ids("a b", None).unwrap()
        );
        assert_eq!(tokenizer.encode_ids("a b", Some("")).unwrap(), [2, 4, 5, 3]);
        assert_eq!(
            tokenizer.encode_ids("a", Some("c")).unwrap(),
            [2, 4, 3, 6, 3]
        );
    }
    #[test]
    fn pair_truncation_keeps_the_front_of_the_complete_pair_and_its_segment_ids() {
        let directory = fixture(6, "right");
        let tokenizer = e5(directory.path(), None);
        let encoded = tokenizer
            .encode_batch(
                &["a b".into(), "a".into()],
                Some(&["c d e".into(), "c".into()]),
            )
            .unwrap();
        assert_eq!((encoded.batch, encoded.sequence), (2, 6));
        assert_eq!(encoded.input_ids, [2, 4, 5, 3, 6, 7, 2, 4, 3, 6, 3, 0]);
        assert_eq!(encoded.attention_mask, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
        assert_eq!(encoded.token_type_ids, [0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0]);
    }
    #[test]
    fn left_padding_uses_zero_mask_and_segment_ids_and_the_declared_pad_token() {
        let directory = fixture(8, "left");
        let tokenizer = e5(directory.path(), None);
        let encoded = tokenizer
            .encode_batch(&["a b c".into(), "a".into()], None)
            .unwrap();
        assert_eq!((encoded.batch, encoded.sequence), (2, 5));
        assert_eq!(encoded.input_ids, [2, 4, 5, 6, 3, 0, 0, 2, 4, 3]);
        assert_eq!(encoded.attention_mask, [1, 1, 1, 1, 1, 0, 0, 1, 1, 1]);
        assert_eq!(encoded.token_type_ids, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
    #[test]
    fn pad_token_falls_back_to_the_tokenizer_eos_token() {
        let directory = fixture(8, "right");
        fs::write(
            directory.path().join("tokenizer_config.json"),
            b"{\"model_max_length\":8,\"eos_token\":\"[SEP]\"}",
        )
        .unwrap();
        let encoded = e5(directory.path(), None)
            .encode_batch(&["a b".into(), "a".into()], None)
            .unwrap();
        assert_eq!(encoded.input_ids, [2, 4, 5, 3, 2, 4, 3, 3]);
        assert_eq!(encoded.attention_mask, [1, 1, 1, 1, 1, 1, 1, 0]);
    }
    #[test]
    fn e5_and_rerankers_use_model_length_while_special_embedding_runtimes_use_the_configured_cap() {
        let directory = fixture(1024, "right");
        assert_eq!(
            e5(directory.path(), Some(32))
                .encode_ids(&words(1100), None)
                .unwrap()
                .len(),
            1024
        );
        let reranker = ModelTokenizer::from_artifact(
            pinned_profile("woxpas-ai/bge-reranker-v2-m3-onnx", None).unwrap(),
            directory.path(),
            Some(32),
        )
        .unwrap();
        assert_eq!(reranker.encode_ids(&words(1100), None).unwrap().len(), 1024);
        for model in [
            "google/embeddinggemma-2",
            "jinaai/jina-embeddings-v3",
            "jinaai/jina-embeddings-v5-text-nano-retrieval",
        ] {
            let profile = pinned_profile(model, None).unwrap();
            let tokenizer = ModelTokenizer::from_artifact(profile, directory.path(), None).unwrap();
            assert_eq!(tokenizer.encode_ids(&words(600), None).unwrap().len(), 512);
            let tokenizer =
                ModelTokenizer::from_artifact(profile, directory.path(), Some(64)).unwrap();
            assert_eq!(tokenizer.encode_ids(&words(600), None).unwrap().len(), 64);
        }
        let short = fixture(40, "right");
        let gemma = ModelTokenizer::from_artifact(
            pinned_profile("google/embeddinggemma-2", None).unwrap(),
            short.path(),
            Some(64),
        )
        .unwrap();
        assert_eq!(gemma.encode_ids(&words(100), None).unwrap().len(), 40);
    }
    #[test]
    fn invalid_batch_shapes_and_malformed_tokenizer_metadata_are_refused() {
        let directory = fixture(8, "right");
        fs::write(directory.path().join("tokenizer_config.json"), b"not JSON").unwrap();
        assert!(matches!(
            ModelTokenizer::from_artifact(
                pinned_profile("intfloat/multilingual-e5-small", None).unwrap(),
                directory.path(),
                None
            ),
            Err(LocalModelError::InvalidTokenizer)
        ));
        let directory = fixture(8, "right");
        let tokenizer = e5(directory.path(), None);
        assert!(matches!(
            tokenizer.encode_batch(&[], None),
            Err(LocalModelError::InvalidTensor)
        ));
        assert!(matches!(
            tokenizer.encode_batch(&["a".into()], Some(&[])),
            Err(LocalModelError::InvalidTensor)
        ));
    }
}
