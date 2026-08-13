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

use crate::dsp::Crossfader;

/// How often a standby track is refreshed while it waits, in ticks. Once a
/// second is enough to keep its buffer warm without stat-ing on every frame.
const STANDBY_REFRESH_TICKS: u32 = 50;

/// What the caller should do with this tick.
#[derive(Debug)]
pub enum Tick<'a> {
	/// Send this Opus packet, then advance the RTP clock by `samples`.
	Frame { bytes: &'a [u8], samples: u32 },
	/// A track is playing but its audio has not arrived yet. Send nothing and
	/// keep the speaking state: this is a stall, not an ending.
	Starving,
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

	/// Whether a fade is running right now.
	pub fn is_fading(&self) -> bool {
		self.fade.is_some()
	}

	/// Start a track now, replacing whatever was playing.
	pub fn play(&mut self, id: impl Into<String>, reader: CacheReader) {
		self.active = Some(Slot { id: id.into(), reader, started: false });
		self.starving = false;
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
		if self.fades.skip_fade_ms > 0 && self.standby.is_some() && self.active.is_some() {
			self.fade = Some(Fade { elapsed_ms: 0, total_ms: self.fades.skip_fade_ms as u32 });
			return;
		}
		if let Some(finished) = self.active.take() {
			self.events.push(Event::Finished(finished.id));
		}
		self.promote();
	}

	pub fn stop(&mut self) {
		if let Some(finished) = self.active.take() {
			self.events.push(Event::Finished(finished.id));
		}
		self.standby = None;
	}

	pub fn seek(&mut self, timestamp_ms: u32) -> Option<u32> {
		let slot = self.active.as_mut()?;
		self.starving = false;
		Some(slot.reader.seek(timestamp_ms))
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
		// Keep the next track's buffer warm so the switch never lands on an
		// empty reader.
		if self.ticks.is_multiple_of(STANDBY_REFRESH_TICKS)
			&& let Some(standby) = self.standby.as_mut()
		{
			let _ = standby.reader.refresh();
		}

		if self.active.is_none() {
			self.promote();
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
				if !self.starving {
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
	use std::io::Write;
	use std::path::PathBuf;

	fn size_vint(value: u64) -> Vec<u8> {
		for width in 1..=8u32 {
			let max = (1u64 << (7 * width)) - 1;
			if value < max {
				let marked = value | (1u64 << (7 * width));
				return marked.to_be_bytes()[8 - width as usize..].to_vec();
			}
		}
		unreachable!()
	}

	fn element(id: &[u8], payload: &[u8]) -> Vec<u8> {
		let mut out = Vec::new();
		out.extend_from_slice(id);
		out.extend_from_slice(&size_vint(payload.len() as u64));
		out.extend_from_slice(payload);
		out
	}

	/// A WebM/Opus file whose every frame is filled with `marker`, so a test
	/// can tell which track a packet came from.
	fn webm(frames: usize, marker: u8) -> Vec<u8> {
		let mut head = Vec::from(*b"OpusHead");
		head.extend_from_slice(&[1, 2]);
		head.extend_from_slice(&312u16.to_le_bytes());
		head.extend_from_slice(&48_000u32.to_le_bytes());
		head.extend_from_slice(&0i16.to_le_bytes());
		head.push(0);

		let mut entry = element(&[0xd7], &[1]);
		entry.extend_from_slice(&element(&[0x86], b"A_OPUS"));
		entry.extend_from_slice(&element(&[0x63, 0xa2], &head));

		let mut segment = element(&[0x15, 0x49, 0xa9, 0x66], &element(
			&[0x2a, 0xd7, 0xb1],
			&1_000_000u32.to_be_bytes(),
		));
		segment.extend_from_slice(&element(&[0x16, 0x54, 0xae, 0x6b], &element(&[0xae], &entry)));

		let mut payload = element(&[0xe7], &0u16.to_be_bytes());
		for frame in 0..frames {
			let mut block = vec![0x81];
			block.extend_from_slice(&((frame * 20) as i16).to_be_bytes());
			block.push(0x80);
			block.push(0xfc);
			block.extend_from_slice(&[marker; 19]);
			payload.extend_from_slice(&element(&[0xa3], &block));
		}
		segment.extend_from_slice(&element(&[0x1f, 0x43, 0xb6, 0x75], &payload));

		let mut file = element(&[0x1a, 0x45, 0xdf, 0xa3], &[0x42, 0x86, 0x81, 0x01]);
		file.extend_from_slice(&element(&[0x18, 0x53, 0x80, 0x67], &segment));
		file
	}

	fn temp_path(name: &str) -> PathBuf {
		let mut path = std::env::temp_dir();
		path.push(format!("amhra-player-{name}-{}.music", std::process::id()));
		path
	}

	/// A reader over a finished file.
	fn reader(name: &str, frames: usize, marker: u8) -> (CacheReader, PathBuf) {
		let path = temp_path(name);
		std::fs::write(&path, webm(frames, marker)).unwrap();
		let mut reader = CacheReader::open_path(&path, None).unwrap();
		reader.mark_complete();
		(reader, path)
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
