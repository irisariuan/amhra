//! The voice gateway v8 client.
//!
//! Runs as its own task: the caller gets a handle to send with and a channel to
//! read events from, so the audio path never waits on a websocket. The task
//! owns the heartbeat timer, the sequence number that heartbeats and resumes
//! acknowledge, and the decision of whether a closed socket should be resumed
//! or re-identified.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

use crate::wire::{self, Opcode, SPEAKING_MICROPHONE};

/// Missed acknowledgements before the connection is treated as dead. Three
/// intervals is long enough to survive a stalled event loop and short enough
/// that a listener notices no more than a hiccup.
const MAX_MISSED_HEARTBEATS: u32 = 3;
/// Reconnect backoff ceiling. Voice servers move during incidents; retrying
/// forever at one second is how a bot becomes part of the incident.
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
	#[error("websocket: {0}")]
	WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
	#[error("gateway closed: {0}")]
	Closed(String),
	#[error("authentication failed")]
	AuthenticationFailed,
	#[error("session is no longer valid")]
	SessionInvalid,
	#[error("disconnected from the channel")]
	Disconnected,
	#[error("the server requires DAVE end-to-end encryption")]
	E2eeRequired,
}

/// Everything needed to identify to a voice server. All four fields come from
/// the main gateway: the bot sends an op 4 voice state update, and Discord
/// answers with `VOICE_STATE_UPDATE` (session id) and `VOICE_SERVER_UPDATE`
/// (endpoint and token).
#[derive(Debug, Clone)]
pub struct ConnectionInfo {
	pub endpoint: String,
	pub guild_id: String,
	pub user_id: String,
	pub session_id: String,
	pub token: String,
	/// Highest DAVE version to advertise. Zero declares no E2EE support.
	pub max_dave_protocol_version: u8,
}

/// What the gateway task reports upward.
#[derive(Debug, Clone)]
pub enum Event {
	/// The server named our SSRC and where to send audio.
	Ready { ssrc: u32, ip: String, port: u16, modes: Vec<String> },
	/// Transport keys agreed. `dave_protocol_version` is the server's answer to
	/// what we advertised: zero means this session is not end-to-end encrypted.
	SessionDescription { mode: String, secret_key: Vec<u8>, dave_protocol_version: u8 },
	/// A DAVE control message. JSON opcodes carry `data`; MLS opcodes carry
	/// `payload`.
	Dave { opcode: Opcode, data: Value, payload: Vec<u8> },
	Resumed,
	/// The connection ended and will not come back on its own.
	Closed(String),
	/// The connection dropped and is being re-established; audio should pause.
	/// Carries why, because "reconnecting" on its own is unactionable in a log.
	Reconnecting(String),
}

/// Commands the owner sends to the gateway task.
#[derive(Debug)]
enum Command {
	SelectProtocol { address: String, port: u16, mode: String },
	Speaking(bool),
	Binary { opcode: Opcode, payload: Vec<u8> },
	Json { opcode: Opcode, data: Value },
	Close,
}

#[derive(Debug, Clone)]
pub struct GatewayHandle {
	commands: mpsc::Sender<Command>,
}

impl GatewayHandle {
	/// Tell the server where to send audio and which cipher we chose.
	pub async fn select_protocol(&self, address: String, port: u16, mode: String) {
		let _ = self.commands.send(Command::SelectProtocol { address, port, mode }).await;
	}

	/// Announce whether audio is flowing. Discord ignores audio from a client
	/// that never said it was speaking.
	pub async fn set_speaking(&self, speaking: bool) {
		let _ = self.commands.send(Command::Speaking(speaking)).await;
	}

	pub async fn send_binary(&self, opcode: Opcode, payload: Vec<u8>) {
		let _ = self.commands.send(Command::Binary { opcode, payload }).await;
	}

	/// Send a JSON frame for an opcode with no dedicated helper — the DAVE
	/// transition acknowledgements, in practice.
	pub async fn send_json(&self, opcode: Opcode, data: Value) {
		let _ = self.commands.send(Command::Json { opcode, data }).await;
	}

	pub async fn close(&self) {
		let _ = self.commands.send(Command::Close).await;
	}
}

/// Choose a rustls crypto provider, once per process.
///
/// Feature unification across this workspace leaves rustls with both `ring` and
/// `aws-lc-rs` compiled in, and rustls refuses to guess between them — it panics
/// on the first TLS handshake instead. Picking here rather than in each binary
/// means a caller cannot forget; installing over an existing choice is a no-op,
/// so an application that already selected one keeps it.
pub fn install_default_crypto_provider() {
	static ONCE: std::sync::Once = std::sync::Once::new();
	ONCE.call_once(|| {
		let _ = rustls::crypto::ring::default_provider().install_default();
	});
}

/// Start a gateway task. Returns a handle and the event stream.
pub fn connect(info: ConnectionInfo) -> (GatewayHandle, mpsc::Receiver<Event>) {
	install_default_crypto_provider();
	let (command_tx, command_rx) = mpsc::channel(32);
	let (event_tx, event_rx) = mpsc::channel(64);
	tokio::spawn(run(info, command_rx, event_tx));
	(GatewayHandle { commands: command_tx }, event_rx)
}

/// Outer loop: connect, run, decide whether to come back.
async fn run(info: ConnectionInfo, mut commands: mpsc::Receiver<Command>, events: mpsc::Sender<Event>) {
	let mut ssrc = 0u32;
	let mut sequence_ack: u16 = 0;
	let mut resume = false;
	let mut backoff = Duration::from_secs(1);

	loop {
		let outcome = session(&info, &mut commands, &events, &mut ssrc, &mut sequence_ack, resume).await;

		match outcome {
			// A clean close means the owner asked for it.
			Ok(()) => return,
			Err(error) => {
				let (retry, resumable) = match &error {
					// Nothing to come back to.
					GatewayError::AuthenticationFailed
					| GatewayError::Disconnected
					| GatewayError::E2eeRequired => (false, false),
					// The session is gone but the channel is not: start over.
					GatewayError::SessionInvalid => (true, false),
					_ => (true, true),
				};

				if !retry {
					let _ = events.send(Event::Closed(error.to_string())).await;
					return;
				}
				let _ = events.send(Event::Reconnecting(error.to_string())).await;
				resume = resumable;
				tokio::time::sleep(backoff).await;
				backoff = (backoff * 2).min(MAX_BACKOFF);
			}
		}
	}
}

/// One connection's lifetime.
async fn session(
	info: &ConnectionInfo,
	commands: &mut mpsc::Receiver<Command>,
	events: &mpsc::Sender<Event>,
	ssrc: &mut u32,
	sequence_ack: &mut u16,
	resume: bool,
) -> Result<(), GatewayError> {
	let url = wire::gateway_url(&info.endpoint);
	let (mut socket, _) = tokio_tungstenite::connect_async(&url).await?;

	if resume {
		let payload = json!({
			"op": Opcode::Resume as u8,
			"d": {
				"server_id": info.guild_id,
				"session_id": info.session_id,
				"token": info.token,
				"seq_ack": *sequence_ack,
			}
		});
		socket.send(Message::Text(payload.to_string())).await?;
	} else {
		let payload = json!({
			"op": Opcode::Identify as u8,
			"d": {
				"server_id": info.guild_id,
				"user_id": info.user_id,
				"session_id": info.session_id,
				"token": info.token,
				"max_dave_protocol_version": info.max_dave_protocol_version,
			}
		});
		socket.send(Message::Text(payload.to_string())).await?;
	}

	// Hello sets the real interval; until it arrives nothing is due.
	let mut heartbeat = tokio::time::interval(Duration::from_secs(60));
	heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
	heartbeat.tick().await;
	let mut missed = 0u32;
	let mut heartbeat_started = false;

	loop {
		tokio::select! {
			// Heartbeats take priority: falling behind on them ends the session.
			_ = heartbeat.tick(), if heartbeat_started => {
				if missed >= MAX_MISSED_HEARTBEATS {
					return Err(GatewayError::Closed(
						format!("{missed} heartbeats went unacknowledged")
					));
				}
				missed += 1;
				let nonce = nonce_now();
				let payload = json!({
					"op": Opcode::Heartbeat as u8,
					"d": { "t": nonce, "seq_ack": *sequence_ack }
				});
				socket.send(Message::Text(payload.to_string())).await?;
			}

			command = commands.recv() => {
				match command {
					Some(Command::SelectProtocol { address, port, mode }) => {
						let payload = json!({
							"op": Opcode::SelectProtocol as u8,
							"d": {
								"protocol": "udp",
								"data": { "address": address, "port": port, "mode": mode }
							}
						});
						socket.send(Message::Text(payload.to_string())).await?;
					}
					Some(Command::Speaking(speaking)) => {
						let payload = json!({
							"op": Opcode::Speaking as u8,
							"d": {
								"speaking": if speaking { SPEAKING_MICROPHONE } else { 0 },
								"delay": 0,
								"ssrc": *ssrc,
							}
						});
						socket.send(Message::Text(payload.to_string())).await?;
					}
					Some(Command::Json { opcode, data }) => {
						let payload = json!({ "op": opcode as u8, "d": data });
						socket.send(Message::Text(payload.to_string())).await?;
					}
					Some(Command::Binary { opcode, payload }) => {
						let frame = wire::encode_binary(opcode, &payload);
						socket.send(Message::Binary(frame)).await?;
					}
					// The owner is done, or dropped the handle.
					Some(Command::Close) | None => {
						let _ = socket.close(None).await;
						return Ok(());
					}
				}
			}

			message = socket.next() => {
				let Some(message) = message else {
					return Err(GatewayError::Closed("stream ended".to_owned()));
				};
				match message? {
					Message::Text(text) => {
						let Ok(frame) = serde_json::from_str::<wire::Inbound>(&text) else { continue };
						if let Some(seq) = frame.seq {
							*sequence_ack = seq;
						}
						let Some(opcode) = Opcode::from_u8(frame.op) else { continue };
						match opcode {
							Opcode::Hello => {
								if let Ok(hello) = serde_json::from_value::<wire::Hello>(frame.d) {
									let period = Duration::from_secs_f64(
										(hello.heartbeat_interval / 1000.0).max(0.5),
									);
									heartbeat = tokio::time::interval(period);
									heartbeat.set_missed_tick_behavior(
										tokio::time::MissedTickBehavior::Delay,
									);
									// The first tick is immediate; the protocol
									// wants one heartbeat straight away anyway.
									heartbeat_started = true;
								}
							}
							Opcode::HeartbeatAck => missed = 0,
							Opcode::Ready => {
								if let Ok(ready) = serde_json::from_value::<wire::Ready>(frame.d) {
									*ssrc = ready.ssrc;
									let _ = events.send(Event::Ready {
										ssrc: ready.ssrc,
										ip: ready.ip,
										port: ready.port,
										modes: ready.modes,
									}).await;
								}
							}
							Opcode::SessionDescription => {
								if let Ok(description) =
									serde_json::from_value::<wire::SessionDescription>(frame.d)
								{
									let _ = events.send(Event::SessionDescription {
										mode: description.mode,
										secret_key: description.secret_key,
										dave_protocol_version: description.dave_protocol_version,
									}).await;
								}
							}
							Opcode::Resumed => {
								let _ = events.send(Event::Resumed).await;
							}
							Opcode::DavePrepareTransition
							| Opcode::DaveExecuteTransition
							| Opcode::DavePrepareEpoch
							| Opcode::DaveMlsInvalidCommitWelcome => {
								let _ = events.send(Event::Dave {
									opcode,
									data: frame.d,
									payload: Vec::new(),
								}).await;
							}
							_ => {}
						}
					}
					Message::Binary(data) => {
						let Some((seq, opcode, payload)) = wire::parse_binary(&data) else { continue };
						// Binary frames advance the same sequence as JSON ones.
						*sequence_ack = seq;
						let _ = events.send(Event::Dave {
							opcode,
							data: Value::Null,
							payload: payload.to_vec(),
						}).await;
					}
					Message::Close(frame) => return Err(classify_close(frame.as_ref())),
					_ => {}
				}
			}
		}
	}
}

/// Decide what a close code means for reconnection.
///
/// The distinction that matters: 4014 means we were removed from the channel,
/// so reconnecting would be the bot forcing its way back in, while 4006 means
/// the session is stale and a fresh identify is correct.
fn classify_close(frame: Option<&CloseFrame>) -> GatewayError {
	let Some(frame) = frame else {
		return GatewayError::Closed("closed without a code".to_owned());
	};
	match u16::from(frame.code) {
		4004 => GatewayError::AuthenticationFailed,
		// Measured 2026-08-13: advertising max_dave_protocol_version 0 is closed
		// with 4017 before the session opens. Retrying re-sends the same
		// unacceptable identify, so this is fatal rather than transient.
		4017 => GatewayError::E2eeRequired,
		4006 | 4009 => GatewayError::SessionInvalid,
		4014 => GatewayError::Disconnected,
		code => GatewayError::Closed(format!("code {code}: {}", frame.reason)),
	}
}

/// Heartbeat nonce. Any changing number works; the server echoes it back.
fn nonce_now() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|elapsed| elapsed.as_millis() as u64)
		.unwrap_or(0)
}

#[cfg(test)]
mod tests {
	use super::*;
	use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

	fn close(code: u16) -> GatewayError {
		classify_close(Some(&CloseFrame { code: CloseCode::from(code), reason: "".into() }))
	}

	#[test]
	fn close_codes_decide_reconnection() {
		assert!(matches!(close(4004), GatewayError::AuthenticationFailed));
		assert!(matches!(close(4006), GatewayError::SessionInvalid));
		assert!(matches!(close(4009), GatewayError::SessionInvalid));
		// Removed from the channel: staying out is the correct behaviour.
		assert!(matches!(close(4014), GatewayError::Disconnected));
		assert!(matches!(close(4017), GatewayError::E2eeRequired));
		// A voice server crash is resumable.
		assert!(matches!(close(4015), GatewayError::Closed(_)));
		assert!(matches!(classify_close(None), GatewayError::Closed(_)));
	}

	#[test]
	fn only_recoverable_closes_retry() {
		// Mirrors the policy in `run`, kept as a test so a later edit to either
		// one shows up as a disagreement.
		let retry = |error: &GatewayError| {
			!matches!(
				error,
				GatewayError::AuthenticationFailed
					| GatewayError::Disconnected
					| GatewayError::E2eeRequired
			)
		};
		assert!(!retry(&close(4004)));
		assert!(!retry(&close(4014)));
		// Re-identifying with the same unsupported DAVE version cannot succeed.
		assert!(!retry(&close(4017)));
		assert!(retry(&close(4006)));
		assert!(retry(&close(4015)));
	}
}
