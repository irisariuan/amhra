//! Receive-side DAVE: one sender's keys across epochs and generations.
//!
//! Sending needs one key at a time. Receiving needs several, because nobody
//! switches at the same instant: when the group moves to a new epoch, a
//! sender's frames under the old one are still in flight, and when a sender's
//! nonce rolls into a new generation, a reordered packet from the last one can
//! still arrive. So each sender has a short queue of epochs, each epoch keeps
//! the generations it has used, and anything superseded is kept for
//! [`KEY_EXPIRY`] and then erased.
//!
//! Ported from libdave's `Decryptor` and `CryptorManager` by way of `davey`,
//! with one deliberate difference: epochs are tried newest first. Either order
//! is correct — the tag decides — but after a transition almost every frame is
//! under the newest key.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use super::frame::{self, ParsedFrame};
use super::ratchet::HashRatchet;
use crate::crypto::SILENCE_FRAME;

/// How long superseded keys stay usable — a previous epoch, or a previous
/// generation within one.
pub const KEY_EXPIRY: Duration = Duration::from_secs(10);
/// Nonces below the newest that may still arrive late, at most.
const MAX_MISSING_NONCES: usize = 1000;
/// The generation travels in one byte, so it wraps here.
const GENERATION_WRAP: u32 = 1 << 8;
/// Refuse generations this far past the newest one seen. A real sender moves
/// one generation every 2²⁴ frames — 93 hours of audio.
const MAX_GENERATION_GAP: u32 = 250;
/// Low 24 bits of the frame nonce: the counter within a generation.
const NONCE_COUNTER_MASK: u64 = 0xff_ffff;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecryptError {
	/// A frame without DAVE's trailer, at a moment when everyone should be
	/// encrypting. Around transitions this is expected for a few frames.
	#[error("frame is not end-to-end encrypted and passthrough is off")]
	UnencryptedWhenPassthroughDisabled,
	#[error("no key for this sender opened the frame")]
	NoValidKey,
	#[error("no keys for user {0}")]
	NoDecryptor(u64),
}

/// What happened to a frame that was handed back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decrypted {
	/// Opened under a sender key.
	Opened,
	/// Accepted in the clear: the call is not end-to-end encrypted, or is
	/// between versions.
	Passthrough,
	/// The three-byte Opus silence frame, which is never encrypted.
	Silence,
}

/// One epoch's keys for one sender — libdave's `CryptorManager`.
struct EpochKeys {
	ratchet: HashRatchet,
	/// Superseded generations, and when each stops being accepted.
	expiring: HashMap<u32, Instant>,
	oldest_generation: u32,
	newest_generation: u32,
	/// The highest generation-and-counter that has opened.
	newest_nonce: Option<u64>,
	/// Nonces below the newest that have not been seen yet, oldest first.
	missing: VecDeque<u64>,
	/// Set once a newer epoch replaces this one.
	expires_at: Option<Instant>,
}

impl EpochKeys {
	fn new(base_secret: Vec<u8>) -> Self {
		Self {
			ratchet: HashRatchet::new(base_secret),
			expiring: HashMap::new(),
			oldest_generation: 0,
			newest_generation: 0,
			newest_nonce: None,
			missing: VecDeque::new(),
			expires_at: None,
		}
	}

	fn is_expired(&self, now: Instant) -> bool {
		self.expires_at.is_some_and(|at| now > at)
	}

	fn try_open(
		&mut self,
		parsed: &ParsedFrame,
		frame: &[u8],
		out: &mut Vec<u8>,
		now: Instant,
	) -> bool {
		self.erase_expired(now);
		let generation = wrapped_generation(self.oldest_generation, parsed.generation());
		let big_nonce = (u64::from(generation) << 24) | (u64::from(parsed.nonce) & NONCE_COUNTER_MASK);

		// Replays are refused before any key is derived: a nonce opens once.
		if !self.can_process(big_nonce) {
			return false;
		}
		if generation < self.oldest_generation
			|| generation > self.newest_generation.saturating_add(MAX_GENERATION_GAP)
		{
			return false;
		}
		let Ok(material) = self.ratchet.get(generation) else { return false };
		let key = material.key;
		if !frame::open_frame(&key, parsed, frame, out) {
			return false;
		}
		self.record(generation, big_nonce, now);
		true
	}

	fn can_process(&self, big_nonce: u64) -> bool {
		match self.newest_nonce {
			None => true,
			Some(newest) => big_nonce > newest || self.missing.contains(&big_nonce),
		}
	}

	/// Book-keeping after a frame opened. Only an authenticated frame may move
	/// any of this, or a forger could expire live keys.
	fn record(&mut self, generation: u32, big_nonce: u64, now: Instant) {
		match self.newest_nonce {
			Some(newest) if big_nonce <= newest => {
				if let Some(index) = self.missing.iter().position(|&nonce| nonce == big_nonce) {
					self.missing.remove(index);
				}
			}
			newest => {
				// Everything skipped between the last frame and this one may
				// still turn up, within the window.
				let floor = big_nonce.saturating_sub(MAX_MISSING_NONCES as u64);
				let first_skipped = newest.map_or(big_nonce, |newest| newest + 1).max(floor);
				self.missing.extend(first_skipped..big_nonce);
				while self.missing.front().is_some_and(|&nonce| nonce < floor)
					|| self.missing.len() > MAX_MISSING_NONCES
				{
					self.missing.pop_front();
				}
				self.newest_nonce = Some(big_nonce);
			}
		}

		if generation > self.newest_generation {
			for old in self.oldest_generation..generation {
				self.expiring.entry(old).or_insert(now + KEY_EXPIRY);
			}
			self.newest_generation = generation;
		}
	}

	fn erase_expired(&mut self, now: Instant) {
		let ratchet = &mut self.ratchet;
		self.expiring.retain(|&generation, &mut at| {
			let keep = now <= at;
			if !keep {
				ratchet.erase(generation);
			}
			keep
		});
		self.oldest_generation =
			self.expiring.keys().copied().min().unwrap_or(self.newest_generation);
	}
}

/// Turn the one-byte generation on the wire back into the full one.
///
/// Assumes the frame is no older than the oldest live generation; the range
/// check after it catches the frames for which that is wrong. Reaching a wrap
/// takes 2³² frames in one epoch, so this is about correctness, not traffic.
fn wrapped_generation(oldest: u32, generation: u32) -> u32 {
	let wraps = oldest / GENERATION_WRAP + u32::from(generation < oldest % GENERATION_WRAP);
	wraps * GENERATION_WRAP + generation
}

/// All of one sender's keys.
#[derive(Default)]
pub struct Decryptor {
	/// Oldest first; the last is the current epoch.
	epochs: VecDeque<EpochKeys>,
}

impl std::fmt::Debug for Decryptor {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Decryptor").field("epochs", &self.epochs.len()).finish_non_exhaustive()
	}
}

impl Decryptor {
	pub fn new() -> Self {
		Self::default()
	}

	/// Start accepting a new epoch's key, and give every older one
	/// [`KEY_EXPIRY`] to drain.
	pub fn add_epoch(&mut self, base_secret: Vec<u8>, now: Instant) {
		let deadline = now + KEY_EXPIRY;
		for epoch in &mut self.epochs {
			epoch.expires_at = Some(epoch.expires_at.map_or(deadline, |at| at.min(deadline)));
		}
		self.epochs.push_back(EpochKeys::new(base_secret));
	}

	/// Decrypt one frame from this sender into `out`.
	///
	/// `passthrough` says whether a frame without DAVE's trailer is acceptable
	/// right now; the caller knows the call's transition state, this does not.
	pub fn decrypt(
		&mut self,
		frame: &[u8],
		out: &mut Vec<u8>,
		now: Instant,
		passthrough: bool,
	) -> Result<Decrypted, DecryptError> {
		if frame == SILENCE_FRAME {
			out.clear();
			out.extend_from_slice(frame);
			return Ok(Decrypted::Silence);
		}
		while self.epochs.front().is_some_and(|epoch| epoch.is_expired(now)) {
			self.epochs.pop_front();
		}

		let Some(parsed) = frame::parse_frame(frame) else {
			return pass_through(frame, out, passthrough);
		};
		for epoch in self.epochs.iter_mut().rev() {
			if epoch.try_open(&parsed, frame, out, now) {
				return Ok(Decrypted::Opened);
			}
		}
		Err(DecryptError::NoValidKey)
	}
}

/// Accept a cleartext frame if passthrough allows it.
pub(crate) fn pass_through(
	frame: &[u8],
	out: &mut Vec<u8>,
	passthrough: bool,
) -> Result<Decrypted, DecryptError> {
	if !passthrough {
		return Err(DecryptError::UnencryptedWhenPassthroughDisabled);
	}
	out.clear();
	out.extend_from_slice(frame);
	Ok(Decrypted::Passthrough)
}

#[cfg(test)]
mod tests {
	use super::super::frame::Encryptor;
	use super::*;

	const SECRET: [u8; 16] = [3u8; 16];

	fn decryptor(now: Instant) -> Decryptor {
		let mut decryptor = Decryptor::new();
		decryptor.add_epoch(SECRET.to_vec(), now);
		decryptor
	}

	fn encrypt(encryptor: &mut Encryptor, opus: &[u8]) -> Vec<u8> {
		let mut frame = Vec::new();
		encryptor.encrypt_opus(opus, &mut frame).unwrap();
		frame
	}

	#[test]
	fn frames_from_a_sender_open_in_order() {
		let now = Instant::now();
		let mut decryptor = decryptor(now);
		let mut sender = Encryptor::new(SECRET.to_vec());
		let mut out = Vec::new();
		for index in 0..20u8 {
			let frame = encrypt(&mut sender, &[0xfc, index]);
			assert_eq!(decryptor.decrypt(&frame, &mut out, now, false), Ok(Decrypted::Opened));
			assert_eq!(out, [0xfc, index]);
		}
	}

	#[test]
	fn a_replayed_frame_is_refused_but_a_late_one_is_not() {
		let now = Instant::now();
		let mut decryptor = decryptor(now);
		let mut sender = Encryptor::new(SECRET.to_vec());
		let mut out = Vec::new();
		let first = encrypt(&mut sender, b"one");
		let second = encrypt(&mut sender, b"two");
		let third = encrypt(&mut sender, b"three");

		decryptor.decrypt(&first, &mut out, now, false).unwrap();
		decryptor.decrypt(&third, &mut out, now, false).unwrap();
		// Reordered: older than the newest, but never seen.
		assert_eq!(decryptor.decrypt(&second, &mut out, now, false), Ok(Decrypted::Opened));
		assert_eq!(out, b"two");
		// Seen: a second copy is a replay.
		for frame in [&first, &second, &third] {
			assert_eq!(decryptor.decrypt(frame, &mut out, now, false), Err(DecryptError::NoValidKey));
		}
	}

	#[test]
	fn the_previous_epoch_drains_for_ten_seconds() {
		let start = Instant::now();
		let mut decryptor = decryptor(start);
		let mut old_sender = Encryptor::new(SECRET.to_vec());
		let mut new_sender = Encryptor::new(vec![4u8; 16]);
		let mut out = Vec::new();

		decryptor.decrypt(&encrypt(&mut old_sender, b"a"), &mut out, start, false).unwrap();
		decryptor.add_epoch(vec![4u8; 16], start);

		// Both epochs open during the overlap.
		let soon = start + Duration::from_secs(2);
		assert!(decryptor.decrypt(&encrypt(&mut new_sender, b"new"), &mut out, soon, false).is_ok());
		assert!(decryptor.decrypt(&encrypt(&mut old_sender, b"old"), &mut out, soon, false).is_ok());
		assert_eq!(out, b"old");

		// After it, only the new one does.
		let later = start + KEY_EXPIRY + Duration::from_millis(1);
		assert_eq!(
			decryptor.decrypt(&encrypt(&mut old_sender, b"old"), &mut out, later, false),
			Err(DecryptError::NoValidKey)
		);
		assert!(decryptor.decrypt(&encrypt(&mut new_sender, b"new"), &mut out, later, false).is_ok());
	}

	#[test]
	fn cleartext_needs_passthrough_and_silence_never_does() {
		let now = Instant::now();
		let mut decryptor = decryptor(now);
		let mut out = Vec::new();

		assert_eq!(
			decryptor.decrypt(&[0xfc, 1, 2], &mut out, now, false),
			Err(DecryptError::UnencryptedWhenPassthroughDisabled)
		);
		assert_eq!(decryptor.decrypt(&[0xfc, 1, 2], &mut out, now, true), Ok(Decrypted::Passthrough));
		assert_eq!(out, [0xfc, 1, 2]);
		assert_eq!(decryptor.decrypt(&SILENCE_FRAME, &mut out, now, false), Ok(Decrypted::Silence));
		assert_eq!(out, SILENCE_FRAME);
	}

	#[test]
	fn passthrough_never_rescues_a_frame_that_failed_its_tag() {
		let now = Instant::now();
		let mut decryptor = decryptor(now);
		let mut frame = encrypt(&mut Encryptor::new(SECRET.to_vec()), b"secret");
		frame[0] ^= 1;
		let mut out = Vec::new();
		// It parsed as a DAVE frame, so it is a forgery, not a cleartext frame.
		assert_eq!(decryptor.decrypt(&frame, &mut out, now, true), Err(DecryptError::NoValidKey));
	}

	#[test]
	fn generations_wrap_relative_to_the_oldest_live_one() {
		assert_eq!(wrapped_generation(0, 5), 5);
		assert_eq!(wrapped_generation(250, 251), 251);
		// Past the wrap: 2 after 250 is 258, not 2.
		assert_eq!(wrapped_generation(250, 2), 258);
		assert_eq!(wrapped_generation(512, 0), 512);
	}

	#[test]
	fn an_old_generation_is_erased_after_the_sender_moves_on() {
		let start = Instant::now();
		let mut decryptor = decryptor(start);
		// The last frames of generation 0: a straggler has to be within the
		// missing-nonce window of the first frame of generation 1 to count.
		let mut sender = Encryptor::new(SECRET.to_vec());
		sender.set_nonce_for_test((1 << 24) - 3);
		let mut out = Vec::new();

		let early = encrypt(&mut sender, b"gen0 first");
		let straggler = encrypt(&mut sender, b"gen0 late");
		decryptor.decrypt(&early, &mut out, start, false).unwrap();

		// The same sender, 2²⁴ frames later: generation 1.
		let mut moved = Encryptor::new(SECRET.to_vec());
		moved.set_nonce_for_test(1 << 24);
		let frame = encrypt(&mut moved, b"gen1");
		decryptor.decrypt(&frame, &mut out, start, false).unwrap();
		assert_eq!(out, b"gen1");

		// Generation 0 is superseded: still good for a while, then gone.
		let soon = start + Duration::from_secs(1);
		assert!(decryptor.decrypt(&straggler, &mut out, soon, false).is_ok());
		let late = encrypt(&mut sender, b"gen0 too late");
		let later = start + KEY_EXPIRY + Duration::from_secs(1);
		assert_eq!(decryptor.decrypt(&late, &mut out, later, false), Err(DecryptError::NoValidKey));
	}
}
