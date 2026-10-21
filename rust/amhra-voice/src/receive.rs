//! Hearing the call: other members' RTP in, per-user 16 kHz mono PCM out.
//!
//! Each inbound packet goes through the same layers as an outbound one, in
//! reverse:
//!
//! ```text
//! UDP ─▶ transport open ─▶ SSRC → user ─▶ DAVE decrypt ─▶ Opus decode ─▶ PCM
//!         (shared key)      (op 5 map)     (their key)     (per SSRC)
//! ```
//!
//! The awkward step is the middle one. A user's SSRC is only announced by the
//! server's `speaking (5)`, which is sent when they start transmitting — so
//! the first packets from someone can arrive before anyone has said whose they
//! are, and under DAVE they cannot be decrypted until then. Those packets are
//! held for [`PENDING_WINDOW`] instead of dropped, which is what keeps the
//! first word of an utterance.
//!
//! Decoding is at 16 kHz mono because that is what speech recognition wants.
//! libopus resamples and downmixes inside the decoder, so asking for it here is
//! cheaper than decoding 48 kHz stereo and converting afterwards.
//!
//! There is no jitter buffer: packets are decoded as they arrive, and one that
//! arrives after a later one is counted and dropped. Discord's media servers
//! deliver in order nearly always, and a recogniser forgives a 20ms hole more
//! easily than the latency a buffer would add.
//!
//! Pure logic, no socket: the caller reads packets and hands them in, so this
//! runs the same under a thread in the sidecar and a task in an example.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::crypto::{OpenError, Opener, RtpHeader};
use crate::dave::decryptor::Decrypted;
use crate::dave::driver::Driver;

/// Output sample rate.
pub const SAMPLE_RATE: u32 = 16_000;
/// One 20ms frame at [`SAMPLE_RATE`].
pub const SAMPLES_PER_FRAME: usize = 320;
/// The longest Opus packet, 120ms, at [`SAMPLE_RATE`].
const MAX_DECODED_SAMPLES: usize = 1920;
/// How long packets from an unannounced SSRC are held for its `speaking`.
pub const PENDING_WINDOW: Duration = Duration::from_secs(1);
/// One second of 20ms packets per held SSRC.
const MAX_PENDING_PER_SSRC: usize = 50;
/// Unannounced SSRCs held at once. A call has a few dozen speakers at most;
/// more than this is noise, and holding it would be a memory leak on demand.
const MAX_PENDING_SSRCS: usize = 32;
/// Lost packets concealed in one gap. Beyond 100ms, interpolated audio is a
/// smear rather than a repair, and a gap that long is a user who went quiet.
const MAX_CONCEALED_FRAMES: u16 = 5;

/// One frame of someone's voice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceFrame {
	pub user_id: u64,
	pub ssrc: u32,
	pub sequence: u16,
	/// Mono samples at [`SAMPLE_RATE`]; 320 for a 20ms packet.
	pub pcm: Vec<i16>,
	/// Synthesised by the decoder for a lost packet, not received.
	pub concealed: bool,
}

/// Who is in the call, as the voice gateway reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Membership {
	/// From `speaking (5)`: this SSRC is this user's.
	Speaking { user_id: u64, ssrc: u32 },
	/// From `client_disconnect (13)`: they left, and their SSRC may be reused.
	Disconnect { user_id: u64 },
}

/// Per-user counters, for spotting a sender whose audio is not getting
/// through and why.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserStats {
	/// Frames decoded from received packets.
	pub frames: u64,
	/// Frames concealed for lost packets.
	pub concealed: u64,
	/// Frames accepted in the clear during a transition or downgrade.
	pub passthrough: u64,
	/// Frames DAVE could not open. A steady climb means a desynchronised group.
	pub dave_failures: u64,
	/// Packets that failed transport decryption once attributed.
	pub transport_failures: u64,
	/// Payloads libopus refused.
	pub decode_failures: u64,
	/// Packets older than one already decoded, or duplicates.
	pub late: u64,
}

struct Held {
	at: Instant,
	header: RtpHeader,
	payload: Vec<u8>,
}

struct Stream {
	user_id: u64,
	decoder: opus::Decoder,
	last_sequence: Option<u16>,
	/// Length of the last decoded frame, which is what concealment fills.
	last_samples: usize,
}

/// One call's receive side.
pub struct Listener {
	opener: Opener,
	own_ssrc: u32,
	users: HashMap<u32, u64>,
	streams: HashMap<u32, Stream>,
	pending: HashMap<u32, VecDeque<Held>>,
	stats: HashMap<u64, UserStats>,
	/// Transport failures from SSRCs nobody has claimed.
	unattributed_failures: u64,
	/// Packets dropped because their SSRC was never announced in time.
	unattributed_dropped: u64,
	payload: Vec<u8>,
	opus: Vec<u8>,
	pcm: Vec<i16>,
}

impl std::fmt::Debug for Listener {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Listener")
			.field("own_ssrc", &self.own_ssrc)
			.field("users", &self.users)
			.field("pending", &self.pending.len())
			.finish_non_exhaustive()
	}
}

impl Listener {
	/// Start listening. `own_ssrc` is ours, from `ready`: the server does not
	/// echo our own audio, but if it ever did it must not be heard as a user.
	pub fn new(opener: Opener, own_ssrc: u32) -> Self {
		Self {
			opener,
			own_ssrc,
			users: HashMap::new(),
			streams: HashMap::new(),
			pending: HashMap::new(),
			stats: HashMap::new(),
			unattributed_failures: 0,
			unattributed_dropped: 0,
			payload: Vec::with_capacity(1400),
			opus: Vec::with_capacity(1400),
			pcm: vec![0; MAX_DECODED_SAMPLES],
		}
	}

	/// The user an SSRC belongs to, if it has been announced.
	pub fn user(&self, ssrc: u32) -> Option<u64> {
		self.users.get(&ssrc).copied()
	}

	pub fn stats(&self) -> &HashMap<u64, UserStats> {
		&self.stats
	}

	/// Transport failures and drops that could not be pinned on anyone.
	pub fn unattributed(&self) -> (u64, u64) {
		(self.unattributed_failures, self.unattributed_dropped)
	}

	/// Handle one datagram off the voice socket.
	///
	/// `dave` is the call's DAVE driver, if it is end-to-end encrypted; it is
	/// locked only for the decrypt itself, so the audio thread sending on the
	/// same session waits on a few microseconds of AES at most.
	pub fn handle_packet(
		&mut self,
		packet: &[u8],
		now: Instant,
		dave: Option<&Mutex<Driver>>,
		sink: &mut dyn FnMut(VoiceFrame),
	) {
		let Some(ssrc) = Opener::peek_ssrc(packet) else { return };
		if ssrc == self.own_ssrc {
			return;
		}
		let header = match self.opener.open(packet, &mut self.payload) {
			Ok(header) => header,
			// RTCP and keepalives share the socket; they are not failures.
			Err(OpenError::NotOpus) => return,
			Err(_) => {
				match self.users.get(&ssrc) {
					Some(user) => self.stats.entry(*user).or_default().transport_failures += 1,
					None => self.unattributed_failures += 1,
				}
				return;
			}
		};

		match self.users.get(&ssrc).copied() {
			Some(user_id) => {
				let payload = std::mem::take(&mut self.payload);
				self.deliver(user_id, header, &payload, dave, now, sink);
				self.payload = payload;
			}
			None => self.hold(header, now),
		}
	}

	/// Apply a membership change, delivering anything held for a newly named
	/// SSRC.
	pub fn membership(
		&mut self,
		change: Membership,
		now: Instant,
		dave: Option<&Mutex<Driver>>,
		sink: &mut dyn FnMut(VoiceFrame),
	) {
		match change {
			Membership::Speaking { user_id, ssrc } => {
				if ssrc == self.own_ssrc {
					return;
				}
				// One audio SSRC per user: a new one replaces the old, whose
				// decoder state belongs to a stream that has ended.
				self.users.retain(|&old, &mut user| user != user_id || old == ssrc);
				self.streams.retain(|&old, stream| stream.user_id != user_id || old == ssrc);
				if let Some(previous) = self.users.insert(ssrc, user_id)
					&& previous != user_id
				{
					self.streams.remove(&ssrc);
				}

				let Some(held) = self.pending.remove(&ssrc) else { return };
				for packet in held {
					if now.duration_since(packet.at) <= PENDING_WINDOW {
						self.deliver(user_id, packet.header, &packet.payload, dave, now, sink);
					} else {
						self.unattributed_dropped += 1;
					}
				}
			}
			Membership::Disconnect { user_id } => {
				self.users.retain(|_, user| *user != user_id);
				self.streams.retain(|_, stream| stream.user_id != user_id);
			}
		}
	}

	/// Drop held packets nobody claimed in time. Call about once a second.
	pub fn expire(&mut self, now: Instant) {
		let mut dropped = 0;
		self.pending.retain(|_, held| {
			let before = held.len();
			held.retain(|packet| now.duration_since(packet.at) <= PENDING_WINDOW);
			dropped += (before - held.len()) as u64;
			!held.is_empty()
		});
		self.unattributed_dropped += dropped;
	}

	fn hold(&mut self, header: RtpHeader, now: Instant) {
		if !self.pending.contains_key(&header.ssrc) && self.pending.len() >= MAX_PENDING_SSRCS {
			self.unattributed_dropped += 1;
			return;
		}
		let held = self.pending.entry(header.ssrc).or_default();
		if held.len() >= MAX_PENDING_PER_SSRC {
			held.pop_front();
			self.unattributed_dropped += 1;
		}
		held.push_back(Held { at: now, header, payload: self.payload.clone() });
	}

	fn deliver(
		&mut self,
		user_id: u64,
		header: RtpHeader,
		payload: &[u8],
		dave: Option<&Mutex<Driver>>,
		now: Instant,
		sink: &mut dyn FnMut(VoiceFrame),
	) {
		let stats = self.stats.entry(user_id).or_default();

		// End-to-end layer. A call with no DAVE session at all carries Opus
		// directly.
		match dave {
			Some(dave) => {
				let outcome = match dave.lock() {
					Ok(mut driver) => driver.decrypt(user_id, payload, &mut self.opus, now),
					Err(_) => {
						stats.dave_failures += 1;
						return;
					}
				};
				match outcome {
					Ok(Decrypted::Passthrough) => stats.passthrough += 1,
					Ok(Decrypted::Opened | Decrypted::Silence) => {}
					Err(_) => {
						stats.dave_failures += 1;
						return;
					}
				}
			}
			None => {
				self.opus.clear();
				self.opus.extend_from_slice(payload);
			}
		}

		let stream = match self.streams.entry(header.ssrc) {
			std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
			std::collections::hash_map::Entry::Vacant(entry) => {
				match opus::Decoder::new(SAMPLE_RATE, opus::Channels::Mono) {
					Ok(decoder) => entry.insert(Stream {
						user_id,
						decoder,
						last_sequence: None,
						last_samples: SAMPLES_PER_FRAME,
					}),
					Err(_) => {
						stats.decode_failures += 1;
						return;
					}
				}
			}
		};

		if let Some(last) = stream.last_sequence {
			let gap = header.sequence.wrapping_sub(last);
			// Zero is a duplicate; the top half of the range is "behind".
			if gap == 0 || gap > u16::MAX / 2 {
				stats.late += 1;
				return;
			}
			if gap > 1 && gap - 1 <= MAX_CONCEALED_FRAMES {
				for missing in 1..gap {
					// An empty packet asks libopus for loss concealment, sized
					// like the frame before it.
					let length = stream.last_samples;
					if let Ok(samples) = stream.decoder.decode(&[], &mut self.pcm[..length], false) {
						stats.concealed += 1;
						sink(VoiceFrame {
							user_id,
							ssrc: header.ssrc,
							sequence: last.wrapping_add(missing),
							pcm: self.pcm[..samples].to_vec(),
							concealed: true,
						});
					}
				}
			}
		}
		stream.last_sequence = Some(header.sequence);

		match stream.decoder.decode(&self.opus, &mut self.pcm, false) {
			Ok(samples) => {
				stream.last_samples = samples.clamp(1, MAX_DECODED_SAMPLES);
				stats.frames += 1;
				sink(VoiceFrame {
					user_id,
					ssrc: header.ssrc,
					sequence: header.sequence,
					pcm: self.pcm[..samples].to_vec(),
					concealed: false,
				});
			}
			Err(_) => stats.decode_failures += 1,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::crypto::Session;
	use crate::wire::EncryptionMode;

	const KEY: [u8; 32] = [5u8; 32];
	const MODE: EncryptionMode = EncryptionMode::AeadAes256GcmRtpSize;
	const THEIR_SSRC: u32 = 777;
	const OUR_SSRC: u32 = 1;
	const USER: u64 = 42;

	/// A real 20ms Opus packet, so the decoder has something to chew on.
	fn opus_frame() -> Vec<u8> {
		let mut encoder =
			opus::Encoder::new(48_000, opus::Channels::Stereo, opus::Application::Voip).unwrap();
		let pcm: Vec<i16> =
			(0..960 * 2).map(|index| ((index as f32 / 20.0).sin() * 8000.0) as i16).collect();
		encoder.encode_vec(&pcm, 4000).unwrap()
	}

	struct Sender {
		session: Session,
		packet: Vec<u8>,
	}

	impl Sender {
		fn new(ssrc: u32) -> Self {
			Self { session: Session::with_start(MODE, &KEY, ssrc, 100, 0).unwrap(), packet: Vec::new() }
		}

		/// The next packet in sequence.
		fn next(&mut self, payload: &[u8]) -> Vec<u8> {
			self.session.seal(payload, &mut self.packet).unwrap();
			self.session.advance(960);
			self.packet.clone()
		}

		/// Lose a packet: advance the clock without sending.
		fn skip(&mut self) {
			self.session.advance(960);
		}
	}

	fn listener() -> Listener {
		Listener::new(Opener::new(MODE, &KEY).unwrap(), OUR_SSRC)
	}

	fn speaking() -> Membership {
		Membership::Speaking { user_id: USER, ssrc: THEIR_SSRC }
	}

	#[test]
	fn an_announced_user_is_decoded_to_16k_mono() {
		let mut listener = listener();
		let mut sender = Sender::new(THEIR_SSRC);
		let mut frames = Vec::new();
		let now = Instant::now();
		listener.membership(speaking(), now, None, &mut |frame| frames.push(frame));

		let opus = opus_frame();
		for _ in 0..3 {
			listener.handle_packet(&sender.next(&opus), now, None, &mut |frame| frames.push(frame));
		}
		assert_eq!(frames.len(), 3);
		assert!(frames.iter().all(|frame| frame.user_id == USER && frame.pcm.len() == SAMPLES_PER_FRAME));
		assert_eq!(listener.stats()[&USER].frames, 3);
	}

	#[test]
	fn packets_before_speaking_are_held_then_delivered() {
		let mut listener = listener();
		let mut sender = Sender::new(THEIR_SSRC);
		let mut frames = Vec::new();
		let now = Instant::now();
		let opus = opus_frame();

		for _ in 0..4 {
			listener.handle_packet(&sender.next(&opus), now, None, &mut |frame| frames.push(frame));
		}
		assert!(frames.is_empty(), "nobody has claimed this SSRC yet");

		listener.membership(speaking(), now + Duration::from_millis(300), None, &mut |frame| {
			frames.push(frame)
		});
		assert_eq!(frames.len(), 4, "the first word survives");
		assert_eq!(frames[0].sequence, 100);
	}

	#[test]
	fn held_packets_expire_unclaimed() {
		let mut listener = listener();
		let mut sender = Sender::new(THEIR_SSRC);
		let start = Instant::now();
		listener.handle_packet(&sender.next(&opus_frame()), start, None, &mut |_| {});
		listener.expire(start + PENDING_WINDOW + Duration::from_millis(1));
		assert_eq!(listener.unattributed(), (0, 1));

		let mut frames = Vec::new();
		listener.membership(speaking(), start + Duration::from_secs(2), None, &mut |frame| {
			frames.push(frame)
		});
		assert!(frames.is_empty());
	}

	#[test]
	fn a_lost_packet_is_concealed_and_a_late_one_dropped() {
		let mut listener = listener();
		let mut sender = Sender::new(THEIR_SSRC);
		let mut frames = Vec::new();
		let now = Instant::now();
		let opus = opus_frame();
		listener.membership(speaking(), now, None, &mut |_| {});

		let first = sender.next(&opus);
		sender.skip();
		let third = sender.next(&opus);
		listener.handle_packet(&first, now, None, &mut |frame| frames.push(frame));
		listener.handle_packet(&third, now, None, &mut |frame| frames.push(frame));
		let flags: Vec<_> = frames.iter().map(|frame| (frame.sequence, frame.concealed)).collect();
		assert_eq!(flags, vec![(100, false), (101, true), (102, false)]);

		// The first packet again: behind the stream now.
		listener.handle_packet(&first, now, None, &mut |frame| frames.push(frame));
		assert_eq!(frames.len(), 3);
		assert_eq!(listener.stats()[&USER].late, 1);
		assert_eq!(listener.stats()[&USER].concealed, 1);
	}

	#[test]
	fn our_own_ssrc_and_rtcp_are_ignored() {
		let mut listener = listener();
		let mut ours = Sender::new(OUR_SSRC);
		let mut frames = Vec::new();
		let now = Instant::now();
		listener.membership(Membership::Speaking { user_id: 9, ssrc: OUR_SSRC }, now, None, &mut |_| {});
		assert_eq!(listener.user(OUR_SSRC), None);
		listener.handle_packet(&ours.next(&opus_frame()), now, None, &mut |frame| frames.push(frame));

		let mut rtcp = vec![0x81, 0xc9];
		rtcp.resize(40, 0);
		rtcp[8..12].copy_from_slice(&THEIR_SSRC.to_be_bytes());
		listener.handle_packet(&rtcp, now, None, &mut |frame| frames.push(frame));
		assert!(frames.is_empty());
		assert_eq!(listener.unattributed(), (0, 0), "neither is a failure");
	}

	#[test]
	fn a_new_ssrc_for_a_user_replaces_the_old_one_and_leaving_forgets_it() {
		let mut listener = listener();
		let now = Instant::now();
		listener.membership(speaking(), now, None, &mut |_| {});
		listener.membership(Membership::Speaking { user_id: USER, ssrc: 888 }, now, None, &mut |_| {});
		assert_eq!(listener.user(THEIR_SSRC), None);
		assert_eq!(listener.user(888), Some(USER));

		listener.membership(Membership::Disconnect { user_id: USER }, now, None, &mut |_| {});
		assert_eq!(listener.user(888), None);
	}

	#[test]
	fn a_dave_call_without_keys_counts_failures_against_the_sender() {
		let mut listener = listener();
		let mut sender = Sender::new(THEIR_SSRC);
		let now = Instant::now();
		let driver = Mutex::new(Driver::new(1, 1, 2).unwrap());
		listener.membership(speaking(), now, Some(&driver), &mut |_| {});

		// Encrypted under a key the driver was never given.
		let mut frame = Vec::new();
		crate::dave::frame::Encryptor::new(vec![1u8; 16]).encrypt_opus(&opus_frame(), &mut frame).unwrap();
		let mut frames = Vec::new();
		listener.handle_packet(&sender.next(&frame), now, Some(&driver), &mut |frame| frames.push(frame));
		assert!(frames.is_empty());
		assert_eq!(listener.stats()[&USER].dave_failures, 1);

		// Silence is never end-to-end encrypted, and still decodes.
		listener.handle_packet(&sender.next(&crate::SILENCE_FRAME), now, Some(&driver), &mut |frame| {
			frames.push(frame)
		});
		assert_eq!(frames.len(), 1);
	}
}
