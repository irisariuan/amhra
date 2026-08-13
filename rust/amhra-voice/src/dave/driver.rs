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
}

impl std::fmt::Debug for Driver {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Driver")
			.field("session", &self.session)
			.field("pending", &self.pending.len())
			.field("applied", &self.applied)
			.finish()
	}
}

impl Driver {
	pub fn new(protocol_version: u8, user_id: u64, channel_id: u64) -> Result<Self, SessionError> {
		Ok(Self {
			session: Session::new(protocol_version, user_id, channel_id)?,
			pending: HashMap::new(),
			applied: 0,
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
				self.pending.remove(&transition_id);
				self.applied = transition_id;
				Ok(Vec::new())
			}

			// A new epoch is coming and the group has to be rebuilt from
			// scratch: the server wants a fresh key package for it.
			Opcode::DavePrepareEpoch => {
				let epoch = data.get("epoch").and_then(serde_json::Value::as_u64).unwrap_or(0);
				if epoch == 1 {
					let version = json_u16(data, "protocol_version") as u8;
					self.session = Session::new(version, self.user_id(), self.channel_id())?;
				}
				Ok(Vec::new())
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
	fn epoch_one_restarts_the_session() {
		let mut driver = driver();
		driver
			.handle(
				Opcode::DavePrepareEpoch,
				&json!({ "epoch": 1, "protocol_version": 1 }),
				&[],
			)
			.unwrap();
		// A fresh session is uninitialised until the next external sender.
		assert_eq!(driver.status(), Status::Uninitialised);
	}
}
