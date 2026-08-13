//! The sender key ratchet (RFC 9420 §9.1, as DAVE uses it).
//!
//! One base secret comes out of the MLS exporter per sender. Every generation
//! derives a key and a nonce from the current secret, then replaces the secret
//! with its own derivation — so a leaked generation cannot produce the ones
//! before it.
//!
//! Only 256 generations exist on the wire: the generation travels in the top
//! byte of the 32-bit frame nonce, so it wraps, and the sender moves to the
//! next generation each time the low 24 bits of the nonce roll over.

use std::collections::HashMap;

use super::kdf::{InvalidLength, derive_tree_secret};

/// AES-128-GCM key length.
pub const KEY_LEN: usize = 16;
/// AES-128-GCM nonce length.
pub const NONCE_LEN: usize = 12;
/// SHA-256 output, the width of the ratchet secret.
const SECRET_LEN: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum RatchetError {
	#[error("generation {0} has already been used and erased")]
	Expired(u32),
	#[error("deriving generation {0} failed")]
	Derivation(u32),
	#[error("generation {0} is more than {1} ahead of the ratchet")]
	TooFarAhead(u32, u32),
}

/// Refuse to spin the ratchet forward more than this in one step. A generation
/// far in the future is a corrupt frame, and deriving toward it would burn CPU
/// on nothing.
const MAX_GENERATION_GAP: u32 = 250;

#[derive(Debug, Clone)]
pub struct KeyMaterial {
	pub key: [u8; KEY_LEN],
	pub nonce: [u8; NONCE_LEN],
}

pub struct HashRatchet {
	next_secret: Vec<u8>,
	next_generation: u32,
	cache: HashMap<u32, KeyMaterial>,
}

impl std::fmt::Debug for HashRatchet {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		// Secrets and derived keys stay out of logs.
		f.debug_struct("HashRatchet")
			.field("next_generation", &self.next_generation)
			.field("cached_generations", &self.cache.len())
			.finish_non_exhaustive()
	}
}

impl HashRatchet {
	pub fn new(base_secret: Vec<u8>) -> Self {
		Self { next_secret: base_secret, next_generation: 0, cache: HashMap::new() }
	}

	/// Key material for `generation`, deriving forward if needed.
	pub fn get(&mut self, generation: u32) -> Result<&KeyMaterial, RatchetError> {
		if !self.cache.contains_key(&generation) {
			if self.next_generation > generation {
				return Err(RatchetError::Expired(generation));
			}
			if generation - self.next_generation > MAX_GENERATION_GAP {
				return Err(RatchetError::TooFarAhead(generation, MAX_GENERATION_GAP));
			}
			while self.next_generation <= generation {
				self.advance()?;
			}
		}
		Ok(self.cache.get(&generation).expect("just derived"))
	}

	/// Drop a generation's key once it can no longer be needed.
	pub fn erase(&mut self, generation: u32) {
		self.cache.remove(&generation);
	}

	fn advance(&mut self) -> Result<(), RatchetError> {
		let generation = self.next_generation;
		let derive = |label: &str, length: usize| {
			derive_tree_secret(&self.next_secret, label, generation, length)
				.map_err(|InvalidLength| RatchetError::Derivation(generation))
		};

		let key = derive("key", KEY_LEN)?;
		let nonce = derive("nonce", NONCE_LEN)?;
		let secret = derive("secret", SECRET_LEN)?;

		self.next_secret = secret;
		self.next_generation = self.next_generation.wrapping_add(1);
		self.cache.insert(
			generation,
			KeyMaterial {
				key: key.try_into().expect("derived to KEY_LEN"),
				nonce: nonce.try_into().expect("derived to NONCE_LEN"),
			},
		);
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Known-answer test taken from davey's own ratchet test, which is in turn
	/// checked against libdave. If this passes, the KDF, the label encoding and
	/// the MLS++ expansion quirk are all right; if it fails, audio would be
	/// silently undecryptable and nothing else here would say why.
	#[test]
	fn matches_the_reference_implementation() {
		let base = vec![206, 221, 97, 177, 184, 161, 202, 105, 4, 101, 84, 40, 44, 247, 11, 123];
		let mut ratchet = HashRatchet::new(base);
		let material = ratchet.get(0).expect("generation 0");

		assert_eq!(
			material.key,
			[117, 48, 249, 169, 148, 94, 45, 46, 6, 208, 101, 31, 123, 42, 134, 75]
		);
		assert_eq!(material.nonce, [48, 30, 95, 75, 116, 9, 15, 152, 94, 114, 107, 178]);
	}

	#[test]
	fn generations_differ_and_are_cached() {
		let mut ratchet = HashRatchet::new(vec![9u8; 16]);
		let first = ratchet.get(0).unwrap().clone();
		let second = ratchet.get(1).unwrap().clone();
		assert_ne!(first.key, second.key);
		// Re-asking must not re-derive into a different answer.
		assert_eq!(ratchet.get(0).unwrap().key, first.key);
	}

	#[test]
	fn skipping_ahead_still_lands_on_the_right_key() {
		let mut sequential = HashRatchet::new(vec![3u8; 16]);
		for generation in 0..=5 {
			let _ = sequential.get(generation).unwrap();
		}
		let expected = sequential.get(5).unwrap().clone();

		let mut jumped = HashRatchet::new(vec![3u8; 16]);
		assert_eq!(jumped.get(5).unwrap().key, expected.key);
	}

	#[test]
	fn erased_generations_cannot_come_back() {
		let mut ratchet = HashRatchet::new(vec![1u8; 16]);
		let _ = ratchet.get(0).unwrap();
		let _ = ratchet.get(1).unwrap();
		ratchet.erase(0);
		assert!(matches!(ratchet.get(0), Err(RatchetError::Expired(0))));
	}

	#[test]
	fn absurd_generations_are_refused_rather_than_derived() {
		let mut ratchet = HashRatchet::new(vec![1u8; 16]);
		assert!(matches!(ratchet.get(10_000), Err(RatchetError::TooFarAhead(_, _))));
	}
}
