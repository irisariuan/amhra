//! The voice UDP socket: IP discovery, sending, keepalive.
//!
//! Discovery exists because the bot cannot know how its own NAT will rewrite
//! the packet. It sends a 74-byte request from the socket it intends to use and
//! the server replies with the address and port it actually saw, which is what
//! `SelectProtocol` has to advertise.

use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::UdpSocket;

/// Both the request and the response are this long.
const DISCOVERY_LEN: usize = 74;
const DISCOVERY_REQUEST: u16 = 0x1;
const DISCOVERY_RESPONSE: u16 = 0x2;

/// Discovery is answered in one round trip; anything slower is a dead endpoint.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const DISCOVERY_ATTEMPTS: u32 = 3;

#[derive(Debug, thiserror::Error)]
pub enum UdpError {
	#[error("udp i/o: {0}")]
	Io(#[from] std::io::Error),
	#[error("ip discovery got no reply after {0} attempts")]
	DiscoveryTimeout(u32),
	#[error("ip discovery reply was malformed")]
	BadDiscoveryReply,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovered {
	pub address: String,
	pub port: u16,
}

#[derive(Debug)]
pub struct VoiceUdp {
	socket: UdpSocket,
	remote: SocketAddr,
}

impl VoiceUdp {
	/// Bind a local socket and connect it to the voice server.
	///
	/// Connecting rather than sending to an address each time both filters out
	/// packets from anywhere else and lets the kernel skip the route lookup on
	/// every send — which happens fifty times a second per guild.
	pub async fn connect(remote: SocketAddr) -> Result<Self, UdpError> {
		let bind: SocketAddr = if remote.is_ipv4() {
			"0.0.0.0:0".parse().expect("valid bind address")
		} else {
			"[::]:0".parse().expect("valid bind address")
		};
		let socket = UdpSocket::bind(bind).await?;
		socket.connect(remote).await?;
		Ok(Self { socket, remote })
	}

	pub fn remote(&self) -> SocketAddr {
		self.remote
	}

	/// Ask the server what address it sees us as.
	pub async fn discover(&self, ssrc: u32) -> Result<Discovered, UdpError> {
		let request = build_discovery_request(ssrc);
		let mut reply = [0u8; DISCOVERY_LEN];

		for _ in 0..DISCOVERY_ATTEMPTS {
			self.socket.send(&request).await?;
			match tokio::time::timeout(DISCOVERY_TIMEOUT, self.socket.recv(&mut reply)).await {
				Ok(Ok(len)) => {
					// Anything that is not a discovery reply is either a stray
					// packet or an early RTCP frame; keep waiting rather than
					// failing the connection over it.
					if let Some(found) = parse_discovery_reply(&reply[..len]) {
						return Ok(found);
					}
				}
				Ok(Err(error)) => return Err(error.into()),
				Err(_) => continue,
			}
		}
		Err(UdpError::DiscoveryTimeout(DISCOVERY_ATTEMPTS))
	}

	pub async fn send(&self, packet: &[u8]) -> Result<(), UdpError> {
		self.socket.send(packet).await?;
		Ok(())
	}

	/// Non-blocking send for the audio thread, which must never await.
	///
	/// A full socket buffer drops the frame rather than delaying every later
	/// one: 20ms of audio is worth less than the pacing of everything behind it.
	pub fn try_send(&self, packet: &[u8]) -> Result<bool, UdpError> {
		match self.socket.try_send(packet) {
			Ok(_) => Ok(true),
			Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(false),
			Err(error) => Err(error.into()),
		}
	}
}

fn build_discovery_request(ssrc: u32) -> [u8; DISCOVERY_LEN] {
	let mut packet = [0u8; DISCOVERY_LEN];
	packet[0..2].copy_from_slice(&DISCOVERY_REQUEST.to_be_bytes());
	// Length counts everything after the type and length fields.
	packet[2..4].copy_from_slice(&(DISCOVERY_LEN as u16 - 4).to_be_bytes());
	packet[4..8].copy_from_slice(&ssrc.to_be_bytes());
	packet
}

/// Read the address and port out of a discovery reply.
///
/// The address is a null-padded ASCII string in a fixed 64-byte field; the port
/// is the last two bytes.
fn parse_discovery_reply(reply: &[u8]) -> Option<Discovered> {
	if reply.len() < DISCOVERY_LEN {
		return None;
	}
	if u16::from_be_bytes([reply[0], reply[1]]) != DISCOVERY_RESPONSE {
		return None;
	}
	let field = &reply[8..72];
	let end = field.iter().position(|byte| *byte == 0).unwrap_or(field.len());
	let address = std::str::from_utf8(&field[..end]).ok()?;
	if address.is_empty() {
		return None;
	}
	Some(Discovered {
		address: address.to_owned(),
		port: u16::from_be_bytes([reply[72], reply[73]]),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn discovery_request_has_the_documented_shape() {
		let packet = build_discovery_request(0x1234_5678);
		assert_eq!(packet.len(), 74);
		assert_eq!(u16::from_be_bytes([packet[0], packet[1]]), 1);
		assert_eq!(u16::from_be_bytes([packet[2], packet[3]]), 70);
		assert_eq!(u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]), 0x1234_5678);
		// The address and port fields are ours to leave empty.
		assert!(packet[8..].iter().all(|byte| *byte == 0));
	}

	fn reply_with(address: &str, port: u16) -> [u8; DISCOVERY_LEN] {
		let mut reply = [0u8; DISCOVERY_LEN];
		reply[0..2].copy_from_slice(&DISCOVERY_RESPONSE.to_be_bytes());
		reply[2..4].copy_from_slice(&70u16.to_be_bytes());
		reply[4..8].copy_from_slice(&1u32.to_be_bytes());
		reply[8..8 + address.len()].copy_from_slice(address.as_bytes());
		reply[72..74].copy_from_slice(&port.to_be_bytes());
		reply
	}

	#[test]
	fn reply_yields_address_and_port() {
		let found = parse_discovery_reply(&reply_with("203.0.113.42", 50123)).unwrap();
		assert_eq!(found.address, "203.0.113.42");
		assert_eq!(found.port, 50123);
	}

	#[test]
	fn ipv6_addresses_survive_the_fixed_field() {
		let found = parse_discovery_reply(&reply_with("2001:db8::1", 443)).unwrap();
		assert_eq!(found.address, "2001:db8::1");
	}

	#[test]
	fn foreign_packets_are_not_mistaken_for_replies() {
		// An RTP packet arriving before discovery completes.
		let mut rtp = [0u8; DISCOVERY_LEN];
		rtp[0] = 0x80;
		rtp[1] = 0x78;
		assert!(parse_discovery_reply(&rtp).is_none());

		// A truncated reply.
		assert!(parse_discovery_reply(&reply_with("1.2.3.4", 1)[..40]).is_none());

		// Our own request echoed back.
		assert!(parse_discovery_reply(&build_discovery_request(1)).is_none());
	}

	#[tokio::test]
	async fn discovery_round_trips_against_a_local_server() {
		// Stand in for the voice server: reply to the first discovery request.
		let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
		let server_addr = server.local_addr().unwrap();
		tokio::spawn(async move {
			let mut buffer = [0u8; 128];
			let (len, from) = server.recv_from(&mut buffer).await.unwrap();
			assert_eq!(len, DISCOVERY_LEN);
			let ssrc = u32::from_be_bytes(buffer[4..8].try_into().unwrap());
			assert_eq!(ssrc, 99);
			server.send_to(&reply_with("198.51.100.7", 40404), from).await.unwrap();
		});

		let udp = VoiceUdp::connect(server_addr).await.unwrap();
		let found = udp.discover(99).await.unwrap();
		assert_eq!(found, Discovered { address: "198.51.100.7".to_owned(), port: 40404 });
	}

	#[tokio::test]
	async fn discovery_gives_up_rather_than_hanging() {
		// A socket nobody is listening on: connect succeeds, replies never come.
		let dead = UdpSocket::bind("127.0.0.1:0").await.unwrap();
		let address = dead.local_addr().unwrap();
		drop(dead);

		let udp = VoiceUdp::connect(address).await.unwrap();
		let started = std::time::Instant::now();
		let error = udp.discover(1).await.unwrap_err();
		assert!(matches!(error, UdpError::DiscoveryTimeout(_) | UdpError::Io(_)));
		assert!(started.elapsed() < Duration::from_secs(20));
	}
}
