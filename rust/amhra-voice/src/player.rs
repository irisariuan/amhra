//! Two-slot playback: what to send on this 20ms tick, and nothing else.
//!
//! The player holds an ACTIVE track and an optional STANDBY one. When ACTIVE
//! runs out, STANDBY takes over *on the same tick* — the caller asks for a
//! frame and gets one, rather than getting nothing and asking again 20ms later.
//! That single property is what makes the seam inaudible, because the RTP clock
//! and the listener's jitter buffer never see a gap.
//!
//! Three things are deliberately not done here:
//!
//! - The queue is not modelled. The caller decides what plays next and hands it
//!   over; this only decides *when* the switch happens.
//! - Running out of buffered audio is not the end of a track. A file still
//!   downloading is refreshed and reported as starving, so the caller can hold
//!   the speaking state instead of announcing the song ended.
//! - No frame is copied. A frame is a slice of the mapped cache file.

use amhra_audio::{CacheReader, packet_info};

use crate::dsp::{Crossfader, DspError, MAX_SAMPLES, UNITY_EPSILON, encoder};
use crate::stretch::{HOP, MAX_SPEED, Stretcher};

/// How often a track still downloading is refreshed, in ticks. Once a second
/// is enough to keep its buffer warm without stat-ing on every frame.
const STANDBY_REFRESH_TICKS: u32 = 50;

/// What the caller should do with this tick.
#[derive(Debug)]
pub enum Tick<'a> {
	/// Send this Opus packet, then advance the RTP clock by `samples`.
	Frame { bytes: &'a [u8], samples: u32 },
	/// A track is playing but its audio has not arrived yet. Send nothing and
	/// keep the speaking state: this is a stall, not an ending.
	Starving,
	/// A track is loaded at speed zero: send nothing, consume nothing, and
	/// do not call it a stall or an ending.
	Held,
	/// Nothing is loaded.
	Idle,
}

/// Something the caller may want to report or act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
	Started(String),
	Finished(String),
	/// Ran dry mid-track; the download has not kept up.
	Starved(String),
}

struct Slot {
	id: String,
	reader: CacheReader,
	started: bool,
}

impl std::fmt::Debug for Slot {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Slot").field("id", &self.id).field("started", &self.started).finish()
	}
}

/// How long a track change takes, and how long a skip does.
#[derive(Debug, Clone, Copy)]
pub struct FadeSettings {
	/// Overlap at a natural end-of-track. Zero is a hard cut.
	pub crossfade_ms: u16,
	/// Overlap when the listener skips. Deliberately much shorter: a skip
	/// should feel immediate, not like waiting out a mix.
	pub skip_fade_ms: u16,
}

impl Default for FadeSettings {
	fn default() -> Self {
		Self { crossfade_ms: 0, skip_fade_ms: 40 }
	}
}

/// A fade in progress.
#[derive(Debug, Clone, Copy)]
struct Fade {
	elapsed_ms: u32,
	total_ms: u32,
}

#[derive(Debug, Default)]
pub struct Player {
	active: Option<Slot>,
	standby: Option<Slot>,
	events: Vec<Event>,
	ticks: u32,
	/// True once the current track reported starving, so the event is not
	/// repeated fifty times a second.
	starving: bool,
	fades: FadeSettings,
	fade: Option<Fade>,
	/// Built on the first fade and kept afterwards, since a queue that fades
	/// once will fade again.
	fader: Option<Crossfader>,
	/// Frames copied out of the two readers so the mixer can borrow neither.
	scratch_a: Vec<u8>,
	scratch_b: Vec<u8>,
	/// Playback speed, 0 to 10. At 1 frames pass through untouched.
	speed: Speed,
	/// Built the first time the speed leaves 1, dropped when it returns.
	stretch: Option<Box<SpeedCodec>>,
}

/// The speed, defaulting to 1 rather than the 0 `Default` would give a float.
#[derive(Debug, Clone, Copy)]
struct Speed(f32);

impl Default for Speed {
	fn default() -> Self {
		Self(1.0)
	}
}

/// What playing at another speed costs: a decode, the stretch, an encode.
struct SpeedCodec {
	decoder: opus::Decoder,
	encoder: opus::Encoder,
	stretcher: Stretcher,
	pcm: Vec<i16>,
	frame: Vec<i16>,
	encoded: Vec<u8>,
	written: usize,
}

impl std::fmt::Debug for SpeedCodec {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("SpeedCodec").field("stretcher", &self.stretcher).finish_non_exhaustive()
	}
}

impl SpeedCodec {
	fn new(speed: f32) -> Result<Self, DspError> {
		Ok(Self {
			decoder: opus::Decoder::new(amhra_audio::opus::SAMPLE_RATE, opus::Channels::Stereo)?,
			encoder: encoder()?,
			stretcher: Stretcher::new(speed as f64),
			pcm: vec![0; MAX_SAMPLES],
			frame: vec![0; HOP * 2],
			encoded: vec![0; 4000],
			written: 0,
		})
	}

	/// Decode a packet into the stretcher. A packet that will not decode is
	/// left out: a 20ms hole is better than ending the track over it.
	fn feed(&mut self, packet: &[u8]) {
		if let Ok(samples) = self.decoder.decode(packet, &mut self.pcm, false) {
			self.stretcher.push(&self.pcm[..samples * 2]);
		}
	}

	/// Stretch and encode the next frame, once there is enough input.
	fn encode_next(&mut self) -> Result<bool, DspError> {
		if !self.stretcher.next_frame(&mut self.frame) {
			return Ok(false);
		}
		self.written = self.encoder.encode(&self.frame, &mut self.encoded)?;
		Ok(true)
	}

	fn output(&self) -> &[u8] {
		&self.encoded[..self.written]
	}
}

impl Player {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn with_fades(fades: FadeSettings) -> Self {
		Self { fades, ..Self::default() }
	}

	pub fn set_fades(&mut self, fades: FadeSettings) {
		self.fades = fades;
	}

	pub fn fades(&self) -> FadeSettings {
		self.fades
	}

	/// Set the playback speed, 0 to 10, pitch kept. 1 passes frames through
	/// untouched; 0 holds the track where it is and sends nothing.
	///
	/// Crossfades and skip fades are left out while it is not 1: they mix
	/// frames as they are stored, which would jump back to normal speed for
	/// the length of the seam.
	pub fn set_speed(&mut self, speed: f32) {
		let speed = if speed.is_finite() { speed.clamp(0.0, MAX_SPEED as f32) } else { 1.0 };
		self.speed = Speed(speed);
		if self.is_unity_speed() {
			// What the stretcher still held is a few tens of milliseconds the
			// reader has already moved past; dropping it is a skip too short
			// to hear, against holding a codec for nothing.
			self.stretch = None;
			return;
		}
		// A seam already mixing is finished at once rather than left half done.
		if self.fade.is_some() {
			self.finish_fade();
		}
		if speed > 0.0
			&& let Some(codec) = self.stretch.as_mut()
		{
			codec.stretcher.set_speed(speed as f64);
		}
	}

	pub fn speed(&self) -> f32 {
		self.speed.0
	}

	fn is_unity_speed(&self) -> bool {
		(self.speed.0 - 1.0).abs() < UNITY_EPSILON
	}

	/// Forget what the stretcher held, for a jump in what is playing.
	fn reset_stretch(&mut self) {
		if let Some(codec) = self.stretch.as_mut() {
			codec.stretcher.reset();
		}
	}

	/// Whether a fade is running right now.
	pub fn is_fading(&self) -> bool {
		self.fade.is_some()
	}

	/// Start a track now, replacing whatever was playing.
	pub fn play(&mut self, id: impl Into<String>, reader: CacheReader) {
		self.active = Some(Slot { id: id.into(), reader, started: false });
		self.starving = false;
		self.reset_stretch();
	}

	/// Queue the track to follow, replacing any previous standby.
	///
	/// Safe to call repeatedly — the queue head changing is exactly when it
	/// should be called — because nothing is consumed until the switch.
	pub fn set_next(&mut self, id: impl Into<String>, reader: CacheReader) {
		self.standby = Some(Slot { id: id.into(), reader, started: false });
	}

	pub fn clear_next(&mut self) {
		self.standby = None;
	}

	/// Drop the current track and move to the standby one immediately.
	pub fn skip(&mut self) {
		// A skip with a fade keeps both tracks for a moment; without one it is
		// the old behaviour of dropping straight to the next.
		if self.fades.skip_fade_ms > 0 && self.is_unity_speed() && self.standby.is_some() && self.active.is_some() {
			self.fade = Some(Fade { elapsed_ms: 0, total_ms: self.fades.skip_fade_ms as u32 });
			return;
		}
		if let Some(finished) = self.active.take() {
			self.events.push(Event::Finished(finished.id));
		}
		self.promote();
		self.reset_stretch();
	}

	pub fn stop(&mut self) {
		if let Some(finished) = self.active.take() {
			self.events.push(Event::Finished(finished.id));
		}
		self.standby = None;
		self.reset_stretch();
	}

	pub fn seek(&mut self, timestamp_ms: u32) -> Option<u32> {
		let slot = self.active.as_mut()?;
		self.starving = false;
		let landed = slot.reader.seek(timestamp_ms);
		self.reset_stretch();
		Some(landed)
	}

	pub fn position_ms(&self) -> u32 {
		self.active.as_ref().map_or(0, |slot| slot.reader.position_ms())
	}

	pub fn current_id(&self) -> Option<&str> {
		self.active.as_ref().map(|slot| slot.id.as_str())
	}

	pub fn is_idle(&self) -> bool {
		self.active.is_none()
	}

	/// Take everything worth reporting since the last call.
	pub fn drain_events(&mut self) -> Vec<Event> {
		std::mem::take(&mut self.events)
	}

	/// Produce this tick's audio.
	pub fn tick(&mut self) -> Tick<'_> {
		self.ticks = self.ticks.wrapping_add(1);
		if self.ticks.is_multiple_of(STANDBY_REFRESH_TICKS) {
			// Keep the next track's buffer warm so the switch never lands on
			// an empty reader.
			if let Some(standby) = self.standby.as_mut() {
				let _ = standby.reader.refresh();
			}
			// And notice the playing track's download finishing before its
			// end, not at it: a crossfade has to know where the end is while
			// there is still time to start one.
			if let Some(active) = self.active.as_mut()
				&& !active.reader.is_complete()
			{
				let _ = active.reader.refresh();
			}
		}

		if self.active.is_none() {
			self.promote();
		}

		if !self.is_unity_speed() {
			return self.tick_at_speed();
		}

		// A fade needs a frame from each track at once, which no borrow of a
		// single slot can give, so it is mixed into the fader's own buffer and
		// only borrowed from there once every slot borrow has ended.
		if self.fade.is_none() && self.should_start_crossfade() {
			self.fade = Some(Fade { elapsed_ms: 0, total_ms: self.fades.crossfade_ms as u32 });
		}
		if self.fade.is_some()
			&& let Some(samples) = self.mix_fade_frame()
		{
			let bytes = self.fader.as_ref().expect("mixed above").output();
			return Tick::Frame { bytes, samples };
		}

		// Resolved before borrowing the reader for the frame, because the
		// answer decides whether the frame even comes from this slot.
		match self.step() {
			Step::Play => {
				let slot = self.active.as_mut().expect("step said play");
				if !slot.started {
					slot.started = true;
					self.events.push(Event::Started(slot.id.clone()));
				}
				self.starving = false;
				let (bytes, _) = slot.reader.next_frame().expect("step checked a frame is ready");
				let samples = packet_info(bytes).map_or(960, |info| info.samples());
				Tick::Frame { bytes, samples }
			}
			Step::Starve => Tick::Starving,
			Step::Idle => Tick::Idle,
		}
	}

	/// This tick's audio at a speed other than 1: as many stored frames as
	/// the stretcher needs, one frame out.
	///
	/// The switch to the next track happens inside the loop, the same way it
	/// does at normal speed, so the stretcher carries straight across the seam.
	fn tick_at_speed(&mut self) -> Tick<'_> {
		if self.speed.0 <= 0.0 {
			return if self.active.is_none() { Tick::Idle } else { Tick::Held };
		}
		if self.stretch.is_none() {
			match SpeedCodec::new(self.speed.0) {
				Ok(codec) => self.stretch = Some(Box::new(codec)),
				// Without a codec the honest outcome is normal speed.
				Err(_) => {
					self.speed = Speed(1.0);
					return self.tick();
				}
			}
		}
		loop {
			match self.stretch.as_mut().expect("built above").encode_next() {
				Ok(true) => break,
				Ok(false) => {}
				Err(_) => return Tick::Starving,
			}
			match self.step() {
				Step::Play => {
					let Self { active, stretch, events, starving, .. } = self;
					let slot = active.as_mut().expect("step said play");
					if !slot.started {
						slot.started = true;
						events.push(Event::Started(slot.id.clone()));
					}
					*starving = false;
					let (bytes, _) = slot.reader.next_frame().expect("step checked a frame is ready");
					stretch.as_mut().expect("built above").feed(bytes);
				}
				Step::Starve => return Tick::Starving,
				Step::Idle => {
					self.reset_stretch();
					return Tick::Idle;
				}
			}
		}
		let bytes = self.stretch.as_ref().expect("built above").output();
		Tick::Frame { bytes, samples: HOP as u32 }
	}

	/// Whether the active track is close enough to its end to start mixing.
	///
	/// Needs a known duration: without one there is no way to know the end is
	/// coming, and a fade that starts too late is worse than none. A track
	/// whose length the container never declared simply hard-cuts.
	fn should_start_crossfade(&self) -> bool {
		if self.fades.crossfade_ms == 0 || self.standby.is_none() {
			return false;
		}
		let Some(slot) = self.active.as_ref() else { return false };
		// Only a finished download can be faded out of: a track still
		// arriving might yet turn out to be longer than it looks.
		if !slot.reader.is_complete() {
			return false;
		}
		let Some(duration) = slot.reader.duration_ms() else { return false };
		duration.saturating_sub(slot.reader.position_ms()) <= self.fades.crossfade_ms as u32
	}

	/// Mix one frame into the fader's buffer, returning its sample count.
	///
	/// `None` means the fade is over — either it ran its length or a side ran
	/// dry — and the caller should fall through to normal playback.
	fn mix_fade_frame(&mut self) -> Option<u32> {
		let fade = self.fade?;

		// Both frames are copied out before mixing: the mixer lives on `self`,
		// and it cannot borrow it while two readers on `self` are also
		// borrowed. This is the only place in playback that copies, and it
		// happens for the length of a seam.
		let outgoing = {
			let slot = self.active.as_mut()?;
			match slot.reader.next_frame() {
				Some((bytes, _)) => {
					self.scratch_a.clear();
					self.scratch_a.extend_from_slice(bytes);
					true
				}
				None => false,
			}
		};
		let incoming = {
			let slot = self.standby.as_mut()?;
			match slot.reader.next_frame() {
				Some((bytes, _)) => {
					self.scratch_b.clear();
					self.scratch_b.extend_from_slice(bytes);
					true
				}
				None => false,
			}
		};

		// Either side running dry ends the fade early rather than stalling it:
		// the listener hears a shorter blend, not a gap.
		if !outgoing || !incoming || fade.elapsed_ms >= fade.total_ms {
			self.finish_fade();
			return None;
		}

		if self.fader.is_none() {
			match Crossfader::new() {
				Ok(fader) => self.fader = Some(fader),
				// Without a mixer the honest outcome is a hard cut.
				Err(_) => {
					self.finish_fade();
					return None;
				}
			}
		}

		let progress = fade.elapsed_ms as f32 / fade.total_ms.max(1) as f32;
		self.fade = Some(Fade { elapsed_ms: fade.elapsed_ms + 20, ..fade });

		// The incoming track is audible from here, so it counts as started.
		if let Some(slot) = self.standby.as_mut()
			&& !slot.started
		{
			slot.started = true;
			let id = slot.id.clone();
			self.events.push(Event::Started(id));
		}

		let Self { fader, scratch_a, scratch_b, .. } = self;
		let fader = fader.as_mut().expect("built above");
		match fader.mix(scratch_a, scratch_b, progress) {
			Ok(bytes) => Some(packet_info(bytes).map_or(960, |info| info.samples())),
			Err(_) => {
				self.finish_fade();
				None
			}
		}
	}

	/// End a fade: the outgoing track is done and the incoming one takes over
	/// from wherever the mix left it.
	fn finish_fade(&mut self) {
		self.fade = None;
		if let Some(finished) = self.active.take() {
			self.events.push(Event::Finished(finished.id));
		}
		self.promote();
	}

	/// Decide what this tick can do, moving between slots as needed.
	///
	/// Kept separate from `tick` so the borrow of the reader for the returned
	/// frame does not overlap the mutation of the slots.
	fn step(&mut self) -> Step {
		for _ in 0..2 {
			let Some(slot) = self.active.as_mut() else { return Step::Idle };

			if !slot.reader.is_drained() {
				return Step::Play;
			}

			// Out of demuxed audio. Either more has landed, or the track is
			// genuinely over, or the download is behind.
			let grew = slot.reader.refresh().unwrap_or(false);
			if grew && !slot.reader.is_drained() {
				return Step::Play;
			}

			if !slot.reader.is_complete() {
				// A track yet to play its first frame is buffering, not stalled:
				// a stream starts with nothing, and saying so would cry wolf at
				// the top of every track.
				if !self.starving && slot.started {
					self.starving = true;
					self.events.push(Event::Starved(slot.id.clone()));
				}
				return Step::Starve;
			}

			// Genuinely finished: hand over on this same tick so the listener
			// hears no gap between the last frame of one track and the first of
			// the next.
			let finished = self.active.take().expect("checked above");
			self.events.push(Event::Finished(finished.id));
			self.promote();
			if self.active.is_none() {
				return Step::Idle;
			}
		}
		Step::Idle
	}

	fn promote(&mut self) {
		self.active = self.standby.take();
		self.starving = false;
	}
}

enum Step {
	Play,
	Starve,
	Idle,
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::test_support;
	use std::io::Write;
	use std::path::PathBuf;

	/// A WebM/Opus file whose every frame is filled with `marker`, so a test
	/// can tell which track a packet came from.
	fn webm(frames: usize, marker: u8) -> Vec<u8> {
		test_support::webm(&vec![test_support::marker_packet(marker); frames])
	}

	fn temp_path(name: &str) -> PathBuf {
		test_support::temp_path(&format!("player-{name}"))
	}

	/// A reader over a finished file.
	fn reader(name: &str, frames: usize, marker: u8) -> (CacheReader, PathBuf) {
		test_support::reader(&format!("player-{name}"), &vec![test_support::marker_packet(marker); frames])
	}

	#[test]
	fn plays_frames_in_order_then_goes_idle() {
		let (source, path) = reader("basic", 5, 0xaa);
		let mut player = Player::new();
		player.play("a", source);

		for _ in 0..5 {
			let Tick::Frame { bytes, samples } = player.tick() else {
				panic!("expected a frame");
			};
			assert_eq!(bytes[1], 0xaa);
			assert_eq!(samples, 960);
		}
		assert!(matches!(player.tick(), Tick::Idle));
		assert!(player.is_idle());

		let events = player.drain_events();
		assert_eq!(events[0], Event::Started("a".to_owned()));
		assert!(events.contains(&Event::Finished("a".to_owned())));
		std::fs::remove_file(&path).ok();
	}

	/// The point of the whole module: no tick is wasted at a track boundary.
	#[test]
	fn the_switch_costs_no_tick() {
		let (first, first_path) = reader("gapless-a", 3, 0x11);
		let (second, second_path) = reader("gapless-b", 3, 0x22);

		let mut player = Player::new();
		player.play("a", first);
		player.set_next("b", second);

		let mut markers = Vec::new();
		for _ in 0..6 {
			let Tick::Frame { bytes, .. } = player.tick() else {
				panic!("a gap appeared at the seam");
			};
			markers.push(bytes[1]);
		}
		// Three frames of the first track, then straight into the second, with
		// no Starving or Idle tick in between.
		assert_eq!(markers, vec![0x11, 0x11, 0x11, 0x22, 0x22, 0x22]);

		let events = player.drain_events();
		assert!(events.contains(&Event::Finished("a".to_owned())));
		assert!(events.contains(&Event::Started("b".to_owned())));
		std::fs::remove_file(&first_path).ok();
		std::fs::remove_file(&second_path).ok();
	}

	#[test]
	fn a_download_falling_behind_starves_rather_than_ending_the_track() {
		let path = temp_path("starve");
		let whole = webm(10, 0x33);
		// Only part of the file has landed, and it is not marked complete.
		std::fs::write(&path, &whole[..whole.len() * 2 / 3]).unwrap();
		let partial = CacheReader::open_path(&path, None).unwrap();

		let mut player = Player::new();
		player.play("slow", partial);
		while matches!(player.tick(), Tick::Frame { .. }) {}

		assert!(matches!(player.tick(), Tick::Starving), "a stall must not read as idle");
		assert!(!player.is_idle(), "the track is still loaded");
		assert!(player.drain_events().contains(&Event::Starved("slow".to_owned())));

		// The rest arrives and playback resumes without the caller doing
		// anything.
		let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
		file.write_all(&whole[whole.len() * 2 / 3..]).unwrap();
		file.sync_data().unwrap();
		assert!(matches!(player.tick(), Tick::Frame { .. }), "playback should resume");
		std::fs::remove_file(&path).ok();
	}

	/// The common case, not an edge one: a track starts playing from its
	/// temp file a moment after the download begins. When the download is
	/// renamed into place the track has to end normally, or playback goes
	/// silent at its end and the queue never moves on.
	#[test]
	fn a_track_started_mid_download_finishes_once_the_download_does() {
		let mut dir = std::env::temp_dir();
		dir.push(format!("amhra-player-published-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let temp = dir.join("song.temp.music");
		let whole = webm(10, 0x5a);
		let part = whole.len() * 2 / 3;
		std::fs::write(&temp, &whole[..part]).unwrap();

		let mut player = Player::new();
		player.play("song", CacheReader::open(&dir, "song").unwrap());
		while matches!(player.tick(), Tick::Frame { .. }) {}

		let mut file = std::fs::OpenOptions::new().append(true).open(&temp).unwrap();
		file.write_all(&whole[part..]).unwrap();
		file.sync_data().unwrap();
		drop(file);
		std::fs::rename(&temp, dir.join("song.music")).unwrap();

		let mut ended = false;
		for _ in 0..20 {
			if matches!(player.tick(), Tick::Idle) {
				ended = true;
				break;
			}
		}
		assert!(ended, "the track should end, not wait for a download that is done");
		assert!(player.drain_events().contains(&Event::Finished("song".to_owned())));
		std::fs::remove_dir_all(&dir).ok();
	}

	#[test]
	fn starving_is_reported_once_not_every_tick() {
		let path = temp_path("noisy");
		let whole = webm(10, 0x44);
		std::fs::write(&path, &whole[..whole.len() / 2]).unwrap();
		let mut player = Player::new();
		player.play("quiet", CacheReader::open_path(&path, None).unwrap());
		while matches!(player.tick(), Tick::Frame { .. }) {}

		for _ in 0..20 {
			player.tick();
		}
		let starved = player
			.drain_events()
			.into_iter()
			.filter(|event| matches!(event, Event::Starved(_)))
			.count();
		assert_eq!(starved, 1, "one stall should not produce twenty events");
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn skip_without_a_fade_lands_on_the_next_track_at_once() {
		let (first, first_path) = reader("skip-a", 100, 0x55);
		let (second, second_path) = reader("skip-b", 5, 0x66);

		// With the fade disabled the next track's own bytes appear untouched;
		// the blended case is covered by a_skip_fade_blends_instead_of_cutting.
		let mut player = Player::with_fades(FadeSettings { crossfade_ms: 0, skip_fade_ms: 0 });
		player.play("a", first);
		player.set_next("b", second);
		player.tick();
		player.skip();

		let Tick::Frame { bytes, .. } = player.tick() else { panic!("expected a frame") };
		assert_eq!(bytes[1], 0x66, "skip should land on the next track at once");
		assert_eq!(player.current_id(), Some("b"));
		std::fs::remove_file(&first_path).ok();
		std::fs::remove_file(&second_path).ok();
	}

	#[test]
	fn seeking_moves_playback_and_keeps_the_track() {
		let (source, path) = reader("seek", 100, 0x77);
		let mut player = Player::new();
		player.play("a", source);
		for _ in 0..10 {
			player.tick();
		}
		assert_eq!(player.position_ms(), 200);

		let landed = player.seek(1_000).expect("a track is playing");
		assert_eq!(landed, 1_000);
		assert_eq!(player.position_ms(), 1_000);
		assert!(matches!(player.tick(), Tick::Frame { .. }));
		std::fs::remove_file(&path).ok();
	}

	/// A file of real Opus frames of a steady tone, for the paths that decode.
	fn tone_reader(name: &str, frames: usize) -> (CacheReader, PathBuf) {
		test_support::reader(&format!("player-{name}"), &vec![test_support::tone_packet(8000); frames])
	}

	#[test]
	fn double_speed_reads_two_frames_a_tick() {
		let (source, path) = tone_reader("speed2", 200);
		let mut player = Player::new();
		player.set_speed(2.0);
		player.play("a", source);
		for _ in 0..50 {
			assert!(matches!(player.tick(), Tick::Frame { samples: 960, .. }));
		}
		// A second of output from about two seconds of track, give or take
		// what the stretcher holds.
		let position = player.position_ms();
		assert!((1_900..=2_100).contains(&position), "at {position}ms");
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn half_speed_reads_a_frame_every_other_tick() {
		let (source, path) = tone_reader("speed05", 200);
		let mut player = Player::new();
		player.set_speed(0.5);
		player.play("a", source);
		for _ in 0..100 {
			assert!(matches!(player.tick(), Tick::Frame { .. }));
		}
		let position = player.position_ms();
		assert!((950..=1_100).contains(&position), "at {position}ms");
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn speed_zero_holds_the_track_without_ending_it() {
		let (source, path) = tone_reader("speed0", 50);
		let mut player = Player::new();
		player.play("a", source);
		player.tick();
		player.set_speed(0.0);
		for _ in 0..20 {
			assert!(matches!(player.tick(), Tick::Held));
		}
		assert_eq!(player.position_ms(), 20, "nothing should be consumed while held");
		assert!(!player.is_idle());
		player.set_speed(1.0);
		assert!(matches!(player.tick(), Tick::Frame { .. }));
		std::fs::remove_file(&path).ok();
	}

	#[test]
	fn a_fast_track_still_hands_over_to_the_next() {
		let (first, first_path) = tone_reader("speedseam-a", 20);
		let (second, second_path) = tone_reader("speedseam-b", 200);
		let mut player = Player::new();
		player.set_speed(4.0);
		player.play("a", first);
		player.set_next("b", second);
		for _ in 0..10 {
			assert!(matches!(player.tick(), Tick::Frame { .. }), "a gap appeared at the seam");
		}
		assert_eq!(player.current_id(), Some("b"));
		let events = player.drain_events();
		assert!(events.contains(&Event::Finished("a".to_owned())));
		assert!(events.contains(&Event::Started("b".to_owned())));
		std::fs::remove_file(&first_path).ok();
		std::fs::remove_file(&second_path).ok();
	}

	#[test]
	fn back_to_normal_speed_passes_frames_through_again() {
		let (source, path) = reader("speedback", 100, 0x77);
		let mut player = Player::new();
		player.play("a", source);
		player.set_speed(1.5);
		player.set_speed(1.0);
		let Tick::Frame { bytes, .. } = player.tick() else { panic!("expected a frame") };
		assert_eq!(bytes[1], 0x77, "unity speed should not re-encode");
		std::fs::remove_file(&path).ok();
	}

	/// A file with a declared duration, which crossfading requires.
	fn faded_player(crossfade_ms: u16) -> Player {
		Player::with_fades(FadeSettings { crossfade_ms, skip_fade_ms: 40 })
	}

	#[test]
	fn zero_crossfade_keeps_the_hard_cut() {
		let (first, first_path) = reader("nofade-a", 3, 0x11);
		let (second, second_path) = reader("nofade-b", 3, 0x22);
		let mut player = faded_player(0);
		player.play("a", first);
		player.set_next("b", second);

		let mut markers = Vec::new();
		for _ in 0..6 {
			if let Tick::Frame { bytes, .. } = player.tick() {
				markers.push(bytes[1]);
			}
		}
		// Untouched frames on both sides: nothing was decoded or re-encoded.
		assert_eq!(markers, vec![0x11, 0x11, 0x11, 0x22, 0x22, 0x22]);
		assert!(!player.is_fading());
		std::fs::remove_file(&first_path).ok();
		std::fs::remove_file(&second_path).ok();
	}

	#[test]
	fn a_skip_fade_blends_instead_of_cutting() {
		let (first, first_path) = reader("skipfade-a", 100, 0x33);
		let (second, second_path) = reader("skipfade-b", 100, 0x44);
		let mut player = faded_player(0);
		player.play("a", first);
		player.set_next("b", second);
		player.tick();

		player.skip();
		assert!(player.is_fading(), "a skip with a fade configured should blend");

		// Two frames of 20ms covers the default 40ms skip fade, and every tick
		// through it must still produce audio.
		let mut frames = 0;
		for _ in 0..4 {
			if matches!(player.tick(), Tick::Frame { .. }) {
				frames += 1;
			}
		}
		assert_eq!(frames, 4, "a fade must not drop ticks");
		assert!(!player.is_fading(), "the fade should have ended");
		assert_eq!(player.current_id(), Some("b"));
		std::fs::remove_file(&first_path).ok();
		std::fs::remove_file(&second_path).ok();
	}

	#[test]
	fn a_fade_ends_early_rather_than_stalling_when_a_side_runs_dry() {
		// The incoming track has only one frame, far less than the fade needs.
		let (first, first_path) = reader("dry-a", 50, 0x55);
		let (second, second_path) = reader("dry-b", 1, 0x66);
		let mut player = faded_player(0);
		player.play("a", first);
		player.set_next("b", second);
		player.tick();
		player.skip();

		for _ in 0..6 {
			player.tick();
		}
		// It resolved rather than sitting in a half-mixed state forever.
		assert!(!player.is_fading());
		std::fs::remove_file(&first_path).ok();
		std::fs::remove_file(&second_path).ok();
	}

	#[test]
	fn a_queued_track_can_be_replaced_before_it_starts() {
		let (first, first_path) = reader("replace-a", 2, 0x01);
		let (second, second_path) = reader("replace-b", 2, 0x02);
		let (third, third_path) = reader("replace-c", 2, 0x03);

		let mut player = Player::new();
		player.play("a", first);
		player.set_next("b", second);
		// The queue changed before the switch happened.
		player.set_next("c", third);

		let mut markers = Vec::new();
		for _ in 0..4 {
			if let Tick::Frame { bytes, .. } = player.tick() {
				markers.push(bytes[1]);
			}
		}
		assert_eq!(markers, vec![0x01, 0x01, 0x03, 0x03], "the last set_next should win");
		std::fs::remove_file(&first_path).ok();
		std::fs::remove_file(&second_path).ok();
		std::fs::remove_file(&third_path).ok();
	}
}
