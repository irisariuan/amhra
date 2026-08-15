//! The MLS group session behind DAVE.
//!
//! This is a *sender-only* member. The protocol lets a client that never
//! decrypts skip receive-side frame handling, identity fingerprint checks and
//! persistent signature keys — a music bot talks and never listens, so all
//! three are left out and the signature key is generated fresh per session.
//!
//! What cannot be skipped is group membership: to send, the bot must really be
//! in the MLS group, tracking every epoch change, because the media key is
//! exported from the group secret.
//!
//! The join sequence, in the order the gateway drives it:
//!
//! ```text
//! op25 external sender  ->  set_external_sender()   (a pending group is made)
//! op26 key package      <-  key_package()
//! op30 welcome          ->  process_welcome()       (now a real member)
//! op29 announce commit  ->  process_commit()        (epoch moved)
//! op21/22 transitions   ->  the caller drives ready/execute
//! ```

use openmls::prelude::*;
use openmls::prelude::hash_ref::ProposalRef;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use openmls_basic_credential::SignatureKeyPair;
use tls_codec::{DeserializeBytes, Serialize};

use super::frame::{Encryptor, FrameError};
use super::{MEDIA_KEY_BASE_LABEL, MEDIA_KEY_BASE_LEN, PROTOCOL_VERSION};

/// DAVE v1's ciphersuite. The protocol pins exactly one.
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMP256_AES128GCM_SHA256_P256;

/// Key packages must not expire: DAVE validates against the widest possible
/// span, so the lifetime is the encoded `not_before = 0, not_after = u64::MAX`
/// rather than a duration. `Lifetime::new` takes a length from *now* and
/// overflows on anything this large.
const MAX_LIFETIME: [u8; 16] = [
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // not_before
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, // not_after
];

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
	#[error("dave protocol version {0} is not supported")]
	UnsupportedVersion(u8),
	#[error("no external sender has been received yet")]
	NoExternalSender,
	#[error("the group is not established yet")]
	NotEstablished,
	#[error("tls decode: {0}")]
	Decode(String),
	#[error("mls: {0}")]
	Mls(String),
	#[error("the welcome carried a different external sender than the gateway announced")]
	UnexpectedExternalSender,
	#[error("frame: {0}")]
	Frame(#[from] FrameError),
}

/// Where the session is in the join sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
	/// No external sender yet; nothing can be sent.
	Uninitialised,
	/// A pending group exists and a key package can be offered.
	Pending,
	/// We committed the server's proposals and are waiting for that commit to
	/// come back as `op29`. The group exists but its epoch is not settled.
	AwaitingResponse,
	/// A real group member with live key material.
	Active,
}

pub struct Session {
	provider: OpenMlsRustCrypto,
	signer: SignatureKeyPair,
	credential_with_key: CredentialWithKey,
	group_id: GroupId,
	user_id: u64,
	external_sender: Option<ExternalSender>,
	/// The bytes the external sender arrived as.
	///
	/// Kept so a session rebuilt for a new epoch can be handed the same key
	/// back: the server announces it once per voice session, not once per
	/// group, and a rebuilt session that lost it cannot accept the welcome
	/// that follows.
	external_sender_payload: Option<Vec<u8>>,
	group: Option<MlsGroup>,
	encryptor: Encryptor,
	status: Status,
}

impl std::fmt::Debug for Session {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Session")
			.field("user_id", &self.user_id)
			.field("status", &self.status)
			.field("epoch", &self.epoch())
			.finish_non_exhaustive()
	}
}

impl Session {
	/// Start a session for one user in one channel.
	///
	/// The MLS group id is the channel id and the credential identity is the
	/// user id, both big-endian — note that the *exporter context* for the same
	/// user id is little-endian. Getting either byte order wrong produces keys
	/// that are wrong in a way nothing reports.
	pub fn new(protocol_version: u8, user_id: u64, channel_id: u64) -> Result<Self, SessionError> {
		if protocol_version != PROTOCOL_VERSION {
			return Err(SessionError::UnsupportedVersion(protocol_version));
		}
		let provider = OpenMlsRustCrypto::default();
		let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
			.map_err(|error| SessionError::Mls(format!("{error:?}")))?;
		signer
			.store(provider.storage())
			.map_err(|error| SessionError::Mls(format!("{error:?}")))?;

		let credential = BasicCredential::new(user_id.to_be_bytes().to_vec());
		let credential_with_key = CredentialWithKey {
			credential: credential.into(),
			signature_key: signer.public().into(),
		};

		Ok(Self {
			provider,
			signer,
			credential_with_key,
			group_id: GroupId::from_slice(&channel_id.to_be_bytes()),
			user_id,
			external_sender: None,
			external_sender_payload: None,
			group: None,
			encryptor: Encryptor::new(vec![0u8; MEDIA_KEY_BASE_LEN]),
			status: Status::Uninitialised,
		})
	}

	pub fn status(&self) -> Status {
		self.status
	}

	pub fn user_id(&self) -> u64 {
		self.user_id
	}

	/// The channel id, recovered from the MLS group id it was encoded into.
	pub fn channel_id(&self) -> u64 {
		<[u8; 8]>::try_from(self.group_id.as_slice()).map(u64::from_be_bytes).unwrap_or(0)
	}

	pub fn is_ready(&self) -> bool {
		self.status == Status::Active
	}

	pub fn epoch(&self) -> Option<u64> {
		self.group.as_ref().map(|group| group.epoch().as_u64())
	}

	/// Handle `dave_mls_external_sender (25)`.
	///
	/// The voice server signs proposals as an external sender, so its public
	/// key has to be baked into the group context before anything else. Doing
	/// this also discards any earlier group: the old one belongs to a previous
	/// epoch of the channel and cannot be reused.
	pub fn set_external_sender(&mut self, payload: &[u8]) -> Result<(), SessionError> {
		let external_sender: ExternalSender = decode_untrusted(payload)?;
		self.external_sender = Some(external_sender);
		self.external_sender_payload = Some(payload.to_vec());
		self.group = None;
		self.create_pending_group()?;
		Ok(())
	}

	/// The external sender this session was given, as it arrived.
	pub fn external_sender_payload(&self) -> Option<&[u8]> {
		self.external_sender_payload.as_deref()
	}

	/// Payload for `dave_mls_key_package (26)`.
	///
	/// Key packages are single-use, so this builds a fresh one every call.
	pub fn key_package(&mut self) -> Result<Vec<u8>, SessionError> {
		let lifetime = Lifetime::tls_deserialize_exact_bytes(&MAX_LIFETIME)
			.expect("statically valid lifetime");
		let bundle = KeyPackage::builder()
			.key_package_extensions(Extensions::empty())
			.leaf_node_capabilities(capabilities())
			.key_package_lifetime(lifetime)
			.build(CIPHERSUITE, &self.provider, &self.signer, self.credential_with_key.clone())
			.map_err(|error| SessionError::Mls(format!("{error:?}")))?;

		bundle
			.key_package()
			.tls_serialize_detached()
			.map_err(|error| SessionError::Decode(error.to_string()))
	}

	/// Handle `dave_mls_proposals (27)`.
	///
	/// The voice server proposes who joins and leaves; members commit those
	/// proposals to move the group forward. `append` adds proposals to the
	/// pending set, `revoke` withdraws them by reference.
	///
	/// Returns the `dave_mls_commit_welcome (28)` payload when there is
	/// something to commit — the commit, followed by the welcome when the
	/// commit adds members who need one. With nothing left pending, the pending
	/// commit is dropped and nothing is sent.
	pub fn process_proposals(
		&mut self,
		append: bool,
		payload: &[u8],
	) -> Result<Option<Vec<u8>>, SessionError> {
		let group = self.group.as_mut().ok_or(SessionError::NotEstablished)?;

		// The proposals arrive wrapped in one variable-length vector.
		let proposals: Vec<u8> = decode_untrusted::<VLBytes>(payload)?.into();
		let mut adds_members = false;
		let mut remaining: &[u8] = &proposals;

		if append {
			while !remaining.is_empty() {
				let (message, leftover) = MlsMessageIn::tls_deserialize_bytes(remaining)
					.map_err(|error| SessionError::Decode(error.to_string()))?;
				remaining = leftover;

				let protocol_message = message
					.try_into_protocol_message()
					.map_err(|error| SessionError::Mls(format!("{error:?}")))?;
				let processed = group
					.process_message(&self.provider, protocol_message)
					.map_err(|error| SessionError::Mls(format!("{error:?}")))?;

				match processed.into_content() {
					ProcessedMessageContent::ProposalMessage(proposal) => {
						if matches!(proposal.proposal(), Proposal::Add(_)) {
							adds_members = true;
						}
						group
							.store_pending_proposal(self.provider.storage(), *proposal)
							.map_err(|error| SessionError::Mls(format!("{error:?}")))?;
					}
					_ => return Err(SessionError::Mls("expected a proposal".to_owned())),
				}
			}
		} else {
			while !remaining.is_empty() {
				let (reference, leftover) = ProposalRef::tls_deserialize_bytes(remaining)
					.map_err(|error| SessionError::Decode(error.to_string()))?;
				remaining = leftover;
				group
					.remove_pending_proposal(self.provider.storage(), &reference)
					.map_err(|error| SessionError::Mls(format!("{error:?}")))?;
			}
		}

		// Nothing pending means the revocation emptied the set: undo any commit
		// staged for proposals that no longer exist.
		if group.pending_proposals().next().is_none() {
			group
				.clear_pending_commit(self.provider.storage())
				.map_err(|error| SessionError::Mls(format!("{error:?}")))?;
			return Ok(None);
		}

		// A commit left over from an earlier round would be committing to a
		// stale proposal set.
		if group.pending_commit().is_some() {
			group
				.clear_pending_commit(self.provider.storage())
				.map_err(|error| SessionError::Mls(format!("{error:?}")))?;
		}

		let (commit, welcome, _group_info) = group
			.commit_to_pending_proposals(&self.provider, &self.signer)
			.map_err(|error| SessionError::Mls(format!("{error:?}")))?;

		// The commit is not applied here. It comes back as `op29`, and merging
		// it there is what moves the epoch — for us and everyone else at once.
		self.status = Status::AwaitingResponse;

		let mut out = commit
			.tls_serialize_detached()
			.map_err(|error| SessionError::Decode(error.to_string()))?;

		if adds_members {
			let Some(message) = welcome else {
				return Err(SessionError::Mls(
					"commit adds members but produced no welcome".to_owned(),
				));
			};
			let MlsMessageBodyOut::Welcome(welcome) = message.body() else {
				return Err(SessionError::Mls("expected a welcome".to_owned()));
			};
			out.extend_from_slice(
				&welcome
					.tls_serialize_detached()
					.map_err(|error| SessionError::Decode(error.to_string()))?,
			);
		}

		Ok(Some(out))
	}

	/// Handle `dave_mls_welcome (30)`: become a real member.
	pub fn process_welcome(&mut self, payload: &[u8]) -> Result<(), SessionError> {
		let expected = self.external_sender.clone().ok_or(SessionError::NoExternalSender)?;

		let welcome: Welcome = decode_untrusted(payload)?;
		let join_config = MlsGroupJoinConfig::builder()
			.use_ratchet_tree_extension(true)
			.wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
			.build();

		let staged = StagedWelcome::new_from_welcome(&self.provider, &join_config, welcome, None)
			.map_err(|error| SessionError::Mls(format!("{error:?}")))?;

		// The welcome must place us in a group that trusts the same external
		// sender the gateway announced. A different one would mean taking
		// proposals from somewhere else as if they were Discord's.
		// Exactly one, and it must be the one the gateway announced.
		match staged.group_context().extensions().external_senders() {
			Some(senders) if senders.len() == 1 && senders[0] == expected => {}
			_ => return Err(SessionError::UnexpectedExternalSender),
		}

		let group = staged
			.into_group(&self.provider)
			.map_err(|error| SessionError::Mls(format!("{error:?}")))?;
		self.group = Some(group);
		self.status = Status::Active;
		self.refresh_keys()
	}

	/// Handle `dave_mls_announce_commit_transition (29)`: move to a new epoch.
	pub fn process_commit(&mut self, payload: &[u8]) -> Result<(), SessionError> {
		// A commit is valid once a group exists — including the very first one,
		// which is our own commit coming back and is what makes us active.
		if matches!(self.status, Status::Uninitialised | Status::Pending) {
			return Err(SessionError::NotEstablished);
		}
		let group_id = self.group_id.clone();
		let group = self.group.as_mut().ok_or(SessionError::NotEstablished)?;

		let message: MlsMessageIn = decode_untrusted(payload)?;
		let protocol_message = message
			.try_into_protocol_message()
			.map_err(|error| SessionError::Mls(format!("{error:?}")))?;
		if protocol_message.group_id().as_slice() != group_id.as_slice() {
			return Err(SessionError::Mls("commit is for a different group".to_owned()));
		}

		match group.process_message(&self.provider, protocol_message) {
			Ok(processed) => match processed.into_content() {
				ProcessedMessageContent::StagedCommitMessage(staged) => group
					.merge_staged_commit(&self.provider, *staged)
					.map_err(|error| SessionError::Mls(format!("{error:?}")))?,
				_ => return Err(SessionError::Mls("expected a commit".to_owned())),
			},
			// Our own commit comes back to us; merging the pending one is the
			// same state change, reached the other way round.
			Err(ProcessMessageError::InvalidCommit(StageCommitError::OwnCommit)) => group
				.merge_pending_commit(&self.provider)
				.map_err(|error| SessionError::Mls(format!("{error:?}")))?,
			Err(error) => return Err(SessionError::Mls(format!("{error:?}"))),
		}

		self.status = Status::Active;
		self.refresh_keys()
	}

	/// Encrypt one Opus packet for sending. Only valid once active.
	pub fn encrypt_opus(&mut self, packet: &[u8], out: &mut Vec<u8>) -> Result<(), SessionError> {
		if self.status != Status::Active {
			return Err(SessionError::NotEstablished);
		}
		self.encryptor.encrypt_opus(packet, out)?;
		Ok(())
	}

	/// Everyone currently in the group, by user id.
	pub fn member_ids(&self) -> Vec<u64> {
		let Some(group) = &self.group else { return Vec::new() };
		group
			.members()
			.filter_map(|member| {
				<[u8; 8]>::try_from(member.credential.serialized_content())
					.ok()
					.map(u64::from_be_bytes)
			})
			.collect()
	}

	fn create_pending_group(&mut self) -> Result<(), SessionError> {
		let external_sender =
			self.external_sender.clone().ok_or(SessionError::NoExternalSender)?;

		let extensions = Extensions::single(Extension::ExternalSenders(vec![external_sender]));
		let config = MlsGroupCreateConfig::builder()
			.with_group_context_extensions(extensions)
			.map_err(|error| SessionError::Mls(format!("{error:?}")))?
			.ciphersuite(CIPHERSUITE)
			.capabilities(capabilities())
			.use_ratchet_tree_extension(true)
			.wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
			.build();

		let group = MlsGroup::new_with_group_id(
			&self.provider,
			&self.signer,
			&config,
			self.group_id.clone(),
			self.credential_with_key.clone(),
		)
		.map_err(|error| SessionError::Mls(format!("{error:?}")))?;

		self.group = Some(group);
		self.status = Status::Pending;
		Ok(())
	}

	/// Re-export our sender secret after any epoch change and hand it to the
	/// encryptor, which restarts its ratchet and nonce.
	fn refresh_keys(&mut self) -> Result<(), SessionError> {
		let group = self.group.as_ref().ok_or(SessionError::NotEstablished)?;
		let base_secret = group
			.export_secret(
				self.provider.crypto(),
				MEDIA_KEY_BASE_LABEL,
				// Little-endian here, big-endian in the credential. Not a typo.
				&self.user_id.to_le_bytes(),
				MEDIA_KEY_BASE_LEN,
			)
			.map_err(|error| SessionError::Mls(format!("{error:?}")))?;
		self.encryptor.set_base_secret(base_secret);
		Ok(())
	}
}

/// Decode a TLS-serialised value that arrived over the gateway.
///
/// `tls_codec` panics rather than erroring on some truncated inputs — a
/// half-written `ExternalSender` asserts inside its variable-length vector
/// reader. These payloads come off the network, so a panic there would take the
/// bot down on a malformed frame. Unwinding is caught and turned back into the
/// error the caller already handles. (This is why the release profile unwinds
/// rather than aborting.)
fn decode_untrusted<T: DeserializeBytes>(payload: &[u8]) -> Result<T, SessionError> {
	std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
		T::tls_deserialize_exact_bytes(payload)
	}))
	.map_err(|_| SessionError::Decode("malformed payload".to_owned()))?
	.map_err(|error| SessionError::Decode(error.to_string()))
}

/// What this client declares it can do. DAVE v1 pins all of it.
fn capabilities() -> Capabilities {
	Capabilities::builder()
		.versions(vec![ProtocolVersion::Mls10])
		.ciphersuites(vec![CIPHERSUITE])
		.extensions(vec![])
		.proposals(vec![])
		.credentials(vec![CredentialType::Basic])
		.build()
}

#[cfg(test)]
mod tests {
	use super::*;

	const USER: u64 = 956_459_806_691_065_856;
	const CHANNEL: u64 = 1_409_777_228_618_661_921;

	#[test]
	fn only_dave_v1_is_accepted() {
		assert!(Session::new(1, USER, CHANNEL).is_ok());
		assert!(matches!(Session::new(0, USER, CHANNEL), Err(SessionError::UnsupportedVersion(0))));
		assert!(matches!(Session::new(2, USER, CHANNEL), Err(SessionError::UnsupportedVersion(2))));
	}

	#[test]
	fn nothing_can_be_sent_before_the_group_exists() {
		let mut session = Session::new(1, USER, CHANNEL).unwrap();
		assert_eq!(session.status(), Status::Uninitialised);
		assert!(!session.is_ready());

		let mut out = Vec::new();
		assert!(matches!(
			session.encrypt_opus(&[0xfc; 8], &mut out),
			Err(SessionError::NotEstablished)
		));
		// And a commit before any group exists is not a state we can be pushed
		// into.
		assert!(matches!(session.process_commit(&[0u8; 4]), Err(SessionError::NotEstablished)));
	}

	#[test]
	fn key_packages_are_serialisable_and_never_reused() {
		let mut session = Session::new(1, USER, CHANNEL).unwrap();
		let first = session.key_package().expect("key package builds");
		let second = session.key_package().expect("key package builds");

		assert!(first.len() > 32, "a key package should not be this small");
		assert_ne!(first, second, "key packages must be single-use");
		// It has to survive a round trip through the same codec the gateway uses.
		assert!(KeyPackageIn::tls_deserialize_exact_bytes(&first).is_ok());
	}

	#[test]
	fn a_key_package_carries_our_identity_and_ciphersuite() {
		let mut session = Session::new(1, USER, CHANNEL).unwrap();
		let bytes = session.key_package().unwrap();
		let parsed = KeyPackageIn::tls_deserialize_exact_bytes(&bytes).unwrap();
		let validated = parsed
			.validate(session.provider.crypto(), ProtocolVersion::Mls10)
			.expect("key package validates");

		assert_eq!(validated.ciphersuite(), CIPHERSUITE);
		assert_eq!(
			validated.leaf_node().credential().serialized_content(),
			USER.to_be_bytes(),
			"credential identity must be the big-endian user id"
		);
	}

	#[test]
	fn garbage_from_the_gateway_is_rejected_not_trusted() {
		let mut session = Session::new(1, USER, CHANNEL).unwrap();
		assert!(matches!(
			session.set_external_sender(b"not an external sender"),
			Err(SessionError::Decode(_))
		));
		// Still uninitialised: a bad payload must not half-open the session.
		assert_eq!(session.status(), Status::Uninitialised);
		assert!(matches!(session.process_welcome(&[1, 2, 3]), Err(SessionError::NoExternalSender)));
	}

	#[test]
	fn member_ids_are_empty_before_joining() {
		let session = Session::new(1, USER, CHANNEL).unwrap();
		assert!(session.member_ids().is_empty());
		assert_eq!(session.epoch(), None);
	}
}
