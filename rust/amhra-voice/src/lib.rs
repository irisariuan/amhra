//! Discord voice: gateway v8, UDP transport, RTP framing, transport
//! encryption, and (next) DAVE end-to-end encryption.

pub mod crypto;
pub mod dave;
pub mod dsp;
pub mod gateway;
pub mod player;
pub mod udp;
pub mod wire;

pub use gateway::{ConnectionInfo, Event, GatewayError, GatewayHandle};
pub use player::{Player, Tick};
pub use crypto::{CryptoError, SILENCE_FRAME, Session};
pub use udp::{Discovered, UdpError, VoiceUdp};
pub use wire::{EncryptionMode, Opcode};
