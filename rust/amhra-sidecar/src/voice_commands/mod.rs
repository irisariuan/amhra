//! Voice commands: a wake word, then what follows it, as text.
//!
//! ```text
//! 16 kHz PCM ─▶ keyword spotter ──"Amhra"──▶ capture ─▶ end of speech ─▶ speech to text ─▶ Utterance
//! per speaker    (streaming)                 (pre-roll)  (VAD, 500ms)    (one shared thread)
//! ```
//!
//! Nothing anyone says is transcribed unless it follows the wake word. The
//! keyword spotter is the only model that hears everything, and it is a 3.3M
//! parameter streaming model — cheap enough to run on every speaker at once.
//! Voice activity detection runs only between a detection and the end of the
//! command, and speech recognition only on that window.
//!
//! Three threads per call, none of them the 20ms send thread:
//!
//! - the receive thread (`listen.rs`) decodes and hands frames over,
//! - a per-guild gate thread runs the spotter and the VAD for each speaker,
//! - one process-wide recogniser thread turns captured windows into text.
//!
//! Each handover is a bounded queue that drops when full. A backlog of voice is
//! worthless — a command transcribed ten seconds late is a command the user
//! has already repeated — so falling behind sheds work instead of queueing it.
//!
//! The models sit behind the [`Spotter`], [`Vad`] and [`Transcriber`] traits,
//! so the state machine in [`gate`] and the per-speaker bookkeeping in
//! [`speakers`] are tested with fakes and compile without any model runtime.
//! The real ones, in `sherpa.rs`, are behind the `voice-commands` feature.

pub mod engine;
pub mod gate;
pub mod keywords;
#[cfg(feature = "voice-commands")]
pub mod sherpa;
pub mod speakers;

pub use amhra_voice::receive::SAMPLE_RATE;

/// One 20ms frame at [`SAMPLE_RATE`]: what the receive path delivers, and the
/// unit the gate is fed in.
pub const FRAME_SAMPLES: usize = amhra_voice::receive::SAMPLES_PER_FRAME;

/// A wake word found in a stream.
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
	/// The phrase as written in the keywords file, e.g. `HEY AMHRA`.
	pub keyword: String,
	/// How long ago, in samples, the keyword ended, measured back from the end
	/// of the audio fed so far. A streaming model only becomes sure of a word
	/// some time after it was said; this is that delay, so the capture can
	/// start where the speaker actually stopped saying the name.
	pub lag: usize,
}

/// A streaming wake-word detector for one speaker.
pub trait Spotter: Send {
	/// Hear more audio. Returns a detection if a keyword completed in it.
	fn accept(&mut self, samples: &[f32]) -> Option<Detection>;
	/// Forget everything heard so far, so a keyword already reported is not
	/// reported again.
	fn reset(&mut self);
}

/// Voice activity detection for one speaker.
pub trait Vad: Send {
	/// Hear more audio. Returns whether the speaker is talking at the end of it.
	fn accept(&mut self, samples: &[f32]) -> bool;
	fn reset(&mut self);
}

/// What a recogniser made of a window of speech.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcript {
	pub text: String,
	/// The language the recogniser detected, as an ISO 639-1 code where it has
	/// one (`en`, `ja`, `ko`, `zh`) and its own tag otherwise (`yue`).
	pub lang: Option<String>,
}

/// Offline speech recognition: a whole window in, text out.
pub trait Transcriber: Send {
	fn transcribe(&mut self, samples: &[f32]) -> Result<Transcript, ModelError>;
}

/// Makes the per-speaker models. Shared by every gate thread, so whatever is
/// expensive to load is loaded once and only the per-stream state is made here.
pub trait Models: Send + Sync {
	fn spotter(&self) -> Result<Box<dyn Spotter>, ModelError>;
	fn vad(&self) -> Result<Box<dyn Vad>, ModelError>;
}

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
	#[error("{0} is missing; run scripts/download-voice-models.sh")]
	Missing(std::path::PathBuf),
	#[error("could not load {what}: {reason}")]
	Load { what: &'static str, reason: String },
	#[error(transparent)]
	Keywords(#[from] keywords::KeywordError),
	#[error("recognition failed: {0}")]
	Recognition(String),
}

/// PCM as the models want it: floats in [-1, 1).
pub fn to_float(pcm: &[i16], out: &mut Vec<f32>) {
	out.clear();
	out.extend(pcm.iter().map(|&sample| f32::from(sample) / 32768.0));
}

/// Samples in a span of time at [`SAMPLE_RATE`].
pub const fn samples(milliseconds: u32) -> usize {
	(milliseconds as usize) * (SAMPLE_RATE as usize) / 1000
}

/// Milliseconds in a number of samples at [`SAMPLE_RATE`].
pub const fn milliseconds(samples: usize) -> u32 {
	(samples * 1000 / SAMPLE_RATE as usize) as u32
}
