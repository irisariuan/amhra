//! The audio each wake was heard in, saved to train the spotter on.
//!
//! The spotter is fine-tuned on recordings of the name (`training/wake`), and
//! recordings from more members are what improve it most. Saving what it woke
//! on collects them as the bot is used, in the shape `training/wake/segment.py`
//! leaves its cuts in: 16 kHz mono WAV files, and a `clips.tsv` naming each
//! with its transcript, `EMHARA`. Not every clip is the name — the false wakes
//! are in there too, and are worth as much once relabelled — so they are
//! reviewed before training, never used blind.
//!
//! Two things help that review, both guesses rather than labels:
//!
//! - `outcomes.tsv`: what came of each wake. `command` if the bot found a
//!   command in what followed, `no-command` if it found none, `silent` if
//!   nothing was said after the name, `unintelligible` if the recogniser made
//!   nothing of what was. A name followed by a command is very likely the
//!   name; a false wake is mostly followed by one of the other three, though
//!   so is a name said and then thought better of.
//! - near misses: when the spotter came close to waking on someone shortly
//!   before they did wake it, they were most likely saying the name again
//!   because the first time went unheard. That first try is saved beside the
//!   wake as `<wake>-near.wav`, and `near-misses.tsv` names it with its wake,
//!   its score and how long before the wake it was. These are the names the
//!   model misses, which saving only its wakes can never collect. Only the
//!   classifier scores what it does not wake on, so only it has near misses.
//!
//! Only guilds that turned voice commands on are heard at all, and the bot
//! tells their members this is being kept.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use super::SAMPLE_RATE;

/// What every clip is labelled until someone listens to it.
pub const LABEL: &str = "EMHARA";

/// What came of a wake, for `outcomes.tsv`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
	/// The bot found a command in what followed.
	Command,
	/// Something was said after it, and the bot found no command in it.
	NoCommand,
	/// Nothing was said after it.
	Silent,
	/// Something was said, and the recogniser made nothing of it.
	Unintelligible,
}

impl Outcome {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::Command => "command",
			Self::NoCommand => "no-command",
			Self::Silent => "silent",
			Self::Unintelligible => "unintelligible",
		}
	}
}

/// A directory of saved wake clips, with a cap on how many it will hold.
#[derive(Debug)]
pub struct ClipStore {
	dir: PathBuf,
	max: usize,
	saved: usize,
	/// Each speaker's last saved wake that nothing has yet come of, by guild
	/// and user.
	pending: HashMap<(String, u64), String>,
}

impl ClipStore {
	/// Create the directory if need be, counting what is already in it
	/// against `max`.
	pub fn open(dir: PathBuf, max: usize) -> std::io::Result<Self> {
		std::fs::create_dir_all(&dir)?;
		let saved = std::fs::read_dir(&dir)?
			.filter_map(Result::ok)
			.filter(|entry| entry.path().extension().is_some_and(|extension| extension == "wav"))
			.count();
		Ok(Self { dir, max, saved, pending: HashMap::new() })
	}

	/// Save one clip, unless the store is full. `at_ms` keeps the names apart
	/// and in order; it is the wall-clock time of the wake.
	pub fn save(
		&mut self,
		guild_id: &str,
		user_id: u64,
		samples: &[f32],
		at_ms: u128,
	) -> std::io::Result<Option<PathBuf>> {
		if self.saved >= self.max {
			return Ok(None);
		}
		let name = format!("{guild_id}-{user_id}-{at_ms}.wav");
		let path = self.dir.join(&name);
		write_wav(&mut BufWriter::new(File::create(&path)?), samples)?;
		let mut labels = OpenOptions::new().create(true).append(true).open(self.dir.join("clips.tsv"))?;
		writeln!(labels, "{name}\t{LABEL}")?;
		self.saved += 1;
		self.pending.insert((guild_id.to_owned(), user_id), name);
		Ok(Some(path))
	}

	/// Save a near miss the speaker had `before_ms` before the wake just
	/// saved for them, beside it. Nothing, if that wake was not saved.
	pub fn save_near_miss(
		&mut self,
		guild_id: &str,
		user_id: u64,
		samples: &[f32],
		score: f32,
		before_ms: u32,
	) -> std::io::Result<Option<PathBuf>> {
		let Some(wake) = self.pending.get(&(guild_id.to_owned(), user_id)) else { return Ok(None) };
		if self.saved >= self.max {
			return Ok(None);
		}
		let name = format!("{}-near.wav", wake.trim_end_matches(".wav"));
		let path = self.dir.join(&name);
		write_wav(&mut BufWriter::new(File::create(&path)?), samples)?;
		let mut list = OpenOptions::new().create(true).append(true).open(self.dir.join("near-misses.tsv"))?;
		writeln!(list, "{name}\t{wake}\t{score:.3}\t{before_ms}")?;
		self.saved += 1;
		Ok(Some(path))
	}

	/// Note what came of the speaker's last saved wake. Each wake has one
	/// outcome: later ones, such as for what they say back to the bot's
	/// answer, find nothing waiting and are dropped. Returns the clip's name.
	pub fn outcome(&mut self, guild_id: &str, user_id: u64, outcome: Outcome) -> std::io::Result<Option<String>> {
		let Some(name) = self.pending.remove(&(guild_id.to_owned(), user_id)) else { return Ok(None) };
		let mut list = OpenOptions::new().create(true).append(true).open(self.dir.join("outcomes.tsv"))?;
		writeln!(list, "{name}\t{}", outcome.as_str())?;
		Ok(Some(name))
	}

	pub fn dir(&self) -> &Path {
		&self.dir
	}
}

/// 16-bit PCM, mono, at [`SAMPLE_RATE`]: what the training scripts read.
pub fn write_wav(out: &mut impl Write, samples: &[f32]) -> std::io::Result<()> {
	let rate = SAMPLE_RATE;
	let data = u32::try_from(samples.len() * 2).unwrap_or(u32::MAX);
	out.write_all(b"RIFF")?;
	out.write_all(&(36 + data).to_le_bytes())?;
	out.write_all(b"WAVEfmt ")?;
	out.write_all(&16u32.to_le_bytes())?;
	out.write_all(&1u16.to_le_bytes())?; // PCM
	out.write_all(&1u16.to_le_bytes())?; // mono
	out.write_all(&rate.to_le_bytes())?;
	out.write_all(&(rate * 2).to_le_bytes())?; // bytes per second
	out.write_all(&2u16.to_le_bytes())?; // bytes per frame
	out.write_all(&16u16.to_le_bytes())?; // bits per sample
	out.write_all(b"data")?;
	out.write_all(&data.to_le_bytes())?;
	for &sample in samples {
		let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16;
		out.write_all(&value.to_le_bytes())?;
	}
	out.flush()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn scratch(name: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!("amhra-clips-{name}-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		dir
	}

	#[test]
	fn a_clip_is_a_wav_file_and_a_labelled_line() {
		let dir = scratch("save");
		let mut store = ClipStore::open(dir.clone(), 10).unwrap();
		let samples = vec![0.5f32; 16_000];
		let path = store.save("1", 42, &samples, 1_700_000_000_000).unwrap().unwrap();

		let bytes = std::fs::read(&path).unwrap();
		assert_eq!(&bytes[..4], b"RIFF");
		assert_eq!(&bytes[8..16], b"WAVEfmt ");
		assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 16_000);
		assert_eq!(bytes.len(), 44 + samples.len() * 2);
		assert_eq!(i16::from_le_bytes([bytes[44], bytes[45]]), i16::MAX / 2);

		let labels = std::fs::read_to_string(dir.join("clips.tsv")).unwrap();
		assert_eq!(labels, "1-42-1700000000000.wav\tEMHARA\n");
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn each_wake_has_one_outcome() {
		let dir = scratch("outcome");
		let mut store = ClipStore::open(dir.clone(), 10).unwrap();
		store.save("1", 42, &[0.0; 10], 100).unwrap();
		store.save("1", 7, &[0.0; 10], 101).unwrap();
		assert_eq!(store.outcome("1", 42, Outcome::Command).unwrap().as_deref(), Some("1-42-100.wav"));
		// Their answer to the bot, later, is not this wake's.
		assert_eq!(store.outcome("1", 42, Outcome::Silent).unwrap(), None);
		// Someone else's, and in another guild, are their own.
		assert_eq!(store.outcome("2", 7, Outcome::Silent).unwrap(), None);
		store.outcome("1", 7, Outcome::NoCommand).unwrap();

		let outcomes = std::fs::read_to_string(dir.join("outcomes.tsv")).unwrap();
		assert_eq!(outcomes, "1-42-100.wav\tcommand\n1-7-101.wav\tno-command\n");
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_near_miss_is_saved_beside_its_wake() {
		let dir = scratch("near");
		let mut store = ClipStore::open(dir.clone(), 10).unwrap();
		// No wake saved for them: nothing to pair it with.
		assert!(store.save_near_miss("1", 42, &[0.0; 10], 0.4, 2000).unwrap().is_none());

		store.save("1", 42, &[0.0; 10], 100).unwrap();
		let path = store.save_near_miss("1", 42, &[0.25; 10], 0.4, 2000).unwrap().unwrap();
		assert_eq!(path.file_name().unwrap(), "1-42-100-near.wav");
		assert_eq!(std::fs::read(&path).unwrap().len(), 44 + 20);
		let list = std::fs::read_to_string(dir.join("near-misses.tsv")).unwrap();
		assert_eq!(list, "1-42-100-near.wav\t1-42-100.wav\t0.400\t2000\n");
		// The wake's outcome is still to come.
		assert!(store.outcome("1", 42, Outcome::Command).unwrap().is_some());
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_full_store_saves_nothing_more_and_counts_what_was_there() {
		let dir = scratch("full");
		let mut store = ClipStore::open(dir.clone(), 2).unwrap();
		assert!(store.save("1", 1, &[0.0; 10], 1).unwrap().is_some());
		assert!(store.save("1", 1, &[0.0; 10], 2).unwrap().is_some());
		assert!(store.save("1", 1, &[0.0; 10], 3).unwrap().is_none());

		// Reopened, it remembers it is full.
		let mut store = ClipStore::open(dir.clone(), 2).unwrap();
		assert!(store.save("1", 1, &[0.0; 10], 4).unwrap().is_none());
		assert_eq!(std::fs::read_to_string(dir.join("clips.tsv")).unwrap().lines().count(), 2);
		std::fs::remove_dir_all(dir).unwrap();
	}
}
