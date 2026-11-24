//! Optional offline comparison over locally materialized public corpora.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "offline quality fixture failures are fatal"
)]
use arrow_array::{
    types::Float32Type, ArrayRef, FixedSizeListArray, RecordBatch, RecordBatchIterator, StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use futures::{StreamExt, TryStreamExt};
use lancedb::{
    index::{
        scalar::{FtsIndexBuilder, FullTextSearchQuery},
        Index,
    },
    query::{ExecutableQuery, QueryBase, Select},
};
use plur1bus_engine::text::analyzer::{analyze_de, analyze_en, analyze_ngrams};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::Path, sync::Arc, time::Duration};

#[derive(Deserialize)]
struct Case {
    cards: Vec<Card>,
    queries: Vec<Labeled>,
}
#[derive(Deserialize)]
struct Card {
    id: String,
    text: String,
    summary: String,
}
#[derive(Deserialize)]
struct Labeled {
    id: String,
    text: String,
    expected: Vec<String>,
}
#[derive(Serialize)]
struct Report {
    dataset: String,
    profile: &'static str,
    summary: &'static str,
    corpus_size: usize,
    positive_queries: usize,
    lexical_index_bytes: u64,
    mrr_at_10: f64,
    macro_recall_at_10: f64,
    hybrid_mrr_at_10: Option<f64>,
    hybrid_macro_recall_at_10: Option<f64>,
    hit_at_1: f64,
    hybrid_hit_at_1: Option<f64>,
    vector_mrr_at_10: Option<f64>,
    vector_macro_recall_at_10: Option<f64>,
}

#[derive(Clone, Copy)]
enum Profile {
    Fallback,
    Analyzer,
    Compound,
}
impl Profile {
    fn name(self) -> &'static str {
        match self {
            Self::Fallback => "fallback",
            Self::Analyzer => "analyzer",
            Self::Compound => "analyzer-ng",
        }
    }
    fn columns(self) -> &'static [&'static str] {
        match self {
            Self::Fallback => &["de"],
            Self::Analyzer => &["de", "en"],
            Self::Compound => &["de", "en", "ng"],
        }
    }
    fn fields(self, text: &str) -> Vec<String> {
        match self {
            Self::Fallback => vec![text.to_owned()],
            Self::Analyzer => vec![analyze_de(text).join(" "), analyze_en(text).join(" ")],
            Self::Compound => vec![
                analyze_de(text).join(" "),
                analyze_en(text).join(" "),
                analyze_ngrams(text).join(" "),
            ],
        }
    }
    fn index(self) -> FtsIndexBuilder {
        let fallback = matches!(self, Self::Fallback);
        FtsIndexBuilder::default()
            .base_tokenizer(if fallback { "simple" } else { "whitespace" }.into())
            .lower_case(fallback)
            .ascii_folding(fallback)
            .stem(false)
            .remove_stop_words(false)
            .max_token_length(fallback.then_some(128))
            .with_position(fallback)
    }
}
async fn measure(
    path: &Path,
    dataset: &str,
    case: &Case,
    profile: Profile,
    separate_summary: bool,
    vectors: Option<&Vectors>,
) -> Report {
    let db = lancedb::connect(path.to_str().unwrap())
        .read_consistency_interval(Duration::ZERO)
        .execute()
        .await
        .unwrap();
    let mut fields = vec![Field::new("id", DataType::Utf8, false)];
    let mut column_names: Vec<_> = profile.columns().iter().map(|n| (*n).to_owned()).collect();
    if separate_summary {
        column_names.extend(profile.columns().iter().map(|n| format!("summary_{n}")));
    }
    fields.extend(
        column_names
            .iter()
            .map(|n| Field::new(n, DataType::Utf8, false)),
    );
    if vectors.is_some() {
        fields.push(Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), 384),
            false,
        ));
    }
    let schema = Arc::new(Schema::new(fields));
    let mut columns = vec![Vec::with_capacity(case.cards.len()); 1 + column_names.len()];
    for card in &case.cards {
        columns[0].push(card.id.clone());
        let analyzed = if separate_summary {
            profile
                .fields(&card.text)
                .into_iter()
                .chain(profile.fields(&card.summary))
                .collect()
        } else {
            profile.fields(&format!("{} {}", card.text, card.summary))
        };
        for (column, value) in columns[1..].iter_mut().zip(analyzed) {
            column.push(value);
        }
    }
    let mut arrays: Vec<ArrayRef> = columns
        .into_iter()
        .map(|c| Arc::new(StringArray::from(c)) as _)
        .collect();
    if let Some(vectors) = vectors {
        arrays.push(Arc::new(FixedSizeListArray::from_iter_primitive::<
            Float32Type,
            _,
            _,
        >(
            vectors
                .cards
                .iter()
                .map(|v| Some(v.iter().copied().map(Some))),
            384,
        )));
    }
    let input = RecordBatch::try_new(schema.clone(), arrays).unwrap();
    let batches = RecordBatchIterator::new([Ok(input)], schema);
    let table = db
        .create_table("corpus", Box::new(batches))
        .execute()
        .await
        .unwrap();
    for field in &column_names {
        table
            .create_index(
                &[field.as_str()],
                Index::FTS(profile.index().with_position(
                    matches!(profile, Profile::Fallback) && !field.starts_with("summary_"),
                )),
            )
            .execute()
            .await
            .unwrap();
    }
    let lexical_index_bytes = directory_bytes(&path.join("corpus.lance/_indices")).unwrap();
    assert!(lexical_index_bytes > 0);
    let scores = futures::stream::iter(case.queries.iter().enumerate().map(|(i, q)| {
        let table = &table;
        let column_names = &column_names;
        async move {
            let terms = profile.fields(&q.text).join(" ");
            let mut lexical = Vec::new();
            if !terms.trim().is_empty() {
                let query = FullTextSearchQuery::new(terms)
                    .with_columns(column_names)
                    .unwrap();
                let stream = table
                    .query()
                    .select(Select::columns(&["id"]))
                    .full_text_search(query)
                    .limit(40)
                    .execute()
                    .await
                    .unwrap_or_else(|error| panic!("{}: {error}", q.id));
                lexical = extract_ids(&stream.try_collect::<Vec<_>>().await.unwrap());
            }
            let expected: HashSet<_> = q.expected.iter().map(String::as_str).collect();
            let references: Vec<_> = lexical.iter().map(String::as_str).collect();
            let score = score_at_10(&references, &expected);
            let Some(vectors) = vectors else {
                return (score, (0., 0., 0.), (0., 0., 0.));
            };
            let stream = table
                .vector_search(vectors.queries[i].clone())
                .unwrap()
                .select(Select::columns(&["id"]))
                .limit(40)
                .execute()
                .await
                .unwrap();
            let vector = extract_ids(&stream.try_collect::<Vec<_>>().await.unwrap());
            let vector: Vec<_> = vector.iter().map(String::as_str).collect();
            let hybrid = plur1bus_engine::recall::fusion::rrf(&[&references, &vector]);
            (
                score,
                score_at_10(&hybrid, &expected),
                score_at_10(&vector, &expected),
            )
        }
    }))
    .buffered(4)
    .collect::<Vec<_>>()
    .await;
    let mut totals = [[0.0; 3]; 3];
    for (lexical, hybrid, vector) in scores {
        for (sum, (rr, recall, hit)) in totals.iter_mut().zip([lexical, hybrid, vector]) {
            sum[0] += rr;
            sum[1] += recall;
            sum[2] += hit;
        }
    }
    let n = case.queries.len();
    Report {
        dataset: dataset.into(),
        profile: profile.name(),
        summary: if separate_summary {
            "separate"
        } else {
            "joined"
        },
        corpus_size: case.cards.len(),
        positive_queries: n,
        lexical_index_bytes,
        mrr_at_10: totals[0][0] / n as f64,
        macro_recall_at_10: totals[0][1] / n as f64,
        hit_at_1: totals[0][2] / n as f64,
        hybrid_mrr_at_10: vectors.map(|_| totals[1][0] / n as f64),
        hybrid_macro_recall_at_10: vectors.map(|_| totals[1][1] / n as f64),
        hybrid_hit_at_1: vectors.map(|_| totals[1][2] / n as f64),
        vector_mrr_at_10: vectors.map(|_| totals[2][0] / n as f64),
        vector_macro_recall_at_10: vectors.map(|_| totals[2][1] / n as f64),
    }
}

fn directory_bytes(path: &Path) -> std::io::Result<u64> {
    fs::read_dir(path)?.try_fold(0, |total, entry| {
        let entry = entry?;
        let metadata = entry.metadata()?;
        let bytes = if metadata.is_dir() {
            directory_bytes(&entry.path())?
        } else {
            metadata.len()
        };
        Ok(total + bytes)
    })
}

fn extract_ids(batches: &[RecordBatch]) -> Vec<String> {
    batches
        .iter()
        .flat_map(|batch| {
            batch
                .column_by_name("id")
                .unwrap()
                .as_any()
                .downcast_ref::<StringArray>()
                .unwrap()
                .iter()
                .flatten()
                .map(str::to_owned)
        })
        .collect()
}

fn score_at_10(ordered: &[&str], expected: &HashSet<&str>) -> (f64, f64, f64) {
    let rank = ordered.iter().take(10).position(|id| expected.contains(id));
    let relevant = ordered
        .iter()
        .take(10)
        .filter(|id| expected.contains(**id))
        .count();
    (
        rank.map_or(0., |i| 1.0 / (i + 1) as f64),
        relevant as f64 / expected.len() as f64,
        if rank == Some(0) { 1.0 } else { 0.0 },
    )
}

#[derive(Deserialize, Serialize)]
struct Vectors {
    cards: Vec<Vec<f32>>,
    queries: Vec<Vec<f32>>,
}

#[cfg(feature = "real-models")]
fn embed(case: &Case, input: &Path, name: &str) -> Option<Vectors> {
    use plur1bus_engine::embedding::{
        local_ort, normalize::normalize_embedding_config, Cancel, EmbedKind,
    };
    use sha2::{Digest, Sha256};
    let cache = std::path::PathBuf::from(std::env::var_os("PLUR1BUS_MODELS_CACHE")?);
    let runtime = std::path::PathBuf::from(std::env::var_os("ORT_DYLIB_PATH").unwrap());
    local_ort::initialize_runtime(&runtime).unwrap();
    let input_hash = format!(
        "{:x}",
        Sha256::digest(fs::read(input.join(format!("{name}.json"))).unwrap())
    );
    let vectors_file = input.join(format!("{name}-e5-fp32-{input_hash}.json"));
    if let Some(vectors) = fs::read(&vectors_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vectors>(&bytes).ok())
        .filter(|vectors| {
            vectors.cards.len() == case.cards.len()
                && vectors.queries.len() == case.queries.len()
                && vectors
                    .cards
                    .iter()
                    .chain(&vectors.queries)
                    .all(|row| row.len() == 384 && row.iter().all(|value| value.is_finite()))
        })
    {
        return Some(vectors);
    }
    let config = normalize_embedding_config(&serde_json::json!({"provider":"local-transformers",
        "local":{"model":"intfloat/multilingual-e5-small","dimensions":384,"cacheDir":cache}}))
    .unwrap();
    let provider = local_ort::build_local_embedding(&config, &cache, false).unwrap();
    let cards = case
        .cards
        .iter()
        .map(|row| row.text.clone())
        .collect::<Vec<_>>();
    let queries = case
        .queries
        .iter()
        .map(|row| row.text.clone())
        .collect::<Vec<_>>();
    let embed = |texts: &[String], kind| {
        texts
            .chunks(16)
            .flat_map(|batch| provider.embed(batch, kind, &Cancel::never()).unwrap())
            .collect()
    };
    let vectors = Vectors {
        cards: embed(&cards, EmbedKind::Passage),
        queries: embed(&queries, EmbedKind::Query),
    };
    plur1bus_engine::store::atomic_write::atomic_write(
        &vectors_file,
        &serde_json::to_vec(&vectors).unwrap(),
    )
    .unwrap();
    Some(vectors)
}

#[test]
#[ignore = "reads pinned public corpora from LEXICAL_QUALITY_DIR"]
fn lexical_bakeoff() {
    let input = std::path::PathBuf::from(std::env::var_os("LEXICAL_QUALITY_DIR").unwrap());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    let mut reports = Vec::new();
    let requested = std::env::var("LEXICAL_QUALITY_CORPORA").ok();
    let all = "identifiers,de-compounds,de-separated,de,de-with-distractors,en-qasper";
    for name in requested.as_deref().unwrap_or(all).split(',') {
        assert!(
            all.split(',').any(|allowed| allowed == name),
            "unknown corpus {name}"
        );
        let case =
            serde_json::from_slice::<Case>(&fs::read(input.join(format!("{name}.json"))).unwrap())
                .unwrap();
        #[cfg(feature = "real-models")]
        let vectors = embed(&case, &input, name);
        #[cfg(not(feature = "real-models"))]
        let vectors: Option<Vectors> = None;
        for (profile, separate) in [
            (Profile::Fallback, true),
            (Profile::Analyzer, false),
            (Profile::Analyzer, true),
            (Profile::Compound, false),
        ] {
            let tmp = tempfile::tempdir_in(input.clone()).unwrap();
            let report = runtime.block_on(measure(
                tmp.path(),
                name,
                &case,
                profile,
                separate,
                vectors.as_ref(),
            ));
            reports.push(report);
            plur1bus_engine::store::atomic_write::atomic_write(
                &input.join(if vectors.is_some() {
                    "hybrid-e5-results.json"
                } else {
                    "lexical-pilot-results.json"
                }),
                &serde_json::to_vec_pretty(&reports).unwrap(),
            )
            .unwrap();
        }
    }
}
