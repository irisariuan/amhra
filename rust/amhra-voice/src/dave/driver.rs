//! Maps gateway DAVE opcodes onto the MLS session.
//!
//! Pure logic: it takes a message in and returns the messages that should go
//! out, so the ordering rules can be tested without a socket. The ordering is
//! the part that bites — a transition applied at the wrong moment does not
//! error, it just makes every later frame undecryptable to everyone else.
//!
//! Transitions come in two shapes. `transition_id == 0` is immediate: the new
//! key material is already in force. Anything else is a two-phase commit — the
//! client prepares, answers `dave_transition_ready (23)`, and only switches
//! when the server sends `dave_execute_transition (22)`.

use std::collections::HashMap;

use super::session::{Session, SessionError, Status};
use crate::wire::Opcode;

/// What the driver wants sent back to the gateway.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
	/// A binary frame: opcode then payload.
	Binary { opcode: Opcode, payload: Vec<u8> },
	/// A JSON frame carrying only a transition id.
	Transition { opcode: Opcode, transition_id: u16 },
}

pub struct Driver {
	session: Session,
	/// Transitions announced but not yet executed, and the version each moves
	/// to. Kept so `execute` knows what it is applying.
	pending: HashMap<u16, u8>,
	/// The last transition actually applied, for logs.
	applied: u16,
	/// The DAVE version in force right now.
	///
	/// Zero means the call has been downgraded — a client that cannot do DAVE
	/// joined, and from the moment that transition executes everyone sends
	/// under transport encryption alone. Media encrypted anyway would be noise
	/// to every listener.
	version: u8,
}

impl std::fmt::Debug for Driver {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Driver")
			.field("session", &self.session)
			.field("pending", &self.pending.len())
			.field("applied", &self.applied)
			.field("version", &self.version)
			.finish()
	}
}

impl Driver {
	pub fn new(protocol_version: u8, user_id: u64, channel_id: u64) -> Result<Self, SessionError> {
		Ok(Self {
			session: Session::new(protocol_version, user_id, channel_id)?,
			pending: HashMap::new(),
			applied: 0,
			version: protocol_version,
		})
	}

	/// The messages to send as soon as the session exists.
	///
	/// The key package goes out unprompted: the server waits for it before it
	/// will announce an external sender, so a client that only answers `op25`
	/// waits forever for a message that is waiting on it.
	pub fn start(&mut self) -> Result<Vec<Action>, SessionError> {
		let key_package = self.session.key_package()?;
		Ok(vec![Action::Binary { opcode: Opcode::DaveMlsKeyPackage, payload: key_package }])
	}

	pub fn session(&self) -> &Session {
		&self.session
	}

	pub fn session_mut(&mut self) -> &mut Session {
		&mut self.session
	}

	pub fn is_ready(&self) -> bool {
		self.session.is_ready()
	}

	/// The DAVE version in force, zero once the call has downgraded.
	pub fn version(&self) -> u8 {
		self.version
	}

	/// Whether media has to be end-to-end encrypted right now.
	pub fn encrypting(&self) -> bool {
		self.version > 0
	}

	/// Whether frames may go out at all.
	///
	/// Either DAVE is off for this call, or the group is live. Sending while a
	/// group is still forming would produce audio nobody can decrypt, so the
	/// sender waits — but waiting on a group that will never exist, which is
	/// what a downgrade leaves behind, is silence with no end to it.
	pub fn can_send(&self) -> bool {
		!self.encrypting() || self.session.is_ready()
	}

	/// Handle one DAVE message. `data` is the JSON body for the JSON opcodes;
	/// `payload` is the binary body for the MLS ones.
	pub fn handle(
		&mut self,
		opcode: Opcode,
		data: &serde_json::Value,
		payload: &[u8],
	) -> Result<Vec<Action>, SessionError> {
		match opcode {
			// The server's signing key, which the group context must carry
			// before a welcome can be trusted. The key package has already gone
			// out by this point, so nothing is sent in reply.
			Opcode::DaveMlsExternalSender => {
				self.session.set_external_sender(payload)?;
				Ok(Vec::new())
			}

			// The server proposes membership changes; committing them is how the
			// group actually forms, including the first time.
			Opcode::DaveMlsProposals => {
				let Some((&optype, proposals)) = payload.split_first() else {
					return Err(SessionError::Decode("proposals payload is empty".to_owned()));
				};
				// 0 appends proposals, 1 revokes them by reference.
				match self.session.process_proposals(optype == 0, proposals)? {
					Some(commit_welcome) => Ok(vec![Action::Binary {
						opcode: Opcode::DaveMlsCommitWelcome,
						payload: commit_welcome,
					}]),
					None => Ok(Vec::new()),
				}
			}

			Opcode::DaveMlsWelcome => {
				let (transition_id, message) = split_transition(payload)?;
				self.session.process_welcome(message)?;
				Ok(self.after_epoch_change(transition_id))
			}

			Opcode::DaveMlsAnnounceCommitTransition => {
				let (transition_id, message) = split_transition(payload)?;
				self.session.process_commit(message)?;
				Ok(self.after_epoch_change(transition_id))
			}

			Opcode::DavePrepareTransition => {
				let transition_id = json_u16(data, "transition_id");
				let version = json_u16(data, "protocol_version") as u8;
				if transition_id == 0 {
					// Immediate: nothing to acknowledge, it is already in force.
					self.applied = 0;
					self.version = version;
					return Ok(Vec::new());
				}
				self.pending.insert(transition_id, version);
				Ok(vec![Action::Transition {
					opcode: Opcode::DaveTransitionReady,
					transition_id,
				}])
			}

			Opcode::DaveExecuteTransition => {
				let transition_id = json_u16(data, "transition_id");
				// The version only moves here, not when the transition was
				// announced: until the server says execute, everyone else is
				// still on the old one.
				if let Some(version) = self.pending.remove(&transition_id) {
					self.version = version;
				}
				self.applied = transition_id;
				Ok(Vec::new())
			}

			// A new epoch is coming and the group has to be rebuilt from
			// scratch: the server wants a fresh key package for it.
			Opcode::DavePrepareEpoch => {
				let epoch = data.get("epoch").and_then(serde_json::Value::as_u64).unwrap_or(0);
				let version = json_u16(data, "protocol_version") as u8;
				// Epoch 1 is a group that does not exist yet. Anything else is a
				// version change on the group we are already in, and the
				// transition opcodes carry that.
				if epoch != 1 || version == 0 {
					return Ok(Vec::new());
				}
				let (user, channel) = (self.user_id(), self.channel_id());
				// The server announces its signing key once per voice session,
				// not once per epoch. A rebuilt session that dropped it would
				// refuse the welcome that follows, which is the same dead end
				// as never rebuilding at all.
				let carried = self.session.external_sender_payload().map(<[u8]>::to_vec);
				self.session = Session::new(version, user, channel)?;
				self.pending.clear();
				if let Some(payload) = carried {
					self.session.set_external_sender(&payload)?;
				}
				// The rebuilt session has no group, and the server drives the
				// join off the key package. Without a fresh one it never sends
				// an external sender or a welcome, so every later proposal
				// lands on a group we are not in and the sender stays mute for
				// the rest of the call.
				self.start()
			}

			// The server rejected our commit; it will re-drive the join.
			Opcode::DaveMlsInvalidCommitWelcome => {
				self.pending.clear();
				Ok(Vec::new())
			}

			_ => Ok(Vec::new()),
		}
	}

	/// After a welcome or commit lands, an immediate transition needs no reply
	/// while a numbered one has to be acknowledged before it takes effect.
	fn after_epoch_change(&mut self, transition_id: u16) -> Vec<Action> {
		if transition_id == 0 {
			self.applied = 0;
			return Vec::new();
		}
		self.pending.insert(transition_id, super::PROTOCOL_VERSION);
		vec![Action::Transition { opcode: Opcode::DaveTransitionReady, transition_id }]
	}

	fn user_id(&self) -> u64 {
		self.session.user_id()
	}

	fn channel_id(&self) -> u64 {
		self.session.channel_id()
	}

	/// Encrypt an Opus packet, if the group is live.
	pub fn encrypt_opus(&mut self, packet: &[u8], out: &mut Vec<u8>) -> Result<(), SessionError> {
		self.session.encrypt_opus(packet, out)
	}

	pub fn status(&self) -> Status {
		self.session.status()
	}
}

/// MLS payloads are prefixed with the transition they belong to.
fn split_transition(payload: &[u8]) -> Result<(u16, &[u8]), SessionError> {
	if payload.len() < 2 {
		return Err(SessionError::Decode("payload has no transition id".to_owned()));
	}
	Ok((u16::from_be_bytes([payload[0], payload[1]]), &payload[2..]))
}

fn json_u16(data: &serde_json::Value, field: &str) -> u16 {
	data.get(field).and_then(serde_json::Value::as_u64).unwrap_or(0) as u16
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	const USER: u64 = 956_459_806_691_065_856;
	const CHANNEL: u64 = 1_409_777_228_618_661_921;

	fn driver() -> Driver {
		Driver::new(1, USER, CHANNEL).unwrap()
	}

	/// An `op25` payload shaped like the one the voice server sends.
	fn external_sender() -> Vec<u8> {
		use openmls::prelude::*;
		use tls_codec::Serialize;

		let key: SignaturePublicKey = vec![7u8; 65].into();
		let credential: Credential = BasicCredential::new(b"discord".to_vec()).into();
		ExternalSender::new(key, credential).tls_serialize_detached().unwrap()
	}

	#[test]
	fn a_numbered_transition_is_acknowledged_then_executed() {
		let mut driver = driver();
		let actions = driver
			.handle(
				Opcode::DavePrepareTransition,
				&json!({ "transition_id": 7, "protocol_version": 1 }),
				&[],
			)
			.unwrap();
		assert_eq!(
			actions,
			vec![Action::Transition { opcode: Opcode::DaveTransitionReady, transition_id: 7 }]
		);
		assert_eq!(driver.pending.len(), 1);

		let actions = driver
			.handle(Opcode::DaveExecuteTransition, &json!({ "transition_id": 7 }), &[])
			.unwrap();
		assert!(actions.is_empty());
		assert!(driver.pending.is_empty(), "executing must clear the pending transition");
		assert_eq!(driver.applied, 7);
	}

	#[test]
	fn transition_zero_is_immediate_and_unacknowledged() {
		let mut driver = driver();
		let actions = driver
			.handle(
				Opcode::DavePrepareTransition,
				&json!({ "transition_id": 0, "protocol_version": 1 }),
				&[],
			)
			.unwrap();
		// Acknowledging transition 0 would be answering a question nobody asked.
		assert!(actions.is_empty());
		assert!(driver.pending.is_empty());
	}

	#[test]
	fn mls_payloads_are_split_from_their_transition_id() {
		assert_eq!(split_transition(&[0x00, 0x07, 0xaa, 0xbb]).unwrap(), (7, &[0xaa, 0xbb][..]));
		assert_eq!(split_transition(&[0x00, 0x00, 0x01]).unwrap(), (0, &[0x01][..]));
		// A frame too short to hold an id is not a welcome we can act on.
		assert!(split_transition(&[0x00]).is_err());
		assert!(split_transition(&[]).is_err());
	}

	#[test]
	fn a_malformed_external_sender_leaves_the_session_shut() {
		let mut driver = driver();
		let error = driver
			.handle(Opcode::DaveMlsExternalSender, &serde_json::Value::Null, b"garbage")
			.unwrap_err();
		assert!(matches!(error, SessionError::Decode(_)));
		assert_eq!(driver.status(), Status::Uninitialised);
	}

	#[test]
	fn the_key_package_is_offered_without_being_asked() {
		let mut driver = driver();
		let actions = driver.start().unwrap();
		let [Action::Binary { opcode, payload }] = actions.as_slice() else {
			panic!("expected exactly one key package, got {actions:?}");
		};
		assert_eq!(*opcode, Opcode::DaveMlsKeyPackage);
		assert!(payload.len() > 32);
	}

	#[test]
	fn an_invalid_commit_notice_clears_pending_transitions() {
		let mut driver = driver();
		driver
			.handle(
				Opcode::DavePrepareTransition,
				&json!({ "transition_id": 3, "protocol_version": 1 }),
				&[],
			)
			.unwrap();
		assert_eq!(driver.pending.len(), 1);

		driver
			.handle(Opcode::DaveMlsInvalidCommitWelcome, &json!({ "transition_id": 3 }), &[])
			.unwrap();
		assert!(driver.pending.is_empty());
	}

	#[test]
	fn epoch_one_restarts_the_session_and_offers_a_new_key_package() {
		let mut driver = driver();
		let actions = driver
			.handle(
				Opcode::DavePrepareEpoch,
				&json!({ "epoch": 1, "protocol_version": 1 }),
				&[],
			)
			.unwrap();
		// A fresh session is uninitialised until the next external sender.
		assert_eq!(driver.status(), Status::Uninitialised);
		// Without the key package the server never drives the join again, and
		// the group this session is waiting for is never built.
		let [Action::Binary { opcode, payload }] = actions.as_slice() else {
			panic!("expected a key package for the new epoch, got {actions:?}");
		};
		assert_eq!(*opcode, Opcode::DaveMlsKeyPackage);
		assert!(payload.len() > 32);
	}

	#[test]
	fn a_rebuilt_session_keeps_the_external_sender_it_was_given() {
		let mut driver = driver();
		driver
			.handle(Opcode::DaveMlsExternalSender, &serde_json::Value::Null, &external_sender())
			.unwrap();
		assert_eq!(driver.status(), Status::Pending);

		driver
			.handle(Opcode::DavePrepareEpoch, &json!({ "epoch": 1, "protocol_version": 1 }), &[])
			.unwrap();
		// The server does not re-announce its key for the new epoch, so a
		// session that dropped it could never accept the welcome that follows.
		assert_eq!(
			driver.status(),
			Status::Pending,
			"the rebuilt session must already be waiting on a welcome, not on an external sender"
		);
	}

	#[test]
	fn a_rebuilt_session_still_blocks_sending_until_the_group_is_live() {
		let mut driver = driver();
		driver
			.handle(Opcode::DavePrepareEpoch, &json!({ "epoch": 1, "protocol_version": 1 }), &[])
			.unwrap();
		assert!(driver.encrypting(), "the call is still end-to-end encrypted");
		assert!(!driver.can_send(), "there is no key to send under yet");
	}

	#[test]
	fn a_downgrade_stops_encrypting_and_unblocks_the_sender() {
		let mut driver = driver();
		assert!(driver.encrypting());
		// A client that cannot do DAVE joined: the call moves to version 0.
		driver
			.handle(
				Opcode::DavePrepareTransition,
				&json!({ "transition_id": 4, "protocol_version": 0 }),
				&[],
			)
			.unwrap();
		// Announced is not executed — everyone else is still encrypting.
		assert!(driver.encrypting());

		driver.handle(Opcode::DaveExecuteTransition, &json!({ "transition_id": 4 }), &[]).unwrap();
		assert!(!driver.encrypting());
		assert_eq!(driver.version(), 0);
		// The group will never form now, so waiting on it would be silence
		// with no end.
		assert!(driver.can_send());
	}

	#[test]
	fn an_immediate_transition_applies_its_version_at_once() {
		let mut driver = driver();
		driver
			.handle(
				Opcode::DavePrepareTransition,
				&json!({ "transition_id": 0, "protocol_version": 0 }),
				&[],
			)
			.unwrap();
		assert_eq!(driver.version(), 0);
		assert!(driver.can_send());
	}
}
