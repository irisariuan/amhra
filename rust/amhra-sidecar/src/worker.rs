//! One guild's audio thread.
//!
//! Everything time-critical happens here and nowhere else: the 20ms tick, the
//! frame, the mix, the two encryptions, the send. The thread owns its player
//! and its socket outright, so a tick is a handful of function calls and one
//! syscall, with nothing to await and nothing to lock except the DAVE session —
//! which the gateway task must also touch when the group rekeys.
//!
//! The stack is set small deliberately. The default 8MB per thread is address
//! space rather than memory, but it is reserved per guild, and this loop needs
//! kilobytes.
//!
//! Falling behind is handled by dropping, not by catching up: if a tick is
//! late, the next deadline is computed from the clock rather than from the last
//! tick, so a stalled thread resumes in sync instead of playing a burst of
//! backlogged audio.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use amhra_audio::CacheReader;
use amhra_voice::dave::driver::Driver;
use amhra_voice::dsp::Volume;
use amhra_voice::mixer::{Frame, MAX_QUEUES, Mixer};
use amhra_voice::player::{Event as PlayerEvent, FadeSettings, Player, Tick};
use amhra_voice::{SILENCE_FRAME, Session};

use crate::listen::{self, ListenHandle, ListenSetup};
use crate::protocol::Event;
use crate::wake_feedback::{Clip, Clips, Duck, FRAME_PCM, Then, Waits};

/// One audio frame's worth of time.
const TICK: Duration = Duration::from_millis(20);
/// How often a position update is published.
const POSITION_EVERY: u32 = 50;
/// 512KiB rather than the 8MB default: this loop's deepest call is a codec.
const STACK_SIZE: usize = 512 * 1024;

/// What the main thread tells a guild worker to do.
pub enum WorkerCommand {
	/// The voice connection is up; here is everything needed to send on it,
	/// and, when listening, to hear it.
	Attach {
		socket: std::net::UdpSocket,
		session: Box<Session>,
		dave: Option<Arc<Mutex<Driver>>>,
		listen: Option<ListenSetup>,
	},
	/// The connection dropped; stop sending until another `Attach`.
	Detach,
	Play { queue: String, track_id: String, reader: Box<CacheReader>, start_ms: u32 },
	SetNext { queue: String, track_id: String, reader: Box<CacheReader> },
	ClearNext(String),
	Skip(String),
	/// One queue, or every queue when `None`.
	Stop(Option<String>),
	/// One queue, or the whole guild when `None`.
	Pause(Option<String>),
	Resume(Option<String>),
	Seek { queue: String, position_ms: u32 },
	/// The overall gain.
	SetVolume(f32),
	/// One queue's own gain.
	SetQueueVolume { queue: String, gain: f32 },
	RemoveQueue(String),
	/// One queue's seams, or every queue's and the default for new ones.
	SetFades { queue: Option<String>, fades: FadeSettings },
	/// Someone said the bot's name: chime, if `chime`, and lower the music to
	/// `duck` until a matching `Heard`.
	Woke { chime: bool, duck: f32 },
	/// A wake has been dealt with; the music may come back up.
	Heard,
	/// What `user_id` said after the name has been taken down: the end chime
	/// and then the waiting sound, if `chime`, with the music held at `duck`
	/// until a `Settled` for them or an answer to them starts.
	Captured { user_id: u64, chime: bool, duck: f32 },
	/// The name came to nothing: the end chime, if `chime`.
	Closed { chime: bool },
	/// The bot is done with what `user_id` said, without anything to say.
	Settled { user_id: u64 },
	/// Say this, after anything already being said, with the music lowered
	/// to `duck` meanwhile. Interleaved stereo PCM at the Opus rate.
	///
	/// `answers` ends the wait for that speaker as it starts; `then` runs once
	/// it has been said. Nothing is said if too much is queued already, and
	/// then `then` does not run either.
	Say { pcm: Arc<[i16]>, duck: f32, answers: Option<u64>, then: Option<Then> },
	Shutdown,
}

/// A running guild worker.
pub struct Worker {
	commands: Sender<WorkerCommand>,
	speaking: Arc<AtomicBool>,
	handle: Option<std::thread::JoinHandle<()>>,
}

impl Worker {
	/// Start the thread for `guild_id`.
	pub fn spawn(guild_id: String, events: Sender<Event>) -> std::io::Result<Self> {
		let (commands, receiver) = std::sync::mpsc::channel();
		let speaking = Arc::new(AtomicBool::new(false));
		let thread_speaking = Arc::clone(&speaking);

		let handle = std::thread::Builder::new()
			.name(format!("guild-{guild_id}"))
			.stack_size(STACK_SIZE)
			.spawn(move || run(guild_id, receiver, events, thread_speaking))?;

		Ok(Self { commands, speaking, handle: Some(handle) })
	}

	/// A sender the gateway task can hold, so it can attach a socket without
	/// going back through the main loop.
	pub fn command_sender(&self) -> Sender<WorkerCommand> {
		self.commands.clone()
	}

	/// The flag the audio thread sets when it wants to be marked as speaking.
	pub fn speaking_flag(&self) -> Arc<AtomicBool> {
		Arc::clone(&self.speaking)
	}

	pub fn send(&self, command: WorkerCommand) {
		// A closed channel means the thread is already gone, which every caller
		// handles the same way: by doing nothing.
		let _ = self.commands.send(command);
	}

	/// Whether the worker currently wants the speaking flag set. Read by the
	/// gateway task, which is the only side that can send it.
	pub fn wants_speaking(&self) -> bool {
		self.speaking.load(Ordering::Relaxed)
	}

	/// Ask the thread to stop and wait for it.
	pub fn shutdown(mut self) {
		self.send(WorkerCommand::Shutdown);
		if let Some(handle) = self.handle.take() {
			let _ = handle.join();
		}
	}
}

impl Drop for Worker {
	fn drop(&mut self) {
		let _ = self.commands.send(WorkerCommand::Shutdown);
	}
}

/// One queue: a full player, mixed with the guild's others.
struct Queue {
	id: String,
	player: Player,
	/// Held on its own, apart from the guild's pause.
	paused: bool,
	/// Fading out over this tick's frame, to be dropped after it.
	leaving: bool,
}

/// The guild's queues, in the order they were made: the first sounding one
/// sets each mixed frame's length.
#[derive(Default)]
struct Queues {
	list: Vec<Queue>,
	/// The seams a new queue starts with.
	fades: FadeSettings,
}

impl Queues {
	fn get(&mut self, id: &str) -> Option<&mut Queue> {
		self.list.iter_mut().find(|queue| queue.id == id && !queue.leaving)
	}

	/// The queue `id`, made if it is new. An error when the guild already
	/// has as many as it may.
	fn get_or_make(&mut self, id: &str) -> Result<&mut Queue, String> {
		// A queue on its way out is not brought back: the bot never reuses an
		// id, so this one is a new queue that happens to share it.
		self.list.retain(|queue| !(queue.id == id && queue.leaving));
		if let Some(index) = self.list.iter().position(|queue| queue.id == id) {
			return Ok(&mut self.list[index]);
		}
		// One on its way out leaves within a tick and does not hold a place.
		if self.list.iter().filter(|queue| !queue.leaving).count() >= MAX_QUEUES {
			return Err(format!("already playing {MAX_QUEUES} queues"));
		}
		self.list.push(Queue {
			id: id.to_owned(),
			player: Player::with_fades(self.fades),
			paused: false,
			leaving: false,
		});
		Ok(self.list.last_mut().expect("just pushed"))
	}

	/// Whether a queue is holding a track while paused on its own: quiet, but
	/// not finished.
	fn any_held(&self) -> bool {
		self.list.iter().any(|queue| queue.paused && !queue.player.is_idle())
	}
}

/// Everything needed to actually put a packet on the wire.
struct Attachment {
	socket: std::net::UdpSocket,
	session: Session,
	dave: Option<Arc<Mutex<Driver>>>,
	/// The receive thread on this same socket, if listening. Held only to be
	/// dropped: a detach or a re-attach ends it along with the connection.
	_listener: Option<ListenHandle>,
}

fn run(
	guild_id: String,
	commands: Receiver<WorkerCommand>,
	events: Sender<Event>,
	speaking: Arc<AtomicBool>,
) {
	let mut queues = Queues::default();
	let mut mixer = Mixer::new();
	let mut output = Output::default();
	let mut attachment: Option<Attachment> = None;
	let mut paused = false;
	// Whether the last frames sent were the player's, as opposed to a chime
	// played over nothing: only the player going quiet is news to the bot.
	let mut player_spoke = false;
	let mut overlay = [0i16; FRAME_PCM];
	let mut packet = Vec::with_capacity(1400);
	let mut e2ee = Vec::with_capacity(1400);
	let mut ticks = 0u32;

	// Deadline-based rather than sleep-based: sleeping 20ms per iteration
	// accumulates every overshoot into permanent drift against the listener.
	let mut deadline = Instant::now();

	loop {
		deadline += TICK;
		let now = Instant::now();
		// Commands are collected during the gap before the next tick, so the
		// thread is never both waiting and late.
		let wait = deadline.saturating_duration_since(now);
		match commands.recv_timeout(wait) {
			Ok(command) => {
				// Handle this one, then drain anything else already queued
				// before doing audio: a play followed by a volume change should
				// take effect on the same tick.
				let mut next = Some(command);
				while let Some(command) = next {
					if matches!(command, WorkerCommand::Shutdown) {
						return;
					}
					apply(
						command,
						&mut queues,
						&mut mixer,
						&mut output,
						&mut attachment,
						&mut paused,
						&guild_id,
						&events,
					);
					next = commands.try_recv().ok();
				}
				// A command arrived before the tick was due; wait out the rest.
				let remaining = deadline.saturating_duration_since(Instant::now());
				if !remaining.is_zero() {
					std::thread::sleep(remaining);
				}
			}
			Err(RecvTimeoutError::Timeout) => {}
			// The main thread is gone.
			Err(RecvTimeoutError::Disconnected) => return,
		}

		// A thread that fell far behind resyncs rather than sending a burst.
		if deadline + TICK * 10 < Instant::now() {
			deadline = Instant::now();
		}

		ticks = ticks.wrapping_add(1);
		let now = Instant::now();
		if output.waits.due(!output.clips.is_empty(), &mut output.duck, now) {
			output.say(Clip::waiting());
		}
		let playing = output.clips.next_frame(&mut overlay, &mut output.duck, &mut output.waits, now);
		output.update(now);
		let overlay = playing.then_some(&overlay[..]);

		// A chime or speech still plays over a paused track: the name is often
		// said to ask for it back.
		if paused && overlay.is_none() {
			speaking.store(false, Ordering::Relaxed);
			continue;
		}

		let Some(attached) = attachment.as_mut() else {
			continue;
		};
		// While the DAVE group is still forming there is no key to send under.
		// A downgraded call has no group and never will, and that one still
		// sends — under transport encryption alone, like everyone else on it.
		if attached.dave.as_ref().is_some_and(|dave| !dave.lock().is_ok_and(|d| d.can_send())) {
			continue;
		}

		// Paused, every queue holds its place; only a chime or speech is left
		// to send. A queue paused on its own sits out while the rest play.
		let mut frames = Vec::with_capacity(queues.list.len());
		// A stalled queue is not an ending, even with nothing to send.
		let mut stalled = false;
		if !paused {
			for Queue { id, player, paused: held, .. } in queues.list.iter_mut() {
				if *held {
					continue;
				}
				match player.tick() {
					Tick::Frame { bytes, samples } => frames.push((id.as_str(), Frame { bytes, samples })),
					Tick::Starving => stalled = true,
					Tick::Idle => {}
				}
			}
		}
		let mixed = mixer.mix(&frames);

		let silent = match mixed {
			Ok(Some(frame)) => {
				speaking.store(true, Ordering::Relaxed);
				player_spoke = true;
				// The duck and anything said over the music go on last, over the
				// whole mix, so they reach every queue alike.
				match output.volume.process_with(frame.bytes, overlay) {
					Ok(scaled) => {
						if let Err(message) = send_frame(attached, scaled, &mut e2ee, &mut packet) {
							report(&events, &guild_id, message);
						} else {
							attached.session.advance(frame.samples);
						}
					}
					Err(error) => report(&events, &guild_id, format!("gain failed: {error}")),
				}
				false
			}
			Ok(None) => match overlay {
				// Nothing playing, or a stall: the chime or speech goes out alone.
				Some(overlay) => {
					speaking.store(true, Ordering::Relaxed);
					send_alone(attached, &mut output.volume, overlay, &mut e2ee, &mut packet, &guild_id, &events);
					false
				}
				None => true,
			},
			Err(error) => {
				report(&events, &guild_id, format!("mix failed: {error}"));
				false
			}
		};
		// Nothing sent, and nothing about to be: no queue is merely stalled on
		// its download. A stall instead holds the speaking flag, because
		// dropping it would make the client show the bot as having stopped.
		if silent && !stalled && speaking.swap(false, Ordering::Relaxed) {
			// Three silence frames tell the decoder not to interpolate across
			// the gap that is about to start.
			for _ in 0..3 {
				let _ = send_frame(attached, &SILENCE_FRAME, &mut e2ee, &mut packet);
				attached.session.advance(960);
			}
			// A chime over nothing ending is not the queues going quiet, and
			// neither is one held by its own pause.
			if std::mem::take(&mut player_spoke) && !paused && !queues.any_held() {
				let _ = events.send(Event::Idle { guild_id: guild_id.clone() });
			}
		}

		// A frame that could not be decoded is left out of the mix; its track
		// is ended rather than tried again every tick, so its queue moves on.
		for (queue_id, reason) in mixer.drain_failures() {
			report(&events, &guild_id, format!("queue {queue_id} dropped its track: {reason}"));
			if let Some(queue) = queues.get(&queue_id) {
				queue.player.stop();
			}
		}

		let report_position = ticks.is_multiple_of(POSITION_EVERY);
		for queue in &mut queues.list {
			let player_events = queue.player.drain_events();
			// The bot removed it and expects nothing more from it.
			if queue.leaving {
				continue;
			}
			for event in player_events {
				let guild_id = guild_id.clone();
				let queue_id = queue.id.clone();
				let event = match event {
					PlayerEvent::Started(track_id) => Event::Started { guild_id, queue_id, track_id },
					PlayerEvent::Finished(track_id) => Event::Finished { guild_id, queue_id, track_id },
					PlayerEvent::Starved(track_id) => Event::Starved { guild_id, queue_id, track_id },
				};
				let _ = events.send(event);
			}
			if report_position && let Some(track_id) = queue.player.current_id() {
				let _ = events.send(Event::Position {
					guild_id: guild_id.clone(),
					queue_id: queue.id.clone(),
					track_id: track_id.to_owned(),
					position_ms: queue.player.position_ms(),
				});
			}
		}

		// A removed queue has had its fade-out frame; now it goes.
		for queue in queues.list.iter().filter(|queue| queue.leaving) {
			mixer.remove(&queue.id);
		}
		queues.list.retain(|queue| !queue.leaving);
	}
}

/// The volume stage, and what answering the name does to it: the chime and
/// speech mixed in and the music lowered.
#[derive(Default)]
struct Output {
	volume: Volume,
	clips: Clips,
	duck: Duck,
	/// Commands taken down and not yet answered.
	waits: Waits,
	/// What the volume was last set to, so it is only touched on a change.
	applied: Option<f32>,
}

impl Output {
	/// Set the volume to the duck, if that moved. The listener's own volume is
	/// the mixer's master, upstream of this.
	fn update(&mut self, now: Instant) {
		let gain = self.duck.factor(now);
		if self.applied != Some(gain) {
			self.applied = Some(gain);
			self.volume.set_gain(gain);
		}
	}

	/// Queue `clip`. One that does not fit still answers whoever it was for:
	/// nothing else will.
	fn say(&mut self, clip: Clip) {
		if let Some(dropped) = self.clips.push(clip)
			&& let Some(user_id) = dropped.answers()
		{
			self.waits.settle(user_id, &mut self.duck);
		}
	}
}

/// Encode a frame of PCM with nothing under it and send it.
fn send_alone(
	attached: &mut Attachment,
	volume: &mut Volume,
	pcm: &[i16],
	e2ee: &mut Vec<u8>,
	packet: &mut Vec<u8>,
	guild_id: &str,
	events: &Sender<Event>,
) {
	let encoded = match volume.encode_alone(pcm) {
		Ok(encoded) => encoded,
		Err(error) => return report(events, guild_id, format!("chime failed: {error}")),
	};
	match send_frame(attached, encoded, e2ee, packet) {
		Ok(()) => attached.session.advance(960),
		Err(message) => report(events, guild_id, message),
	}
}

/// Encrypt and send one Opus frame.
fn send_frame(
	attached: &mut Attachment,
	opus: &[u8],
	e2ee: &mut Vec<u8>,
	packet: &mut Vec<u8>,
) -> Result<(), String> {
	// End-to-end first, then transport: the voice server relays ciphertext it
	// cannot read, inside a packet it can route.
	let payload: &[u8] = match attached.dave.as_ref() {
		Some(dave) => {
			let mut driver = dave.lock().map_err(|_| "dave session poisoned".to_owned())?;
			// Re-checked under the same lock that encrypts. The gateway task can
			// rebuild the group between the tick's check and this one — a member
			// joining is enough — and encrypting into a session that is mid-epoch
			// is a frame nobody could have decrypted anyway, not an error worth
			// reporting.
			if !driver.can_send() {
				return Ok(());
			}
			if driver.encrypting() {
				driver.encrypt_opus(opus, e2ee).map_err(|error| format!("dave: {error}"))?;
				e2ee
			} else {
				opus
			}
		}
		None => opus,
	};

	attached.session.seal(payload, packet).map_err(|error| format!("seal: {error}"))?;
	// A full socket buffer costs this frame, not the pacing of every frame
	// behind it.
	match attached.socket.send(packet) {
		Ok(_) => Ok(()),
		Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(()),
		Err(error) => Err(format!("send: {error}")),
	}
}

// Every argument is a separate piece of the worker's state that a command may
// touch; bundling them would only move the borrow splitting somewhere else.
#[allow(clippy::too_many_arguments)]
fn apply(
	command: WorkerCommand,
	queues: &mut Queues,
	mixer: &mut Mixer,
	output: &mut Output,
	attachment: &mut Option<Attachment>,
	paused: &mut bool,
	guild_id: &str,
	events: &Sender<Event>,
) {
	match command {
		WorkerCommand::Attach { socket, session, dave, listen } => {
			// The old attachment, and its receive thread, go first: two
			// threads reading one socket would each get half the packets.
			*attachment = None;
			let listener = listen.and_then(|setup| {
				let started =
					socket.try_clone().and_then(|clone| listen::spawn(guild_id, clone, setup, dave.clone()));
				match started {
					Ok(handle) => Some(handle),
					Err(error) => {
						report(events, guild_id, format!("could not start listening: {error}"));
						None
					}
				}
			});
			*attachment = Some(Attachment { socket, session: *session, dave, _listener: listener });
		}
		WorkerCommand::Detach => *attachment = None,
		WorkerCommand::Play { queue, track_id, mut reader, start_ms } => match queues.get_or_make(&queue) {
			Ok(queue) => {
				if start_ms > 0 {
					reader.seek(start_ms);
				}
				queue.player.play(track_id, *reader);
				// A track started on a queue is one to hear: it ends that
				// queue's own pause, though not the guild's.
				queue.paused = false;
			}
			Err(message) => report(events, guild_id, message),
		},
		WorkerCommand::SetNext { queue, track_id, reader } => match queues.get_or_make(&queue) {
			Ok(queue) => queue.player.set_next(track_id, *reader),
			Err(message) => report(events, guild_id, message),
		},
		WorkerCommand::ClearNext(queue) => {
			if let Some(queue) = queues.get(&queue) {
				queue.player.clear_next();
			}
		}
		WorkerCommand::Skip(queue) => {
			if let Some(queue) = queues.get(&queue) {
				queue.player.skip();
			}
		}
		WorkerCommand::Stop(None) => {
			for queue in &mut queues.list {
				queue.player.stop();
			}
		}
		WorkerCommand::Stop(Some(queue)) => {
			if let Some(queue) = queues.get(&queue) {
				queue.player.stop();
			}
		}
		WorkerCommand::Pause(None) => *paused = true,
		WorkerCommand::Resume(None) => *paused = false,
		WorkerCommand::Pause(Some(queue)) => match queues.get_or_make(&queue) {
			Ok(queue) => queue.paused = true,
			Err(message) => report(events, guild_id, message),
		},
		WorkerCommand::Resume(Some(queue)) => {
			if let Some(queue) = queues.get(&queue) {
				queue.paused = false;
			}
		}
		WorkerCommand::Seek { queue, position_ms } => {
			let sought = queues.get(&queue).and_then(|queue| queue.player.seek(position_ms));
			if sought.is_none() {
				report(events, guild_id, format!("nothing is playing on queue {queue} to seek"));
			}
		}
		WorkerCommand::SetVolume(gain) => mixer.set_master(gain),
		WorkerCommand::SetQueueVolume { queue, gain } => mixer.set_gain(&queue, gain),
		WorkerCommand::RemoveQueue(queue) => {
			if let Some(queue) = queues.get(&queue) {
				// Faded to silence over the next frame, then dropped.
				queue.leaving = true;
				mixer.set_gain(&queue.id, 0.0);
			} else {
				mixer.remove(&queue);
			}
		}
		WorkerCommand::Woke { chime, duck } => {
			if chime {
				output.say(Clip::chime());
			}
			if duck < 1.0 {
				output.duck.woke(duck, Instant::now());
			}
			output.update(Instant::now());
		}
		WorkerCommand::Heard => {
			output.duck.heard();
			output.update(Instant::now());
		}
		WorkerCommand::Captured { user_id, chime, duck } => {
			if chime {
				output.say(Clip::end_chime());
			}
			output.waits.start(user_id, chime, duck, &mut output.duck, Instant::now());
			output.update(Instant::now());
		}
		WorkerCommand::Closed { chime } => {
			if chime {
				output.say(Clip::end_chime());
			}
		}
		WorkerCommand::Settled { user_id } => {
			output.waits.settle(user_id, &mut output.duck);
			output.update(Instant::now());
		}
		WorkerCommand::Say { pcm, duck, answers, then } => {
			let mut clip = Clip::new(pcm, (duck < 1.0).then_some(duck));
			if let Some(user_id) = answers {
				clip = clip.answering(user_id);
			}
			if let Some(then) = then {
				clip = clip.then(then);
			}
			output.say(clip);
		}
		WorkerCommand::SetFades { queue: None, fades } => {
			queues.fades = fades;
			for queue in &mut queues.list {
				queue.player.set_fades(fades);
			}
		}
		WorkerCommand::SetFades { queue: Some(queue), fades } => match queues.get_or_make(&queue) {
			Ok(queue) => queue.player.set_fades(fades),
			Err(message) => report(events, guild_id, message),
		},
		WorkerCommand::Shutdown => {}
	}
}

fn report(events: &Sender<Event>, guild_id: &str, message: String) {
	let _ = events.send(Event::Error {
		guild_id: Some(guild_id.to_owned()),
		message,
	});
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_worker_starts_and_stops_cleanly() {
		let (events, received) = std::sync::mpsc::channel();
		let worker = Worker::spawn("1".to_owned(), events).unwrap();
		assert!(!worker.wants_speaking(), "nothing is playing yet");
		worker.shutdown();
		// No events, and no panic on the way out.
		assert!(received.try_recv().is_err());
	}

	#[test]
	fn commands_before_a_connection_do_not_crash_the_thread() {
		let (events, received) = std::sync::mpsc::channel();
		let worker = Worker::spawn("1".to_owned(), events).unwrap();

		// A bot can issue any of these before the voice connection lands.
		worker.send(WorkerCommand::SetVolume(0.5));
		worker.send(WorkerCommand::Pause(None));
		worker.send(WorkerCommand::Resume(None));
		worker.send(WorkerCommand::Seek { queue: "1".to_owned(), position_ms: 1000 });
		worker.send(WorkerCommand::Skip("1".to_owned()));
		worker.send(WorkerCommand::RemoveQueue("2".to_owned()));
		std::thread::sleep(Duration::from_millis(80));

		// Seeking with nothing loaded is reported rather than ignored.
		let errors: Vec<_> = received.try_iter().collect();
		assert!(
			errors.iter().any(|event| matches!(event, Event::Error { .. })),
			"expected a seek complaint, got {errors:?}"
		);
		worker.shutdown();
	}

	#[test]
	fn queues_are_made_on_first_mention_up_to_the_cap() {
		let mut queues = Queues::default();
		for index in 0..MAX_QUEUES {
			assert!(queues.get_or_make(&index.to_string()).is_ok());
		}
		// Naming one again finds it rather than making another
		assert!(queues.get_or_make("0").is_ok());
		assert_eq!(queues.list.len(), MAX_QUEUES);
		assert!(queues.get_or_make("extra").is_err());
	}

	#[test]
	fn a_queue_on_its_way_out_is_not_found_or_revived() {
		let mut queues = Queues::default();
		queues.get_or_make("2").unwrap().player.set_fades(FadeSettings { crossfade_ms: 900, skip_fade_ms: 0 });
		queues.get("2").unwrap().leaving = true;
		assert!(queues.get("2").is_none(), "a leaving queue takes no more commands");
		// The same id again is a fresh queue, not the old one coming back
		let fresh = queues.get_or_make("2").unwrap();
		assert!(!fresh.leaving);
		assert_eq!(queues.list.len(), 1);
	}

	#[test]
	fn new_queues_start_with_the_guild_s_fades() {
		let mut queues = Queues { fades: FadeSettings { crossfade_ms: 1200, skip_fade_ms: 80 }, ..Default::default() };
		let queue = queues.get_or_make("3").unwrap();
		assert_eq!(queue.player.fades().crossfade_ms, 1200);
		assert_eq!(queue.player.fades().skip_fade_ms, 80);
		assert!(!queue.paused);
	}

	#[test]
	fn dropping_the_worker_stops_the_thread() {
		let (events, _received) = std::sync::mpsc::channel();
		let worker = Worker::spawn("1".to_owned(), events).unwrap();
		let speaking = Arc::clone(&worker.speaking);
		drop(worker);
		std::thread::sleep(Duration::from_millis(60));
		// The thread released its handle on the shared flag by exiting; the
		// Arc count dropping to one is the observable proof.
		assert_eq!(Arc::strong_count(&speaking), 1);
	}
}
