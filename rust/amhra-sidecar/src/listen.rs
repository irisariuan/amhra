//! One guild's receive thread.
//!
//! Separate from the audio thread on purpose: that one runs a 20ms deadline
//! and must never block on a read, while this one does nothing *but* block on
//! a read. They share the UDP socket through `try_clone` — one descriptor's
//! worth of kernel socket, two handles — and the DAVE session through the same
//! mutex the sender already takes. The read timeout set here is per-socket, but
//! it only governs `recv`; the sender's `send` is unaffected.
//!
//! Off unless the sidecar is started with `--listen`. A music bot that never
//! uses what it hears should not pay to decode everyone in every channel.
//!
//! What it hears goes to a [`VoiceSink`]: with `--voice-commands`, the wake
//! word gate (`voice_commands`); otherwise nowhere.

use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use amhra_voice::Opener;
use amhra_voice::dave::driver::Driver;
use amhra_voice::receive::{Listener, Membership, VoiceFrame};

/// How long a read waits before the thread checks whether it should stop.
/// Also the latency of a membership change reaching an idle call.
const READ_TIMEOUT: Duration = Duration::from_millis(100);
/// How often held packets are aged out.
const EXPIRE_EVERY: Duration = Duration::from_secs(1);
/// How often per-user counters are written to the log, when any are failing.
const REPORT_EVERY: Duration = Duration::from_secs(30);
/// Generous for a datagram that must fit in one MTU.
const MAX_DATAGRAM: usize = 2048;
/// A thread that only reads and decodes needs little more than the codec.
const STACK_SIZE: usize = 512 * 1024;

/// What the receive thread passes on.
#[derive(Debug)]
pub enum Heard {
	Voice(VoiceFrame),
	/// Someone left the call. Whatever was keeping state for them can let go.
	Left { user_id: u64 },
}

/// Where decoded voice goes. Called on the receive thread, so it must not
/// block: anything slow belongs on a thread of its own behind a queue.
pub type VoiceSink = Box<dyn FnMut(Heard) + Send>;

/// What the connection task hands the worker for listening.
pub struct ListenSetup {
	pub opener: Opener,
	pub own_ssrc: u32,
	/// SSRC announcements and departures, from the voice gateway.
	pub membership: Receiver<Membership>,
	/// Where what is heard goes.
	pub sink: VoiceSink,
}

/// Keeps a receive thread alive. Dropping it stops the thread within one
/// read timeout; nothing waits for that, so detaching never stalls the audio
/// thread that drops it.
pub struct ListenHandle {
	stop: Arc<AtomicBool>,
}

impl Drop for ListenHandle {
	fn drop(&mut self) {
		self.stop.store(true, Ordering::Relaxed);
	}
}

/// Start listening on `socket`, which must be a clone of the one the sender
/// uses: discovery told the server where to send, and that was this port.
pub fn spawn(
	guild_id: &str,
	socket: UdpSocket,
	setup: ListenSetup,
	dave: Option<Arc<Mutex<Driver>>>,
) -> std::io::Result<ListenHandle> {
	socket.set_read_timeout(Some(READ_TIMEOUT))?;
	let stop = Arc::new(AtomicBool::new(false));
	let thread_stop = Arc::clone(&stop);
	let guild_id = guild_id.to_owned();
	std::thread::Builder::new()
		.name(format!("listen-{guild_id}"))
		.stack_size(STACK_SIZE)
		.spawn(move || run(guild_id, socket, setup, dave, thread_stop))?;
	Ok(ListenHandle { stop })
}

fn run(
	guild_id: String,
	socket: UdpSocket,
	setup: ListenSetup,
	dave: Option<Arc<Mutex<Driver>>>,
	stop: Arc<AtomicBool>,
) {
	let ListenSetup { opener, own_ssrc, membership, mut sink } = setup;
	let mut listener = Listener::new(opener, own_ssrc);
	let dave = dave.as_deref();
	let mut buffer = [0u8; MAX_DATAGRAM];
	let mut last_expire = Instant::now();
	let mut last_report = Instant::now();

	while !stop.load(Ordering::Relaxed) {
		loop {
			match membership.try_recv() {
				Ok(change) => {
					listener.membership(change, Instant::now(), dave, &mut |frame| sink(Heard::Voice(frame)));
					if let Membership::Disconnect { user_id } = change {
						sink(Heard::Left { user_id });
					}
				}
				Err(TryRecvError::Empty) => break,
				// The connection that fed this is gone.
				Err(TryRecvError::Disconnected) => return,
			}
		}

		match socket.recv(&mut buffer) {
			Ok(length) => listener.handle_packet(&buffer[..length], Instant::now(), dave, &mut |frame| {
				sink(Heard::Voice(frame))
			}),
			Err(error)
				if matches!(
					error.kind(),
					std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
				) => {}
			// A refused port is the ICMP echo of a packet the sender sent
			// while the server was moving; the socket is still good.
			Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {}
			Err(error) => {
				eprintln!("[{guild_id}] listen: {error}");
				return;
			}
		}

		let now = Instant::now();
		if now.duration_since(last_expire) >= EXPIRE_EVERY {
			listener.expire(now);
			last_expire = now;
		}
		if now.duration_since(last_report) >= REPORT_EVERY {
			report(&guild_id, &listener);
			last_report = now;
		}
	}
}

/// Log the counters of anyone whose audio is not getting through cleanly.
fn report(guild_id: &str, listener: &Listener) {
	for (user_id, stats) in listener.stats() {
		if stats.dave_failures + stats.transport_failures + stats.decode_failures > 0 {
			eprintln!("[{guild_id}] listen: user {user_id}: {stats:?}");
		}
	}
	let (failures, dropped) = listener.unattributed();
	if failures + dropped > 0 {
		eprintln!(
			"[{guild_id}] listen: {failures} undecryptable and {dropped} unclaimed packets from unannounced SSRCs"
		);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use amhra_voice::Session;
	use amhra_voice::wire::EncryptionMode;

	const KEY: [u8; 32] = [8u8; 32];
	const MODE: EncryptionMode = EncryptionMode::AeadAes256GcmRtpSize;

	#[test]
	fn a_socket_clone_hears_a_user_and_stops_when_dropped() {
		let server = UdpSocket::bind("127.0.0.1:0").unwrap();
		let bot = UdpSocket::bind("127.0.0.1:0").unwrap();
		bot.connect(server.local_addr().unwrap()).unwrap();

		let (frames, heard) = std::sync::mpsc::channel();
		let (membership, changes) = std::sync::mpsc::channel();
		let handle = spawn(
			"1",
			bot.try_clone().unwrap(),
			ListenSetup {
				opener: Opener::new(MODE, &KEY).unwrap(),
				own_ssrc: 1,
				membership: changes,
				sink: Box::new(move |heard| {
					if let Heard::Voice(frame) = heard {
						let _ = frames.send(frame);
					}
				}),
			},
			None,
		)
		.unwrap();

		membership.send(Membership::Speaking { user_id: 42, ssrc: 9 }).unwrap();
		let mut session = Session::with_start(MODE, &KEY, 9, 0, 0).unwrap();
		let mut packet = Vec::new();
		session.seal(&amhra_voice::SILENCE_FRAME, &mut packet).unwrap();
		// Sent from the "server" to the bot's port, as the media server would.
		server.send_to(&packet, bot.local_addr().unwrap()).unwrap();

		let frame = heard.recv_timeout(Duration::from_secs(2)).expect("a decoded frame");
		assert_eq!(frame.user_id, 42);
		assert_eq!(frame.pcm.len(), amhra_voice::receive::SAMPLES_PER_FRAME);

		// The sending half still works while the clone is being read.
		bot.send(b"still sending").unwrap();

		drop(handle);
		drop(membership);
		std::thread::sleep(READ_TIMEOUT * 3);
		assert!(heard.try_recv().is_err());
	}
}
