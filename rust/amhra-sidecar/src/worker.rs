//! One guild's audio thread.
//!
//! Everything time-critical happens here and nowhere else: the 20ms tick, the
//! frame, the gain, the two encryptions, the send. The thread owns its player
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
use amhra_voice::player::{Event as PlayerEvent, FadeSettings, Player, Tick};
use amhra_voice::{SILENCE_FRAME, Session};

use crate::protocol::Event;

/// One audio frame's worth of time.
const TICK: Duration = Duration::from_millis(20);
/// How often a position update is published.
const POSITION_EVERY: u32 = 50;
/// 512KiB rather than the 8MB default: this loop's deepest call is a codec.
const STACK_SIZE: usize = 512 * 1024;

/// What the main thread tells a guild worker to do.
pub enum WorkerCommand {
	/// The voice connection is up; here is everything needed to send on it.
	Attach {
		socket: std::net::UdpSocket,
		session: Box<Session>,
		dave: Option<Arc<Mutex<Driver>>>,
	},
	/// The connection dropped; stop sending until another `Attach`.
	Detach,
	Play { track_id: String, reader: Box<CacheReader>, start_ms: u32 },
	SetNext { track_id: String, reader: Box<CacheReader> },
	ClearNext,
	Skip,
	Stop,
	Pause,
	Resume,
	Seek(u32),
	SetVolume(f32),
	SetFades(FadeSettings),
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

/// Everything needed to actually put a packet on the wire.
struct Attachment {
	socket: std::net::UdpSocket,
	session: Session,
	dave: Option<Arc<Mutex<Driver>>>,
}

fn run(
	guild_id: String,
	commands: Receiver<WorkerCommand>,
	events: Sender<Event>,
	speaking: Arc<AtomicBool>,
) {
	let mut player = Player::new();
	let mut volume = Volume::new();
	let mut attachment: Option<Attachment> = None;
	let mut paused = false;
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
						&mut player,
						&mut volume,
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
		if paused {
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

		match player.tick() {
			Tick::Frame { bytes, samples } => {
				speaking.store(true, Ordering::Relaxed);
				let scaled = match volume.process(bytes) {
					Ok(scaled) => scaled,
					Err(error) => {
						report(&events, &guild_id, format!("gain failed: {error}"));
						continue;
					}
				};
				if let Err(message) = send_frame(attached, scaled, &mut e2ee, &mut packet) {
					report(&events, &guild_id, message);
					continue;
				}
				attached.session.advance(samples);
			}
			// Hold the speaking flag: this is a stall, and dropping it would
			// make the client show the bot as having stopped.
			Tick::Starving => {}
			Tick::Idle => {
				if speaking.swap(false, Ordering::Relaxed) {
					// Three silence frames tell the decoder not to interpolate
					// across the gap that is about to start.
					for _ in 0..3 {
						let _ = send_frame(attached, &SILENCE_FRAME, &mut e2ee, &mut packet);
						attached.session.advance(960);
					}
					let _ = events.send(Event::Idle { guild_id: guild_id.clone() });
				}
			}
		}

		for event in player.drain_events() {
			let event = match event {
				PlayerEvent::Started(track_id) => {
					Event::Started { guild_id: guild_id.clone(), track_id }
				}
				PlayerEvent::Finished(track_id) => {
					Event::Finished { guild_id: guild_id.clone(), track_id }
				}
				PlayerEvent::Starved(track_id) => {
					Event::Starved { guild_id: guild_id.clone(), track_id }
				}
			};
			let _ = events.send(event);
		}

		if ticks.is_multiple_of(POSITION_EVERY)
			&& let Some(track_id) = player.current_id()
		{
			let _ = events.send(Event::Position {
				guild_id: guild_id.clone(),
				track_id: track_id.to_owned(),
				position_ms: player.position_ms(),
			});
		}
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

fn apply(
	command: WorkerCommand,
	player: &mut Player,
	volume: &mut Volume,
	attachment: &mut Option<Attachment>,
	paused: &mut bool,
	guild_id: &str,
	events: &Sender<Event>,
) {
	match command {
		WorkerCommand::Attach { socket, session, dave } => {
			*attachment = Some(Attachment { socket, session: *session, dave });
		}
		WorkerCommand::Detach => *attachment = None,
		WorkerCommand::Play { track_id, mut reader, start_ms } => {
			if start_ms > 0 {
				reader.seek(start_ms);
			}
			player.play(track_id, *reader);
			*paused = false;
		}
		WorkerCommand::SetNext { track_id, reader } => player.set_next(track_id, *reader),
		WorkerCommand::ClearNext => player.clear_next(),
		WorkerCommand::Skip => player.skip(),
		WorkerCommand::Stop => player.stop(),
		WorkerCommand::Pause => *paused = true,
		WorkerCommand::Resume => *paused = false,
		WorkerCommand::Seek(position_ms) => {
			if player.seek(position_ms).is_none() {
				report(events, guild_id, "nothing is playing to seek".to_owned());
			}
		}
		WorkerCommand::SetVolume(gain) => volume.set_gain(gain),
		WorkerCommand::SetFades(fades) => player.set_fades(fades),
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
		worker.send(WorkerCommand::Pause);
		worker.send(WorkerCommand::Resume);
		worker.send(WorkerCommand::Seek(1000));
		worker.send(WorkerCommand::Skip);
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
