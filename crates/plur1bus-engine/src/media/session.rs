//! Three lazy media ORT slots with private thread pools, strict tensors and cancellable runs.

use super::artifacts::{verify_graph, MediaGraph};
use super::audio::AudioTensor;
use super::embedder::{
    validate_features, MediaEncoder, MediaError, MediaModality, FEATURE_WIDTH, MEDIA_DIMENSIONS,
};
use super::image::ImageTensor;
use crate::contract::Cancel;
use crate::embedding::local_ort::{
    media_admission_wait, media_environment, media_watchdog, LocalModelError,
};
use ort::environment::ThreadManager;
use ort::session::{builder::GraphOptimizationLevel, RunOptions, Session};
use ort::value::{DynValue, Tensor, TensorElementType, ValueType};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::Duration;

struct CachedSession {
    root: PathBuf,
    session: Session,
}
static VISION: Mutex<Option<CachedSession>> = Mutex::new(None);
static AUDIO: Mutex<Option<CachedSession>> = Mutex::new(None);
static FUSION: Mutex<Option<CachedSession>> = Mutex::new(None);
// Only one media stage consumes its bounded private ORT pool at a time, across all provider instances.
static MEDIA_STAGE: Mutex<()> = Mutex::new(());

/// Real q8 media graph adapter. All file verification and session initialization is lazy.
pub struct SessionMediaEncoder {
    cache_root: PathBuf,
}

impl SessionMediaEncoder {
    /// Select the host-prepared cache without opening files or touching ONNX Runtime.
    pub fn new(cache_root: PathBuf) -> Self {
        Self { cache_root }
    }

    fn run(
        &self,
        graph: MediaGraph,
        inputs: Vec<NamedTensor>,
        expected: &[(&str, Vec<usize>)],
        cancel: &Cancel,
    ) -> Result<BTreeMap<String, Vec<f32>>, MediaError> {
        let _stage = lock_cancel(&MEDIA_STAGE, cancel)?;
        media_admission_wait(cancel).map_err(runtime_error)?;
        let mutex = match graph {
            MediaGraph::Vision => &VISION,
            MediaGraph::Audio => &AUDIO,
            MediaGraph::Fusion => &FUSION,
        };
        let mut slot = lock_cancel(mutex, cancel)?;
        let root = if self.cache_root.is_absolute() {
            self.cache_root.clone()
        } else {
            std::env::current_dir()
                .map_err(|_| MediaError::RuntimeFailed)?
                .join(&self.cache_root)
        };
        if slot.as_ref().is_none_or(|cached| cached.root != root) {
            *slot = None;
            let model = verify_graph(&root, graph, cancel)?;
            cancel.check()?;
            let environment = media_environment().map_err(runtime_error)?;
            let threads = std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
                / 2;
            let session = Session::builder(environment)
                .map_err(|_| MediaError::RuntimeFailed)?
                // rc.14 otherwise disables per-session pools when the shared environment has a global pool.
                .with_independent_thread_pool()
                .map_err(|_| MediaError::RuntimeFailed)?
                .with_thread_manager(MediaThreadManager)
                .map_err(|_| MediaError::RuntimeFailed)?
                .with_intra_threads(threads.max(1))
                .map_err(|_| MediaError::RuntimeFailed)?
                .with_inter_threads(1)
                .map_err(|_| MediaError::RuntimeFailed)?
                .with_parallel_execution(false)
                .map_err(|_| MediaError::RuntimeFailed)?
                .with_intra_op_spinning(false)
                .map_err(|_| MediaError::RuntimeFailed)?
                .with_inter_op_spinning(false)
                .map_err(|_| MediaError::RuntimeFailed)?
                .with_optimization_level(GraphOptimizationLevel::All)
                .map_err(|_| MediaError::RuntimeFailed)?
                .commit_from_file(model)
                .map_err(|_| MediaError::RuntimeFailed)?;
            cancel.check()?;
            *slot = Some(CachedSession { root, session });
        }
        let session = &mut slot.as_mut().ok_or(MediaError::RuntimeFailed)?.session;
        validate_inputs(session, &inputs)?;
        let inputs = inputs
            .into_iter()
            .map(NamedTensor::into_value)
            .collect::<Result<Vec<_>, _>>()?;
        media_admission_wait(cancel).map_err(runtime_error)?;
        let options = RunOptions::new().map_err(|_| MediaError::RuntimeFailed)?;
        let outputs = media_watchdog(cancel, &options, || {
            session.run_with_options(inputs, &options)
        })
        .map_err(runtime_error)?;
        let mut result = BTreeMap::new();
        for (name, value) in &outputs {
            let wanted = expected
                .iter()
                .find(|(known, _)| *known == name)
                .ok_or(MediaError::InvalidTensor)?;
            let (shape, data) = value
                .try_extract_tensor::<f32>()
                .map_err(|_| MediaError::InvalidTensor)?;
            if shape.len() != wanted.1.len()
                || !shape
                    .iter()
                    .zip(&wanted.1)
                    .all(|(actual, wanted)| usize::try_from(*actual).ok() == Some(*wanted))
                || wanted
                    .1
                    .iter()
                    .try_fold(1usize, |total, n| total.checked_mul(*n))
                    != Some(data.len())
                || data.iter().any(|value| !value.is_finite())
            {
                return Err(MediaError::InvalidTensor);
            }
            result.insert(name.to_owned(), data.to_vec());
        }
        if expected.iter().any(|(name, _)| !result.contains_key(*name)) {
            return Err(MediaError::InvalidTensor);
        }
        cancel.check()?;
        Ok(result)
    }
}

impl MediaEncoder for SessionMediaEncoder {
    fn vision(&self, images: &[ImageTensor], cancel: &Cancel) -> Result<Vec<f32>, MediaError> {
        cancel.check()?;
        if images.is_empty() || images.len() > 4 {
            return Err(MediaError::InvalidTensor);
        }
        let patches = images[0].max_patches;
        if patches == 0
            || patches > 280 * 9
            || images.iter().any(|image| {
                image.max_patches != patches
                    || image.pixels.len() != patches * 768
                    || image.positions.len() != patches * 2
                    || image.soft_tokens == 0
                    || image.soft_tokens > patches / 9
                    || image.pixels.iter().any(|value| !value.is_finite())
            })
        {
            return Err(MediaError::InvalidTensor);
        }
        for image in images {
            validate_patch_positions(image)?;
        }
        let rows = images.iter().map(|image| image.soft_tokens).sum();
        let inputs = vec![
            NamedTensor::float(
                "pixel_values",
                vec![images.len(), patches, 768],
                images
                    .iter()
                    .flat_map(|image| image.pixels.iter().copied())
                    .collect(),
            ),
            NamedTensor::integer(
                "pixel_position_ids",
                vec![images.len(), patches, 2],
                images
                    .iter()
                    .flat_map(|image| image.positions.iter().copied())
                    .collect(),
            ),
        ];
        self.run(
            MediaGraph::Vision,
            inputs,
            &[("image_features", vec![rows, FEATURE_WIDTH])],
            cancel,
        )?
        .remove("image_features")
        .ok_or(MediaError::InvalidTensor)
    }

    fn audio(&self, audio: &AudioTensor, cancel: &Cancel) -> Result<Vec<f32>, MediaError> {
        cancel.check()?;
        if audio.frames == 0
            || audio.frames > 3000
            || audio.feature_size != 128
            || audio.features.len() != audio.frames * 128
            || audio.mask.len() != audio.frames
            || audio.soft_tokens == 0
            || audio.soft_tokens != audio.mask.iter().step_by(4).filter(|v| **v).count()
            || audio.features.iter().any(|value| !value.is_finite())
        {
            return Err(MediaError::InvalidTensor);
        }
        let inputs = vec![
            NamedTensor::float(
                "input_features",
                vec![1, audio.frames, 128],
                audio.features.clone(),
            ),
            NamedTensor {
                name: "input_features_mask",
                shape: vec![1, audio.frames],
                data: TensorData::Boolean(audio.mask.clone()),
            },
        ];
        self.run(
            MediaGraph::Audio,
            inputs,
            &[("audio_features", vec![audio.soft_tokens, FEATURE_WIDTH])],
            cancel,
        )?
        .remove("audio_features")
        .ok_or(MediaError::InvalidTensor)
    }

    fn fuse(
        &self,
        modality: MediaModality,
        features: &[f32],
        cancel: &Cancel,
    ) -> Result<Vec<f32>, MediaError> {
        let rows = features.len() / FEATURE_WIDTH;
        validate_features(features, rows)?;
        let tokens = placeholder_tokens(modality, rows)?;
        let sequence = tokens.len();
        let mut inputs = vec![
            NamedTensor::integer("input_ids", vec![1, sequence], tokens),
            NamedTensor::integer("attention_mask", vec![1, sequence], vec![1; sequence]),
        ];
        for (name, kind) in [
            ("image_features", MediaModality::Image),
            ("video_features", MediaModality::Video),
            ("audio_features", MediaModality::Audio),
        ] {
            inputs.push(NamedTensor::float(
                name,
                vec![if kind == modality { rows } else { 0 }, FEATURE_WIDTH],
                if kind == modality {
                    features.to_vec()
                } else {
                    Vec::new()
                },
            ));
        }
        self.run(
            MediaGraph::Fusion,
            inputs,
            &[
                ("last_hidden_state", vec![1, sequence, MEDIA_DIMENSIONS]),
                ("sentence_embedding", vec![1, MEDIA_DIMENSIONS]),
            ],
            cancel,
        )?
        .remove("sentence_embedding")
        .ok_or(MediaError::InvalidTensor)
    }
}

/// Construct exact pinned media-only IDs without the ordinary text provider's 512-token cap.
pub fn placeholder_tokens(modality: MediaModality, rows: usize) -> Result<Vec<i64>, MediaError> {
    if rows == 0 {
        return Err(MediaError::InvalidTensor);
    }
    let length = rows
        .checked_add(4)
        .filter(|n| *n <= 8192)
        .ok_or(MediaError::ResourceLimit)?;
    let (begin, soft, end) = match modality {
        MediaModality::Image => (255999, 258880, 258882),
        MediaModality::Video => (255999, 258884, 258882),
        MediaModality::Audio => (256000, 258881, 258883),
    };
    let mut tokens = Vec::with_capacity(length);
    tokens.extend([2, begin]);
    tokens.extend(std::iter::repeat_n(soft, rows));
    tokens.extend([end, 1]);
    Ok(tokens)
}

enum TensorData {
    Float(Vec<f32>),
    Integer(Vec<i64>),
    Boolean(Vec<bool>),
}

fn validate_patch_positions(image: &ImageTensor) -> Result<(), MediaError> {
    let mut coordinates = std::collections::BTreeSet::new();
    let mut padding = false;
    for (position, pixels) in image
        .positions
        .chunks_exact(2)
        .zip(image.pixels.chunks_exact(768))
    {
        if position == [-1, -1] {
            padding = true;
            if pixels.iter().any(|pixel| *pixel != 0.0) {
                return Err(MediaError::InvalidTensor);
            }
        } else if padding
            || position
                .iter()
                .any(|coordinate| *coordinate < 0 || *coordinate as usize >= image.max_patches)
            || !coordinates.insert((position[0], position[1]))
        {
            return Err(MediaError::InvalidTensor);
        }
    }
    if coordinates.len() != image.soft_tokens * 9 {
        return Err(MediaError::InvalidTensor);
    }
    Ok(())
}
struct NamedTensor {
    name: &'static str,
    shape: Vec<usize>,
    data: TensorData,
}
impl NamedTensor {
    fn float(name: &'static str, shape: Vec<usize>, data: Vec<f32>) -> Self {
        Self {
            name,
            shape,
            data: TensorData::Float(data),
        }
    }
    fn integer(name: &'static str, shape: Vec<usize>, data: Vec<i64>) -> Self {
        Self {
            name,
            shape,
            data: TensorData::Integer(data),
        }
    }
    fn element_type(&self) -> TensorElementType {
        match self.data {
            TensorData::Float(_) => TensorElementType::Float32,
            TensorData::Integer(_) => TensorElementType::Int64,
            TensorData::Boolean(_) => TensorElementType::Bool,
        }
    }
    fn into_value(self) -> Result<(String, DynValue), MediaError> {
        let value = match self.data {
            TensorData::Float(data) => Tensor::from_array((self.shape, data))
                .map_err(|_| MediaError::InvalidTensor)?
                .into_dyn(),
            TensorData::Integer(data) => Tensor::from_array((self.shape, data))
                .map_err(|_| MediaError::InvalidTensor)?
                .into_dyn(),
            TensorData::Boolean(data) => Tensor::from_array((self.shape, data))
                .map_err(|_| MediaError::InvalidTensor)?
                .into_dyn(),
        };
        Ok((self.name.into(), value))
    }
}

fn validate_inputs(session: &Session, inputs: &[NamedTensor]) -> Result<(), MediaError> {
    if session.inputs().len() != inputs.len() {
        return Err(MediaError::InvalidTensor);
    }
    for input in session.inputs() {
        let given = inputs
            .iter()
            .find(|given| given.name == input.name())
            .ok_or(MediaError::InvalidTensor)?;
        if !matches!(input.dtype(),ValueType::Tensor{ty,shape,..} if *ty==given.element_type()
            && shape.len()==given.shape.len() && shape.iter().zip(&given.shape).all(|(actual,wanted)|*actual == -1 || usize::try_from(*actual).ok()==Some(*wanted)))
        {
            return Err(MediaError::InvalidTensor);
        }
    }
    Ok(())
}

pub(crate) fn lock_cancel<'a, T>(
    mutex: &'a Mutex<T>,
    cancel: &Cancel,
) -> Result<MutexGuard<'a, T>, MediaError> {
    loop {
        cancel.check()?;
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => return Err(MediaError::RuntimeFailed),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
}

#[allow(clippy::needless_pass_by_value)] // Result::map_err consumes the runtime error; retain only bounded typed reasons.
fn runtime_error(error: LocalModelError) -> MediaError {
    match error {
        LocalModelError::Cancelled(reason) => MediaError::Cancelled(reason),
        LocalModelError::RuntimeUnavailable => MediaError::RuntimeUnavailable,
        _ => MediaError::RuntimeFailed,
    }
}

struct MediaThreadManager;
impl ThreadManager for MediaThreadManager {
    type Thread = std::thread::JoinHandle<()>;
    fn create(&self, work: impl FnOnce() + Send + 'static) -> ort::Result<Self::Thread> {
        let (ready, scheduling) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("media-ort-worker".into())
            .spawn(move || {
                let result = lower_worker_priority();
                let accepted = result.is_ok();
                let _ = ready.send(result);
                if accepted {
                    work();
                }
            })
            .map_err(|_| ort::Error::new("media worker creation failed"))?;
        if !matches!(scheduling.recv(), Ok(Ok(()))) {
            let _ = thread.join();
            return Err(ort::Error::new("media worker scheduling failed"));
        }
        Ok(thread)
    }
    fn join(thread: Self::Thread) -> ort::Result<()> {
        thread
            .join()
            .map_err(|_| ort::Error::new("media worker failed"))
    }
}

/// Lower only the calling dedicated media worker, including each private ORT pool worker.
pub(crate) fn lower_worker_priority() -> Result<(), MediaError> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: gettid identifies this worker only; neither operation receives pointers. Retain an already
        // lower priority (e.g. a host launched with nice=19) rather than trying to raise it to nice=10.
        let result = unsafe {
            let id = libc::syscall(libc::SYS_gettid) as libc::id_t;
            let current = libc::getpriority(libc::PRIO_PROCESS, id);
            libc::setpriority(libc::PRIO_PROCESS, id, current.max(10))
        };
        if result != 0 {
            return Err(MediaError::RuntimeFailed);
        }
    }
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn pthread_set_qos_class_self_np(class: u32, relative_priority: i32) -> i32;
        }
        // SAFETY: Apple's documented QOS_CLASS_BACKGROUND is 0x09 and this changes only the calling worker.
        if unsafe { pthread_set_qos_class_self_np(0x09, 0) } != 0 {
            return Err(MediaError::RuntimeFailed);
        }
    }
    #[cfg(target_os = "windows")]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentThread() -> *mut std::ffi::c_void;
            fn SetThreadPriority(thread: *mut std::ffi::c_void, priority: i32) -> i32;
        }
        // SAFETY: the current-thread pseudo-handle is valid for SetThreadPriority; -2 is THREAD_PRIORITY_LOWEST.
        if unsafe { SetThreadPriority(GetCurrentThread(), -2) } == 0 {
            return Err(MediaError::RuntimeFailed);
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
pub(crate) fn with_slots_locked(run: impl FnOnce()) {
    let _stage = MEDIA_STAGE.lock().unwrap();
    let _vision = VISION.lock().unwrap();
    let _audio = AUDIO.lock().unwrap();
    let _fusion = FUSION.lock().unwrap();
    run();
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn full_thirty_second_audio_tokens_are_never_cut_at_512() {
        let tokens = placeholder_tokens(MediaModality::Audio, 750).unwrap();
        assert_eq!(tokens.len(), 754);
        assert_eq!(&tokens[..2], &[2, 256000]);
        assert!(tokens[2..752].iter().all(|token| *token == 258881));
        assert_eq!(&tokens[752..], &[258883, 1]);
        assert!(placeholder_tokens(MediaModality::Audio, 8189).is_err());
    }
    #[test]
    fn missing_graph_and_invalid_features_fail_before_runtime_initialization() {
        let directory = tempfile::tempdir().unwrap();
        let encoder = SessionMediaEncoder::new(directory.path().to_owned());
        let tensor = ImageTensor {
            pixels: vec![0.0; 9 * 768],
            positions: (0..9).flat_map(|index| [index % 3, index / 3]).collect(),
            max_patches: 9,
            soft_tokens: 1,
        };
        assert!(
            matches!(encoder.vision(&[tensor],&Cancel::never()),Err(MediaError::ArtifactMissing{file}) if file=="onnx/vision_encoder_quantized.onnx")
        );
        assert_eq!(
            encoder.fuse(MediaModality::Image, &[f32::NAN; 512], &Cancel::never()),
            Err(MediaError::InvalidTensor)
        );
        let cancel = Cancel::never();
        cancel.cancel();
        assert!(matches!(
            encoder.audio(
                &AudioTensor {
                    features: vec![],
                    mask: vec![],
                    frames: 0,
                    feature_size: 128,
                    soft_tokens: 0
                },
                &cancel
            ),
            Err(MediaError::Cancelled(_))
        ));
    }
    #[test]
    fn inconsistent_patch_counts_and_padding_refuse_before_native_access() {
        let encoder = SessionMediaEncoder::new(PathBuf::from("missing"));
        let tensor = ImageTensor {
            pixels: vec![0.0; 18 * 768],
            positions: vec![-1; 36],
            max_patches: 18,
            soft_tokens: 1,
        };
        assert_eq!(
            encoder.vision(&[tensor], &Cancel::never()),
            Err(MediaError::InvalidTensor)
        );
        let tensor = ImageTensor {
            pixels: vec![0.0; 9 * 768],
            positions: vec![0; 18],
            max_patches: 9,
            soft_tokens: 1,
        };
        assert_eq!(
            encoder.vision(&[tensor], &Cancel::never()),
            Err(MediaError::InvalidTensor)
        );
    }
    #[test]
    fn vision_and_audio_slots_do_not_share_a_session_mutex() {
        let _vision = VISION.lock().unwrap();
        assert!(AUDIO.try_lock().is_ok());
        assert!(FUSION.try_lock().is_ok());
    }
    #[test]
    fn private_pool_workers_are_created_and_joined_with_background_priority() {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let thread = MediaThreadManager
            .create(move || {
                #[cfg(target_os = "linux")]
                // SAFETY: getpriority is queried only for this thread and has no pointer arguments.
                let priority = unsafe {
                    libc::getpriority(
                        libc::PRIO_PROCESS,
                        libc::syscall(libc::SYS_gettid) as libc::id_t,
                    )
                };
                #[cfg(not(target_os = "linux"))]
                let priority = 10;
                send.send(priority).unwrap();
            })
            .unwrap();
        assert!(receive.recv().unwrap() >= 10);
        MediaThreadManager::join(thread).unwrap();
    }
}
