//! The wire between the TypeScript bot and this process.
//!
//! Defined once, here, and exported to TypeScript as declarations so the two
//! sides cannot drift. JSON rather than a packed format: the traffic is user
//! actions plus a position tick per second, so legibility is worth more than
//! bytes — this pipe can be read with `cat` when something is wrong.
//!
//! Frames are length-prefixed (`u32` big-endian, then that many bytes of JSON)
//! because a pipe is a byte stream with no message boundaries of its own, and
//! newline framing would break the moment a title contained one.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Length prefix width. A control frame is never near this large; the cap
/// exists so a desynchronised stream fails instead of allocating wildly.
pub const MAX_FRAME_LEN: u32 = 1 << 20;

/// What the bot asks this process to do.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "protocol.d.ts")]
pub enum Command {
	/// Join a voice channel. The four connection fields come from the main
	/// gateway, which stays on the TypeScript side.
	#[serde(rename_all = "camelCase")]
	Connect {
		guild_id: String,
		channel_id: String,
		user_id: String,
		session_id: String,
		endpoint: String,
		token: String,
		/// Whether this guild has voice commands on. Only a sidecar started
		/// with `--listen` or `--voice-commands` can hear anything at all; this
		/// says whether it may in this guild. Absent means no.
		#[serde(default)]
		listen: bool,
	},
	/// Turn hearing this guild on or off without reconnecting. Off, packets
	/// from other members are dropped before they are decrypted.
	#[serde(rename_all = "camelCase")]
	SetListen { guild_id: String, listen: bool },
	/// Leave, releasing the guild's thread and sockets.
	#[serde(rename_all = "camelCase")]
	Disconnect { guild_id: String },
	/// Play a cached track now, from `start_ms`.
	#[serde(rename_all = "camelCase")]
	Play {
		guild_id: String,
		/// The cache id, not a path: the sidecar owns the cache layout.
		track_id: String,
		#[serde(default)]
		start_ms: u32,
		/// Fetch the track straight into playback rather than read it from
		/// the cache, unless the cache already holds all of it.
		#[serde(default)]
		stream: bool,
	},
	/// Queue what follows, so the seam can be prepared before it is needed.
	/// Sending it again replaces the previous choice.
	#[serde(rename_all = "camelCase")]
	SetNext {
		guild_id: String,
		track_id: String,
		#[serde(default)]
		stream: bool,
	},
	#[serde(rename_all = "camelCase")]
	ClearNext { guild_id: String },
	#[serde(rename_all = "camelCase")]
	Skip { guild_id: String },
	#[serde(rename_all = "camelCase")]
	Stop { guild_id: String },
	#[serde(rename_all = "camelCase")]
	Pause { guild_id: String },
	#[serde(rename_all = "camelCase")]
	Resume { guild_id: String },
	#[serde(rename_all = "camelCase")]
	Seek { guild_id: String, position_ms: u32 },
	/// The overall linear gain, applied on top of every track's own. 1.0 with
	/// nothing layered keeps the passthrough path, where no codec runs.
	#[serde(rename_all = "camelCase")]
	SetVolume { guild_id: String, gain: f32 },
	/// The queue track's own linear gain, under the overall one.
	#[serde(rename_all = "camelCase")]
	SetMainVolume { guild_id: String, gain: f32 },
	/// Play a cached track alongside the queue, mixed in at its own gain.
	/// Reusing a `layer_id` replaces that layer's track.
	#[serde(rename_all = "camelCase")]
	AddLayer {
		guild_id: String,
		/// Chosen by the bot, and how every later layer command and event
		/// names this one.
		layer_id: String,
		track_id: String,
		gain: f32,
		#[serde(default)]
		start_ms: u32,
		#[serde(default)]
		stream: bool,
	},
	/// Fade a layer out and drop it.
	#[serde(rename_all = "camelCase")]
	RemoveLayer { guild_id: String, layer_id: String },
	#[serde(rename_all = "camelCase")]
	SetLayerVolume { guild_id: String, layer_id: String, gain: f32 },
	/// Exchange a layer with the queue's track, on one tick and inaudibly:
	/// each keeps its place and its own gain. The layer keeps its id, now
	/// naming what was the queue's track. Answered by `LayerSwapped`, or an
	/// `Error` when the queue has nothing playing or is mid-fade.
	#[serde(rename_all = "camelCase")]
	SwapLayer { guild_id: String, layer_id: String },
	#[serde(rename_all = "camelCase")]
	SetFades { guild_id: String, crossfade_ms: u16, skip_fade_ms: u16 },
	/// Say `text` in the call, over the music, lowered meanwhile. Only a
	/// sidecar started with `--speech` speaks; others ignore it.
	#[serde(rename_all = "camelCase")]
	Speak {
		guild_id: String,
		text: String,
		/// `en`, `ja`, `ko`, `zh` (Mandarin) or `yue` (Cantonese); anything
		/// else, or nothing, is English.
		#[serde(default)]
		language: Option<String>,
		/// The member this answers. Their command stops being waited on (the
		/// waiting sound stops) once it starts, or at once if it cannot be said.
		#[serde(default)]
		user_id: Option<String>,
		/// Listen to that member again once it has been said, without waiting
		/// for the name: the start chime, then whatever they say back is an
		/// `Utterance` like any other. Only with `user_id`.
		#[serde(default)]
		listen: bool,
	},
	/// The bot is done with what a member said, and has nothing to say about
	/// it: stop the waiting sound for them. Harmless if it already stopped.
	#[serde(rename_all = "camelCase")]
	Settle { guild_id: String, user_id: String },
	/// Have these phrases ready, so saying them never waits on the model:
	/// what is not yet saved is synthesised in the background, once.
	#[serde(rename_all = "camelCase")]
	PrepareSpeech { phrases: Vec<Phrase> },
	/// Ask for one `Sessions` event. Used after the bot restarts, to find out
	/// what this process is still doing.
	ListSessions,
	/// Shut down cleanly.
	Shutdown,
}

/// Something the bot may say, for `PrepareSpeech`.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "protocol.d.ts")]
pub struct Phrase {
	pub text: String,
	#[serde(default)]
	pub language: Option<String>,
}

/// What this process reports back.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "protocol.d.ts")]
pub enum Event {
	/// The process is up and speaking this protocol version.
	#[serde(rename_all = "camelCase")]
	Hello { version: u32, pid: u32 },
	/// The voice connection is live and audio can flow.
	#[serde(rename_all = "camelCase")]
	Ready { guild_id: String, dave_version: u8 },
	#[serde(rename_all = "camelCase")]
	Started { guild_id: String, track_id: String },
	#[serde(rename_all = "camelCase")]
	Finished { guild_id: String, track_id: String },
	/// Playback stalled because the download has not kept up. Not an ending:
	/// the track resumes when bytes arrive.
	#[serde(rename_all = "camelCase")]
	Starved { guild_id: String, track_id: String },
	/// A layer's audio has begun.
	#[serde(rename_all = "camelCase")]
	LayerStarted { guild_id: String, layer_id: String },
	/// A layer ended, was removed, or failed. Its id is free again.
	#[serde(rename_all = "camelCase")]
	LayerFinished { guild_id: String, layer_id: String },
	/// A layer stalled waiting for its download. The rest of the mix plays on.
	#[serde(rename_all = "camelCase")]
	LayerStarved { guild_id: String, layer_id: String },
	/// A layer and the queue's track traded places.
	#[serde(rename_all = "camelCase")]
	LayerSwapped {
		guild_id: String,
		layer_id: String,
		/// What the queue is playing now: the layer's former track.
		track_id: String,
		position_ms: u32,
		/// What the layer is playing now: the queue's former track.
		layer_track_id: String,
		layer_position_ms: u32,
	},
	/// Where playback is, emitted about once a second.
	#[serde(rename_all = "camelCase")]
	Position { guild_id: String, track_id: String, position_ms: u32 },
	/// The guild has nothing left to play.
	#[serde(rename_all = "camelCase")]
	Idle { guild_id: String },
	/// The voice connection dropped and is being re-established.
	#[serde(rename_all = "camelCase")]
	Reconnecting { guild_id: String, reason: String },
	/// The voice connection ended and will not return on its own.
	#[serde(rename_all = "camelCase")]
	Disconnected { guild_id: String, reason: String },
	#[serde(rename_all = "camelCase")]
	Error { guild_id: Option<String>, message: String },
	/// Answer to `ListSessions`.
	#[serde(rename_all = "camelCase")]
	Sessions { guilds: Vec<SessionState> },
	/// Someone said the wake word. Only sent by a sidecar started with
	/// `--voice-commands`; an `Utterance` or a `NothingHeard` from the same
	/// person follows.
	#[serde(rename_all = "camelCase")]
	Woke { guild_id: String, user_id: String },
	/// The wake came to nothing: no speech followed it, or none that could be
	/// made out. Also sent for a `Speak` that was to listen to its member
	/// again and could not be said: nothing will be listened for.
	#[serde(rename_all = "camelCase")]
	NothingHeard { guild_id: String, user_id: String },
	/// Someone said the wake word and then something, transcribed. Only sent
	/// by a sidecar started with `--voice-commands`, and only for speech that
	/// followed the wake word: nothing else anyone says is transcribed.
	///
	/// The text is what was heard, not an instruction — it often still starts
	/// with the tail of the name, and deciding what it asks for is the bot's
	/// job.
	#[serde(rename_all = "camelCase")]
	Utterance {
		guild_id: String,
		user_id: String,
		text: String,
		/// The language the recogniser detected: `en`, `ja`, `ko`, `zh` or
		/// `yue`, or null when it could not tell.
		lang: Option<String>,
		/// Which phrase from the keywords file woke it, e.g. `M HARA`.
		wake_keyword: String,
		/// From the end of their speech to the text being ready, including the
		/// half second of silence that marks a command as finished.
		latency_ms: u32,
	},
}

/// One guild's state, for a bot that has just restarted and lost its own.
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "protocol.d.ts")]
pub struct SessionState {
	pub guild_id: String,
	pub channel_id: String,
	pub track_id: Option<String>,
	pub position_ms: u32,
	pub paused: bool,
	/// The overall gain.
	pub gain: f32,
	/// The queue track's own gain.
	pub main_gain: f32,
}

/// Bumped when a change would break an older bot talking to a newer sidecar.
pub const PROTOCOL_VERSION: u32 = 1;

impl Command {
	/// The guild a command applies to, when it applies to one.
	pub fn guild_id(&self) -> Option<&str> {
		match self {
			Self::Connect { guild_id, .. }
			| Self::Disconnect { guild_id }
			| Self::Play { guild_id, .. }
			| Self::SetNext { guild_id, .. }
			| Self::ClearNext { guild_id }
			| Self::Skip { guild_id }
			| Self::Stop { guild_id }
			| Self::Pause { guild_id }
			| Self::Resume { guild_id }
			| Self::Seek { guild_id, .. }
			| Self::SetVolume { guild_id, .. }
			| Self::SetMainVolume { guild_id, .. }
			| Self::AddLayer { guild_id, .. }
			| Self::RemoveLayer { guild_id, .. }
			| Self::SetLayerVolume { guild_id, .. }
			| Self::SwapLayer { guild_id, .. }
			| Self::SetFades { guild_id, .. }
			| Self::SetListen { guild_id, .. }
			| Self::Speak { guild_id, .. }
			| Self::Settle { guild_id, .. } => Some(guild_id),
			Self::PrepareSpeech { .. } | Self::ListSessions | Self::Shutdown => None,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn commands_round_trip_as_tagged_json() {
		let json = r#"{"type":"play","guildId":"1","trackId":"dQw4w9WgXcQ","startMs":5000}"#;
		let command: Command = serde_json::from_str(json).unwrap();
		let Command::Play { guild_id, track_id, start_ms, .. } = &command else {
			panic!("wrong variant: {command:?}");
		};
		assert_eq!(guild_id, "1");
		assert_eq!(track_id, "dQw4w9WgXcQ");
		assert_eq!(*start_ms, 5000);

		// And back out in the shape TypeScript expects.
		let encoded = serde_json::to_string(&command).unwrap();
		assert!(encoded.contains("\"type\":\"play\""));
		assert!(encoded.contains("\"guildId\""), "fields must be camelCase: {encoded}");
	}

	#[test]
	fn optional_fields_may_be_omitted() {
		// A play without a start position is the common case and must not
		// require the caller to send a zero.
		let command: Command =
			serde_json::from_str(r#"{"type":"play","guildId":"1","trackId":"x"}"#).unwrap();
		assert!(matches!(command, Command::Play { start_ms: 0, stream: false, .. }));
	}

	#[test]
	fn streaming_is_asked_for_per_track() {
		let command: Command = serde_json::from_str(
			r#"{"type":"setNext","guildId":"1","trackId":"x","stream":true}"#,
		)
		.unwrap();
		assert!(matches!(command, Command::SetNext { stream: true, .. }));
	}

	#[test]
	fn a_connect_without_listen_does_not_listen() {
		// An older bot never sends the field, and must not have its guilds
		// heard because a newer sidecar was started with voice commands.
		let command: Command = serde_json::from_str(
			r#"{"type":"connect","guildId":"1","channelId":"2","userId":"3","sessionId":"s","endpoint":"e","token":"t"}"#,
		)
		.unwrap();
		assert!(matches!(command, Command::Connect { listen: false, .. }));
	}

	#[test]
	fn events_serialise_with_their_tag() {
		let event = Event::Started {
			guild_id: "1".to_owned(),
			track_id: "dQw4w9WgXcQ".to_owned(),
		};
		let encoded = serde_json::to_string(&event).unwrap();
		assert!(encoded.contains("\"type\":\"started\""));
		assert!(encoded.contains("\"trackId\":\"dQw4w9WgXcQ\""));
	}

	#[test]
	fn a_layer_may_omit_its_start() {
		let command: Command = serde_json::from_str(
			r#"{"type":"addLayer","guildId":"1","layerId":"rain","trackId":"x","gain":0.4}"#,
		)
		.unwrap();
		let Command::AddLayer { layer_id, gain, start_ms, .. } = command else {
			panic!("wrong variant: {command:?}");
		};
		assert_eq!(layer_id, "rain");
		assert_eq!(gain, 0.4);
		assert_eq!(start_ms, 0);
	}

	#[test]
	fn an_utterance_carries_its_language_or_null() {
		let event = Event::Utterance {
			guild_id: "1".to_owned(),
			user_id: "2".to_owned(),
			text: "skip this song.".to_owned(),
			lang: None,
			wake_keyword: "AMHRA".to_owned(),
			latency_ms: 640,
		};
		let encoded = serde_json::to_string(&event).unwrap();
		assert!(encoded.contains("\"type\":\"utterance\""));
		assert!(encoded.contains("\"wakeKeyword\":\"AMHRA\""));
		assert!(encoded.contains("\"lang\":null"), "{encoded}");
	}

	#[test]
	fn a_speak_answers_nobody_and_listens_for_nothing_unless_told() {
		let command: Command = serde_json::from_str(r#"{"type":"speak","guildId":"g","text":"Skipping."}"#).unwrap();
		assert!(matches!(command, Command::Speak { user_id: None, listen: false, .. }));
		let command: Command = serde_json::from_str(
			r#"{"type":"speak","guildId":"g","text":"Two songs.","userId":"5","listen":true}"#,
		)
		.unwrap();
		let Command::Speak { user_id, listen, .. } = command else { panic!("wrong variant") };
		assert_eq!((user_id.as_deref(), listen), (Some("5"), true));
	}

	#[test]
	fn unknown_commands_are_rejected_rather_than_guessed() {
		assert!(serde_json::from_str::<Command>(r#"{"type":"explode","guildId":"1"}"#).is_err());
		assert!(serde_json::from_str::<Command>(r#"{"guildId":"1"}"#).is_err());
	}

	#[test]
	fn every_guild_command_reports_its_guild() {
		let commands = [
			r#"{"type":"disconnect","guildId":"g"}"#,
			r#"{"type":"skip","guildId":"g"}"#,
			r#"{"type":"pause","guildId":"g"}"#,
			r#"{"type":"seek","guildId":"g","positionMs":1}"#,
			r#"{"type":"setVolume","guildId":"g","gain":0.5}"#,
			r#"{"type":"setFades","guildId":"g","crossfadeMs":0,"skipFadeMs":40}"#,
			r#"{"type":"setMainVolume","guildId":"g","gain":0.5}"#,
			r#"{"type":"addLayer","guildId":"g","layerId":"l","trackId":"t","gain":1}"#,
			r#"{"type":"removeLayer","guildId":"g","layerId":"l"}"#,
			r#"{"type":"setLayerVolume","guildId":"g","layerId":"l","gain":0.2}"#,
			r#"{"type":"swapLayer","guildId":"g","layerId":"l"}"#,
			r#"{"type":"setListen","guildId":"g","listen":true}"#,
			r#"{"type":"speak","guildId":"g","text":"Skipping."}"#,
			r#"{"type":"settle","guildId":"g","userId":"2"}"#,
		];
		for json in commands {
			let command: Command = serde_json::from_str(json).unwrap();
			assert_eq!(command.guild_id(), Some("g"), "{json}");
		}
		let global: Command = serde_json::from_str(r#"{"type":"listSessions"}"#).unwrap();
		assert_eq!(global.guild_id(), None);
	}
}
