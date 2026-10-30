//! Shared CPU ONNX sessions; inference results own their buffers before the session lock is released.

use super::{tokenizer::EncodedBatch, LocalModelError, MediaInputs, MEDIA_FEATURE_WIDTH};
use crate::contract::Cancel;
use crate::embedding::artifacts::Artifact;
use ort::environment::{Environment, GlobalThreadPoolOptions};
use ort::session::{builder::GraphOptimizationLevel, RunOptions, Session};
use ort::value::{DynValue, Tensor, TensorElementType, ValueType};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::Duration;

pub(super) type InferenceOutputs = BTreeMap<String, (Vec<usize>, Vec<f32>)>;
type SessionKey = (String, PathBuf);
struct CachedSession {
    key: SessionKey,
    session: Session,
}
type SessionSlot = Option<CachedSession>;
static ENVIRONMENT: OnceLock<Environment> = OnceLock::new();
static INITIALIZE: Mutex<()> = Mutex::new(());
static SESSION: Mutex<SessionSlot> = Mutex::new(None);

/// Initialize the one process-wide CPU environment from an explicit host-owned library path.
/// The first successful initialization remains alive for the process; no process environment is changed.
pub(crate) fn initialize(path: &Path) -> Result<(), LocalModelError> {
    if ENVIRONMENT.get().is_some() {
        return Ok(());
    }
    let _initializing = INITIALIZE
        .lock()
        .map_err(|_| LocalModelError::RuntimeFailed)?;
    if ENVIRONMENT.get().is_some() {
        return Ok(());
    }
    let builder = ort::init_from(path).map_err(|_| LocalModelError::RuntimeUnavailable)?;
    let threads = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let pool = GlobalThreadPoolOptions::default()
        .with_intra_threads(threads)
        .map_err(|_| LocalModelError::RuntimeFailed)?
        .with_inter_threads(1)
        .map_err(|_| LocalModelError::RuntimeFailed)?
        .with_spin_control(false)
        .map_err(|_| LocalModelError::RuntimeFailed)?;
    let environment = builder
        .with_name("plur1bus-engine")
        .with_telemetry(false)
        .with_global_thread_pool(pool)
        .build()
        .map_err(|_| LocalModelError::RuntimeFailed)?;
    ENVIRONMENT
        .set(environment)
        .map_err(|_| LocalModelError::RuntimeFailed)
}

fn environment() -> Result<&'static Environment, LocalModelError> {
    if let Some(environment) = ENVIRONMENT.get() {
        return Ok(environment);
    }
    let path = std::env::var_os("ORT_DYLIB_PATH")
        .filter(|value| !value.is_empty())
        .ok_or(LocalModelError::RuntimeUnavailable)?;
    initialize(Path::new(&path))?;
    ENVIRONMENT.get().ok_or(LocalModelError::RuntimeUnavailable)
}

fn lock_cancel<'a, T>(
    mutex: &'a Mutex<T>,
    cancel: &Cancel,
) -> Result<MutexGuard<'a, T>, LocalModelError> {
    loop {
        cancel.check()?;
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Err(LocalModelError::RuntimeFailed),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
}

fn shared_session(
    profile: &Artifact,
    model_path: &Path,
    cancel: &Cancel,
    load_verifier: impl FnOnce() -> Result<(), LocalModelError>,
) -> Result<MutexGuard<'static, SessionSlot>, LocalModelError> {
    cancel.check()?;
    let path = if model_path.is_absolute() {
        model_path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| LocalModelError::RuntimeFailed)?
            .join(model_path)
    };
    // Include every immutable profile field, not only the model name: dtype and graph bytes define the space too.
    let key = (
        serde_json::to_string(profile).map_err(|_| LocalModelError::InvalidConfig)?,
        path,
    );
    let mut slot = lock_cancel(&SESSION, cancel)?;
    if slot.as_ref().is_some_and(|cached| cached.key == key) {
        return Ok(slot);
    }
    cancel.check()?;
    // Release the previous native session before constructing its replacement, even if loading fails.
    // The same guard stays held until inference outputs have been copied into owned Rust buffers.
    *slot = None;
    cancel.check()?;
    load_verifier()?;
    cancel.check()?;
    let environment = environment()?;
    cancel.check()?;
    let optimization = if matches!(profile.runtime.as_deref(), Some("jina-v3" | "jina-v5")) {
        GraphOptimizationLevel::Disable
    } else {
        GraphOptimizationLevel::All
    };
    let session = Session::builder(environment)
        .map_err(|_| LocalModelError::RuntimeFailed)?
        .with_parallel_execution(false)
        .map_err(|_| LocalModelError::RuntimeFailed)?
        .with_inter_op_spinning(false)
        .map_err(|_| LocalModelError::RuntimeFailed)?
        .with_intra_op_spinning(false)
        .map_err(|_| LocalModelError::RuntimeFailed)?
        .with_optimization_level(optimization)
        .map_err(|_| LocalModelError::RuntimeFailed)?
        .commit_from_file(&key.1)
        .map_err(|_| LocalModelError::RuntimeFailed)?;
    cancel.check()?;
    *slot = Some(CachedSession { key, session });
    Ok(slot)
}

fn expected_tensor(dtype: &ValueType, element: TensorElementType, expected: &[usize]) -> bool {
    matches!(dtype, ValueType::Tensor { ty, shape, .. }
        if *ty == element && shape.len() == expected.len() && shape.iter().zip(expected).all(|(actual, wanted)| *actual == -1 || usize::try_from(*actual).ok() == Some(*wanted)))
}

fn expected_input(dtype: &ValueType, expected: &[usize]) -> bool {
    expected_tensor(dtype, TensorElementType::Int64, expected)
}

fn inputs(
    session: &Session,
    profile: &Artifact,
    batch: &EncodedBatch,
    task_id: Option<i64>,
    media: &MediaInputs,
) -> Result<Vec<(String, DynValue)>, LocalModelError> {
    let count = batch
        .batch
        .checked_mul(batch.sequence)
        .filter(|count| *count > 0)
        .ok_or(LocalModelError::InvalidTensor)?;
    if batch.input_ids.len() != count
        || batch.attention_mask.len() != count
        || batch.token_type_ids.len() != count
    {
        return Err(LocalModelError::InvalidTensor);
    }
    let is_jina_v3 = profile.runtime.as_deref() == Some("jina-v3");
    let has_task = session
        .inputs()
        .iter()
        .any(|input| input.name() == "task_id");
    if has_task != is_jina_v3
        || has_task != task_id.is_some()
        || !["input_ids", "attention_mask"]
            .iter()
            .all(|name| session.inputs().iter().any(|input| input.name() == *name))
    {
        return Err(LocalModelError::InvalidTensor);
    }
    let media = media.by_name();
    // Features for a media input the graph does not declare are refused, never dropped.
    if media.iter().any(|(name, given)| {
        given.is_some() && !session.inputs().iter().any(|input| input.name() == *name)
    }) {
        return Err(LocalModelError::InvalidTensor);
    }
    let mut values = Vec::with_capacity(session.inputs().len());
    for input in session.inputs() {
        let data = match input.name() {
            "input_ids" => &batch.input_ids,
            "attention_mask" => &batch.attention_mask,
            "token_type_ids" => &batch.token_type_ids,
            "task_id" => {
                if !expected_input(input.dtype(), &[1]) {
                    return Err(LocalModelError::InvalidTensor);
                }
                let task = task_id.ok_or(LocalModelError::InvalidTensor)?;
                if task < 0
                    || usize::try_from(task)
                        .ok()
                        .is_none_or(|task| task >= profile.task_adaptations.len())
                {
                    return Err(LocalModelError::InvalidTensor);
                }
                values.push((
                    input.name().to_owned(),
                    Tensor::from_array(([1usize], vec![task]))
                        .map_err(|_| LocalModelError::InvalidTensor)?
                        .into_dyn(),
                ));
                continue;
            }
            name => {
                // A known optional media input: f32 [n, 512], empty for text-only calls. Any other name is refused.
                let (_, given) = media
                    .iter()
                    .find(|(known, _)| *known == name)
                    .ok_or(LocalModelError::InvalidTensor)?;
                let (rows, data) = given.map_or((0, Vec::new()), |features| {
                    (features.rows, features.values.clone())
                });
                if !expected_tensor(
                    input.dtype(),
                    TensorElementType::Float32,
                    &[rows, MEDIA_FEATURE_WIDTH],
                ) {
                    return Err(LocalModelError::InvalidTensor);
                }
                values.push((
                    input.name().to_owned(),
                    Tensor::from_array(([rows, MEDIA_FEATURE_WIDTH], data))
                        .map_err(|_| LocalModelError::InvalidTensor)?
                        .into_dyn(),
                ));
                continue;
            }
        };
        if !expected_input(input.dtype(), &[batch.batch, batch.sequence]) {
            return Err(LocalModelError::InvalidTensor);
        }
        values.push((
            input.name().to_owned(),
            Tensor::from_array(([batch.batch, batch.sequence], data.clone()))
                .map_err(|_| LocalModelError::InvalidTensor)?
                .into_dyn(),
        ));
    }
    Ok(values)
}

struct StopWatch<'a> {
    stop: &'a AtomicBool,
    thread: std::thread::Thread,
}
impl Drop for StopWatch<'_> {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.thread.unpark();
    }
}

fn with_watchdog<T>(
    cancel: &Cancel,
    options: &RunOptions,
    run: impl FnOnce() -> ort::Result<T>,
) -> Result<T, LocalModelError> {
    cancel.check()?;
    let stop = AtomicBool::new(false);
    let caller = cancel.clone();
    std::thread::scope(|scope| {
        let watch = std::thread::Builder::new()
            .name("embedding-cancel".into())
            .spawn_scoped(scope, || {
                while !stop.load(Ordering::Acquire) {
                    if caller.is_cancelled() {
                        return options.terminate();
                    }
                    std::thread::park_timeout(Duration::from_millis(2));
                }
                Ok(())
            })
            .map_err(|_| LocalModelError::RuntimeFailed)?;
        let stop_watch = StopWatch {
            stop: &stop,
            thread: watch.thread().clone(),
        };
        let result = run();
        drop(stop_watch); // Also runs on unwinding, before Scope joins the watcher.
        let stopped = watch.join().map_err(|_| LocalModelError::RuntimeFailed)?;
        cancel.check()?;
        stopped.map_err(|_| LocalModelError::RuntimeFailed)?;
        result.map_err(|_| LocalModelError::RuntimeFailed)
    })
}

fn valid_output(profile: &Artifact, name: &str, shape: &[usize], batch: &EncodedBatch) -> bool {
    if shape.first().copied() != Some(batch.batch) || shape.contains(&0) {
        return false;
    }
    if profile.role == "reranker" {
        return name == "logits" && shape.len() == 2 && shape[1] == 1;
    }
    if profile.runtime.as_deref() == Some("jina-v3") {
        return matches!(
            name,
            "text_embeds" | "last_hidden_state" | "logits" | "token_embeddings"
        ) && shape.len() == 3
            && shape[1] == batch.sequence;
    }
    match name {
        "last_hidden_state" | "token_embeddings" | "text_embeds" | "logits" => {
            shape.len() == 3 && shape[1] == batch.sequence
        }
        "sentence_embedding" | "pooler_output" => shape.len() == 2,
        _ => false,
    }
}

pub(super) fn infer(
    profile: &Artifact,
    model_path: &Path,
    batch: &EncodedBatch,
    task_id: Option<i64>,
    media: &MediaInputs,
    cancel: &Cancel,
    load_verifier: impl FnOnce() -> Result<(), LocalModelError>,
) -> Result<InferenceOutputs, LocalModelError> {
    cancel.check()?;
    let mut slot = shared_session(profile, model_path, cancel, load_verifier)?;
    let session = &mut slot.as_mut().ok_or(LocalModelError::RuntimeFailed)?.session;
    let values = inputs(session, profile, batch, task_id, media)?;
    cancel.check()?;
    let options = RunOptions::new().map_err(|_| LocalModelError::RuntimeFailed)?;
    let outputs = with_watchdog(cancel, &options, || {
        session.run_with_options(values, &options)
    })?;
    let mut tensors = BTreeMap::new();
    for (name, value) in &outputs {
        let (shape, data) = value
            .try_extract_tensor::<f32>()
            .map_err(|_| LocalModelError::InvalidTensor)?;
        let shape: Vec<usize> = shape
            .iter()
            .map(|dimension| usize::try_from(*dimension))
            .collect::<Result<_, _>>()
            .map_err(|_| LocalModelError::InvalidTensor)?;
        let length = shape
            .iter()
            .try_fold(1usize, |size, dim| size.checked_mul(*dim));
        if !valid_output(profile, name, &shape, batch)
            || length != Some(data.len())
            || data.iter().any(|value| !value.is_finite())
        {
            return Err(LocalModelError::InvalidTensor);
        }
        tensors.insert(name.to_owned(), (shape, data.to_vec()));
    }
    if tensors.is_empty() {
        return Err(LocalModelError::InvalidTensor);
    }
    cancel.check()?;
    Ok(tensors)
}

#[cfg(all(test, feature = "real-models"))]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::embedding::artifacts::pinned_profile;
    use crate::embedding::local_ort::MediaFeatures;
    use std::fs;
    use std::path::PathBuf;
    mod runtime {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/common/onnx_runtime.rs"
        ));
    }
    // Synthetic test graphs are independent of catalogue model bytes and pass an explicit verifier.
    fn infer(
        profile: &Artifact,
        model_path: &Path,
        batch: &EncodedBatch,
        task_id: Option<i64>,
        cancel: &Cancel,
    ) -> Result<InferenceOutputs, LocalModelError> {
        super::infer(
            profile,
            model_path,
            batch,
            task_id,
            &MediaInputs::default(),
            cancel,
            || Ok(()),
        )
    }
    static TEST_SESSIONS: Mutex<()> = Mutex::new(());
    fn runtime() -> MutexGuard<'static, ()> {
        let guard = TEST_SESSIONS.lock().unwrap();
        initialize(&runtime::ensure_runtime()).unwrap();
        guard
    }
    fn varint(mut number: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        while number > 127 {
            bytes.push((number as u8 & 127) | 128);
            number >>= 7;
        }
        bytes.push(number as u8);
        bytes
    }
    fn integer(field: u64, value: u64) -> Vec<u8> {
        [varint(field << 3), varint(value)].concat()
    }
    fn message(field: u64, value: impl AsRef<[u8]>) -> Vec<u8> {
        let bytes = value.as_ref();
        [
            varint((field << 3) | 2),
            varint(bytes.len() as u64),
            bytes.to_vec(),
        ]
        .concat()
    }
    /// A symbolic (`dim_param`) dimension, as an exported graph declares a variable row count.
    const DYNAMIC: u64 = u64::MAX;
    fn value_info(name: &str, kind: u64, shape: &[u64]) -> Vec<u8> {
        let dims: Vec<u8> = shape
            .iter()
            .flat_map(|dim| {
                if *dim == DYNAMIC {
                    message(1, message(2, "n"))
                } else {
                    message(1, integer(1, *dim))
                }
            })
            .collect();
        let tensor = [integer(1, kind), message(2, dims)].concat();
        [message(1, name), message(2, message(1, tensor))].concat()
    }
    // Build a tiny ONNX Cast/Identity graph from protobuf fields at test time. No model data is committed.
    fn graph(
        directory: &Path,
        source: &str,
        output: &str,
        cast: bool,
        extra: bool,
        scalar_task: bool,
    ) -> PathBuf {
        let extras: &[(&str, u64, &[u64])] = if extra {
            &[("pixel_values", 7, &[1, 2])]
        } else {
            &[]
        };
        graph_with(directory, source, output, cast, extras, scalar_task)
    }
    /// `graph` with further declared, unconsumed inputs `(name, ONNX element type, shape)`.
    fn graph_with(
        directory: &Path,
        source: &str,
        output: &str,
        cast: bool,
        extras: &[(&str, u64, &[u64])],
        scalar_task: bool,
    ) -> PathBuf {
        let task_tensor = source == "task_id" && !scalar_task;
        let cast_output = if task_tensor { "casted" } else { output };
        let node = [
            message(1, source),
            message(2, cast_output),
            message(4, if cast { "Cast" } else { "Identity" }),
            if cast {
                message(
                    5,
                    [message(1, "to"), integer(3, 1), integer(20, 2)].concat(),
                )
            } else {
                Vec::new()
            },
        ]
        .concat();
        let mut nodes = message(1, node);
        if task_tensor {
            let axes = [
                message(1, "axes"),
                integer(8, 1),
                integer(8, 2),
                integer(20, 7),
            ]
            .concat();
            let unsqueeze = [
                message(1, "casted"),
                message(2, output),
                message(4, "Unsqueeze"),
                message(5, axes),
            ]
            .concat();
            nodes.extend(message(1, unsqueeze));
        }
        let input_shape: &[u64] = if source == "task_id" {
            &[1, 1]
        } else {
            &[1, 2]
        };
        let mut inputs = [
            message(11, value_info("input_ids", 7, input_shape)),
            message(11, value_info("attention_mask", 7, input_shape)),
        ]
        .concat();
        if source == "task_id" {
            inputs.extend(message(
                11,
                value_info("task_id", 7, if scalar_task { &[] } else { &[1] }),
            ));
        }
        for (name, kind, shape) in extras {
            inputs.extend(message(11, value_info(name, *kind, shape)));
        }
        let shape: &[u64] = if task_tensor {
            &[1, 1, 1]
        } else if scalar_task {
            &[]
        } else {
            &[1, 2]
        };
        let graph = [
            nodes,
            message(2, "synthetic-identity"),
            inputs,
            message(12, value_info(output, if cast { 1 } else { 7 }, shape)),
        ]
        .concat();
        let model = [
            integer(1, 8),
            message(2, "plur1bus-test"),
            message(7, graph),
            message(8, integer(2, 11)),
        ]
        .concat();
        let path = directory.join("model.onnx");
        fs::write(&path, model).unwrap();
        path
    }
    fn batch() -> EncodedBatch {
        EncodedBatch {
            input_ids: vec![3, 7],
            attention_mask: vec![1, 1],
            token_type_ids: vec![0, 0],
            batch: 1,
            sequence: 2,
        }
    }
    fn e5() -> Artifact {
        pinned_profile("intfloat/multilingual-e5-small", None)
            .unwrap()
            .clone()
    }

    #[test]
    fn real_runtime_runs_only_declared_i64_inputs_and_returns_owned_float_buffers() {
        let _runtime = runtime();
        let directory = tempfile::tempdir().unwrap();
        let path = graph(
            directory.path(),
            "input_ids",
            "sentence_embedding",
            true,
            false,
            false,
        );
        let result = infer(&e5(), &path, &batch(), None, &Cancel::never()).unwrap();
        assert_eq!(result["sentence_embedding"], (vec![1, 2], vec![3.0, 7.0]));
    }
    const FLOAT: u64 = 1;
    const INT64: u64 = 7;
    const MEDIA: [&str; 3] = ["image_features", "video_features", "audio_features"];
    fn media_graph(directory: &Path, extras: &[(&str, u64, &[u64])]) -> PathBuf {
        graph_with(
            directory,
            "input_ids",
            "sentence_embedding",
            true,
            extras,
            false,
        )
    }
    fn infer_media(path: &Path, media: &MediaInputs) -> Result<InferenceOutputs, LocalModelError> {
        super::infer(&e5(), path, &batch(), None, media, &Cancel::never(), || {
            Ok(())
        })
    }
    #[test]
    fn known_media_inputs_receive_empty_features_for_text_and_real_rows_when_given() {
        let _runtime = runtime();
        let directory = tempfile::tempdir().unwrap();
        let width = MEDIA_FEATURE_WIDTH as u64;
        let shape = [DYNAMIC, width];
        let extras: Vec<(&str, u64, &[u64])> = MEDIA
            .iter()
            .map(|name| (*name, FLOAT, &shape[..]))
            .collect();
        let path = media_graph(directory.path(), &extras);
        let text = infer_media(&path, &MediaInputs::default()).unwrap();
        assert_eq!(text["sentence_embedding"], (vec![1, 2], vec![3.0, 7.0]));
        let image = MediaFeatures::new(2, vec![0.5; 2 * MEDIA_FEATURE_WIDTH]).unwrap();
        let media = MediaInputs {
            image: Some(image),
            ..MediaInputs::default()
        };
        assert_eq!(infer_media(&path, &media).unwrap(), text);
    }
    #[test]
    fn media_inputs_are_refused_unless_known_float_rows_of_the_declared_width() {
        let _runtime = runtime();
        let width = MEDIA_FEATURE_WIDTH as u64;
        let refused: [&[(&str, u64, &[u64])]; 4] = [
            &[("image_features", FLOAT, &[DYNAMIC, 256])],
            &[("audio_features", INT64, &[DYNAMIC, width])],
            &[("video_features", FLOAT, &[DYNAMIC, width, 1])],
            // Only the three known names pass; an unknown input of the same shape is still refused.
            &[("depth_features", FLOAT, &[DYNAMIC, width])],
        ];
        for extras in refused {
            let directory = tempfile::tempdir().unwrap();
            let path = media_graph(directory.path(), extras);
            assert!(
                matches!(
                    infer_media(&path, &MediaInputs::default()),
                    Err(LocalModelError::InvalidTensor)
                ),
                "{extras:?}"
            );
        }
        // Features for a media input the graph does not declare are refused, not dropped.
        let directory = tempfile::tempdir().unwrap();
        let path = media_graph(
            directory.path(),
            &[("image_features", FLOAT, &[DYNAMIC, width])],
        );
        let audio = MediaFeatures::new(1, vec![0.0; MEDIA_FEATURE_WIDTH]).unwrap();
        let media = MediaInputs {
            audio: Some(audio),
            ..MediaInputs::default()
        };
        assert!(matches!(
            infer_media(&path, &media),
            Err(LocalModelError::InvalidTensor)
        ));
        assert!(matches!(
            MediaFeatures::new(1, vec![0.0; MEDIA_FEATURE_WIDTH - 1]),
            Err(LocalModelError::InvalidTensor)
        ));
        assert!(matches!(
            MediaFeatures::new(1, vec![f32::NAN; MEDIA_FEATURE_WIDTH]),
            Err(LocalModelError::InvalidTensor)
        ));
    }
    #[test]
    fn shared_session_survives_graph_removal_and_distinguishes_exact_profile_metadata() {
        let _runtime = runtime();
        let directory = tempfile::tempdir().unwrap();
        let mut profile = e5();
        let path = graph(
            directory.path(),
            "input_ids",
            "sentence_embedding",
            true,
            false,
            false,
        );
        infer(&profile, &path, &batch(), None, &Cancel::never()).unwrap();
        fs::write(&path, b"invalid replacement").unwrap();
        assert!(infer(&profile, &path, &batch(), None, &Cancel::never()).is_ok());
        profile.dtype = Some("another-dtype".into());
        assert!(matches!(
            infer(&profile, &path, &batch(), None, &Cancel::never()),
            Err(LocalModelError::RuntimeFailed)
        ));
    }
    #[test]
    fn switching_models_evicts_the_previous_session_instead_of_retaining_a_pool() {
        let _runtime = runtime();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_path = graph(
            first.path(),
            "input_ids",
            "sentence_embedding",
            true,
            false,
            false,
        );
        let second_path = graph(
            second.path(),
            "input_ids",
            "sentence_embedding",
            true,
            false,
            false,
        );
        infer(&e5(), &first_path, &batch(), None, &Cancel::never()).unwrap();
        let old_native = {
            let slot = SESSION.lock().unwrap();
            std::sync::Arc::downgrade(&slot.as_ref().unwrap().session.inner())
        };
        infer(&e5(), &second_path, &batch(), None, &Cancel::never()).unwrap();
        assert!(
            old_native.upgrade().is_none(),
            "the slot must own only the replacement native session"
        );
        fs::write(&first_path, b"invalid replacement").unwrap();
        assert!(
            matches!(
                infer(&e5(), &first_path, &batch(), None, &Cancel::never()),
                Err(LocalModelError::RuntimeFailed)
            ),
            "the first native session must have been released when the second graph replaced it"
        );
    }
    #[test]
    fn replacing_a_session_drops_the_old_slot_before_a_new_load_can_fail() {
        let _runtime = runtime();
        let directory = tempfile::tempdir().unwrap();
        let path = graph(
            directory.path(),
            "input_ids",
            "sentence_embedding",
            true,
            false,
            false,
        );
        infer(&e5(), &path, &batch(), None, &Cancel::never()).unwrap();
        let old_native = {
            let slot = SESSION.lock().unwrap();
            std::sync::Arc::downgrade(&slot.as_ref().unwrap().session.inner())
        };
        assert!(matches!(
            infer(
                &e5(),
                &directory.path().join("missing.onnx"),
                &batch(),
                None,
                &Cancel::never()
            ),
            Err(LocalModelError::RuntimeFailed)
        ));
        assert!(
            old_native.upgrade().is_none(),
            "the old native session must be gone before a failed replacement returns"
        );
        fs::remove_file(&path).unwrap();
        assert!(
            matches!(
                infer(&e5(), &path, &batch(), None, &Cancel::never()),
                Err(LocalModelError::RuntimeFailed)
            ),
            "a failed replacement must not retain the previous native session"
        );
    }
    #[test]
    fn load_verifier_runs_for_slot_changes_and_is_unused_for_reuse() {
        let _runtime = runtime();
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_path = graph(
            first.path(),
            "input_ids",
            "sentence_embedding",
            true,
            false,
            false,
        );
        let second_path = graph(
            second.path(),
            "input_ids",
            "sentence_embedding",
            true,
            false,
            false,
        );
        let calls = std::cell::Cell::new(0);
        let verify = || {
            calls.set(calls.get() + 1);
            Ok(())
        };
        super::infer(
            &e5(),
            &first_path,
            &batch(),
            None,
            &MediaInputs::default(),
            &Cancel::never(),
            verify,
        )
        .unwrap();
        assert_eq!(
            calls.get(),
            1,
            "a new native load must verify its current artifact bytes"
        );
        calls.set(0);
        super::infer(
            &e5(),
            &first_path,
            &batch(),
            None,
            &MediaInputs::default(),
            &Cancel::never(),
            verify,
        )
        .unwrap();
        assert_eq!(
            calls.get(),
            0,
            "reusing the still-loaded native session must not rehash model files"
        );
        super::infer(
            &e5(),
            &second_path,
            &batch(),
            None,
            &MediaInputs::default(),
            &Cancel::never(),
            verify,
        )
        .unwrap();
        assert_eq!(
            calls.get(),
            1,
            "switching the native session must verify the replacement"
        );
        super::infer(
            &e5(),
            &first_path,
            &batch(),
            None,
            &MediaInputs::default(),
            &Cancel::never(),
            verify,
        )
        .unwrap();
        assert_eq!(
            calls.get(),
            2,
            "reloading an evicted graph must verify it again"
        );
    }
    #[test]
    fn failed_load_verifier_leaves_no_session_and_precedes_opening_the_graph() {
        let _runtime = runtime();
        let directory = tempfile::tempdir().unwrap();
        let path = graph(
            directory.path(),
            "input_ids",
            "sentence_embedding",
            true,
            false,
            false,
        );
        infer(&e5(), &path, &batch(), None, &Cancel::never()).unwrap();
        let old_native = {
            let slot = SESSION.lock().unwrap();
            std::sync::Arc::downgrade(&slot.as_ref().unwrap().session.inner())
        };
        let missing_graph = directory.path().join("must-not-open.onnx");
        let calls = std::cell::Cell::new(0);
        let result = super::infer(
            &e5(),
            &missing_graph,
            &batch(),
            None,
            &MediaInputs::default(),
            &Cancel::never(),
            || {
                calls.set(calls.get() + 1);
                Err(LocalModelError::InvalidTokenizer)
            },
        );
        assert!(matches!(result, Err(LocalModelError::InvalidTokenizer)), "the verifier's typed refusal must precede any native attempt to open the nonexistent graph");
        assert_eq!(calls.get(), 1);
        assert!(SESSION.lock().unwrap().is_none());
        assert!(old_native.upgrade().is_none());
    }
    #[test]
    fn jina_task_id_is_rank_one_i64_and_query_and_passage_reach_the_graph() {
        let _runtime = runtime();
        let directory = tempfile::tempdir().unwrap();
        let path = graph(
            directory.path(),
            "task_id",
            "text_embeds",
            true,
            false,
            false,
        );
        let task_batch = EncodedBatch {
            input_ids: vec![3],
            attention_mask: vec![1],
            token_type_ids: vec![0],
            batch: 1,
            sequence: 1,
        };
        let profile = pinned_profile("jinaai/jina-embeddings-v3", None).unwrap();
        for task in [0, 1] {
            let result = infer(profile, &path, &task_batch, Some(task), &Cancel::never()).unwrap();
            assert_eq!(result["text_embeds"], (vec![1, 1, 1], vec![task as f32]));
        }
        assert!(matches!(
            infer(profile, &path, &task_batch, None, &Cancel::never()),
            Err(LocalModelError::InvalidTensor)
        ));
    }
    #[test]
    fn unsupported_inputs_task_ranks_and_output_shapes_are_rejected() {
        let _runtime = runtime();
        for (source, output, cast, extra, scalar_task) in [
            ("input_ids", "sentence_embedding", true, true, false),
            ("task_id", "logits", true, false, true),
            ("input_ids", "last_hidden_state", true, false, false),
            ("input_ids", "sentence_embedding", false, false, false),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = graph(directory.path(), source, output, cast, extra, scalar_task);
            let profile = if source == "task_id" {
                pinned_profile("jinaai/jina-embeddings-v3", None)
                    .unwrap()
                    .clone()
            } else {
                e5()
            };
            let encoded = if source == "task_id" {
                EncodedBatch {
                    input_ids: vec![3],
                    attention_mask: vec![1],
                    token_type_ids: vec![0],
                    batch: 1,
                    sequence: 1,
                }
            } else {
                batch()
            };
            assert!(matches!(
                infer(
                    &profile,
                    &path,
                    &encoded,
                    if source == "task_id" { Some(0) } else { None },
                    &Cancel::never()
                ),
                Err(LocalModelError::InvalidTensor)
            ));
        }
    }
    #[test]
    fn reranker_logits_require_exactly_batch_by_one() {
        let profile = pinned_profile("woxpas-ai/bge-reranker-v2-m3-onnx", None).unwrap();
        assert!(valid_output(profile, "logits", &[1, 1], &batch()));
        assert!(!valid_output(profile, "logits", &[1], &batch()));
        assert!(!valid_output(profile, "logits", &[1, 2], &batch()));
    }
    #[test]
    fn cancellation_terminates_native_runs_and_joins_the_watchdog() {
        let _runtime = runtime();
        let directory = tempfile::tempdir().unwrap();
        let path = graph(
            directory.path(),
            "input_ids",
            "sentence_embedding",
            true,
            false,
            false,
        );
        let profile = e5();
        let batch = batch();
        let cancel = Cancel::never();
        let mut slot = shared_session(&profile, &path, &cancel, || Ok(())).unwrap();
        let session = &mut slot.as_mut().unwrap().session;
        let options = RunOptions::new().unwrap();
        let native_terminated = AtomicBool::new(false);
        let until = std::time::Instant::now() + Duration::from_secs(2);
        std::thread::scope(|scope| {
            let caller = cancel.clone();
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(10));
                caller.cancel();
            });
            let result = with_watchdog(&cancel, &options, || {
                while std::time::Instant::now() < until {
                    let values =
                        inputs(session, &profile, &batch, None, &MediaInputs::default()).unwrap();
                    if let Err(error) = session.run_with_options(values, &options) {
                        native_terminated.store(true, Ordering::Release);
                        return Err(error);
                    }
                }
                Ok(())
            });
            assert!(matches!(result, Err(LocalModelError::Cancelled(_))));
        });
        assert!(
            native_terminated.load(Ordering::Acquire),
            "native RunOptions was not terminated before the bounded probe ended"
        );
        // The cancelled run's options are per call; the shared session remains usable afterwards.
        drop(slot);
        assert!(infer(&profile, &path, &batch, None, &Cancel::never()).is_ok());
    }
    #[test]
    fn cancellation_interrupts_waiting_for_a_busy_session_mutex() {
        let mutex = Mutex::new(());
        let _held = mutex.lock().unwrap();
        let cancel = Cancel::never();
        let caller = cancel.clone();
        std::thread::scope(|scope| {
            let (send, receive) = std::sync::mpsc::channel();
            let waiting_mutex = &mutex;
            scope.spawn(move || {
                send.send(matches!(
                    lock_cancel(waiting_mutex, &caller),
                    Err(LocalModelError::Cancelled(_))
                ))
                .unwrap();
            });
            assert!(receive.recv_timeout(Duration::from_millis(10)).is_err());
            cancel.cancel();
            assert!(receive.recv_timeout(Duration::from_secs(1)).unwrap());
        });
    }
    #[test]
    fn cancellation_precedes_missing_model_loading() {
        let cancel = Cancel::never();
        cancel.cancel();
        for cancel in [
            cancel,
            Cancel::with_deadline(std::time::Instant::now() - Duration::from_secs(1)),
        ] {
            assert!(matches!(
                infer(
                    &e5(),
                    Path::new("missing-model.onnx"),
                    &batch(),
                    None,
                    &cancel
                ),
                Err(LocalModelError::Cancelled(_))
            ));
        }
    }
}
