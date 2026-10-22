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
//! Only guilds that turned voice commands on are heard at all, and the bot
//! tells their members this is being kept.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use super::SAMPLE_RATE;

/// What every clip is labelled until someone listens to it.
pub const LABEL: &str = "EMHARA";

/// A directory of saved wake clips, with a cap on how many it will hold.
#[derive(Debug)]
pub struct ClipStore {
	dir: PathBuf,
	max: usize,
	saved: usize,
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
		Ok(Self { dir, max, saved })
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
		Ok(Some(path))
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
