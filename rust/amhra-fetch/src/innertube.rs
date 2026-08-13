//! InnerTube player requests and the client-profile ladder.
//!
//! YouTube answers the same `/youtubei/v1/player` call differently depending on
//! which client the request claims to be, and which clients work changes every
//! few months. Rather than encode one client and rebuild when it dies, profiles
//! live in JSON and are tried in order until one returns a playable Opus
//! format. Adding a client is a config edit.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::format::{AudioFormat, best_opus};

const PLAYER_ENDPOINT: &str = "https://www.youtube.com/youtubei/v1/player";
const DEFAULT_PROFILES: &str = include_str!("profiles.json");

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
	#[error("http: {0}")]
	Http(#[from] reqwest::Error),
	#[error("profile file is not valid json: {0}")]
	BadProfiles(#[from] serde_json::Error),
	#[error("no client profile returned a playable Opus format (tried: {0})")]
	NoProfileWorked(String),
	#[error("video is unavailable: {0}")]
	Unplayable(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
	pub name: String,
	pub client_id: u16,
	pub user_agent: String,
	#[serde(default)]
	pub needs_player_js: bool,
	pub context: Value,
	#[serde(default)]
	pub headers: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct ProfileFile {
	profiles: Vec<Profile>,
}

/// Load the ladder, preferring an operator-supplied override.
pub fn load_profiles(override_path: Option<&Path>) -> Result<Vec<Profile>, ExtractError> {
	if let Some(path) = override_path
		&& let Ok(text) = std::fs::read_to_string(path)
	{
		return Ok(serde_json::from_str::<ProfileFile>(&text)?.profiles);
	}
	Ok(serde_json::from_str::<ProfileFile>(DEFAULT_PROFILES)?.profiles)
}

/// What a successful extraction yields.
#[derive(Debug, Clone)]
pub struct Extraction {
	pub video_id: String,
	pub title: Option<String>,
	pub duration_ms: u32,
	pub format: AudioFormat,
	/// Which profile answered, for logs and for pinning next time.
	pub profile: String,
	/// The media request has to look like it came from the same client that
	/// asked for the URL, or the CDN can refuse it.
	pub user_agent: String,
}

/// One walk of the ladder: what it found and where to resume.
#[derive(Debug, Clone)]
pub struct Attempt {
	pub extraction: Extraction,
	pub next: usize,
}

pub struct Extractor {
	client: reqwest::Client,
	profiles: Vec<Profile>,
}

impl Extractor {
	pub fn new(profiles: Vec<Profile>) -> Result<Self, ExtractError> {
		let client = reqwest::Client::builder()
			// The player call is small and latency-bound; the download that
			// follows reuses this pool, so keep connections warm.
			.pool_idle_timeout(Duration::from_secs(90))
			.connect_timeout(Duration::from_secs(10))
			.timeout(Duration::from_secs(30))
			.build()?;
		Ok(Self { client, profiles })
	}

	/// Walk the ladder from `start`, returning the first profile that yields a
	/// playable Opus format along with where to resume.
	///
	/// Resumability matters because a URL can be accepted by the player
	/// endpoint and then refused by the CDN — YouTube's bot checks live in both
	/// places. The caller retries from `next` rather than abandoning the native
	/// path on the first 403.
	///
	/// A profile answering `UNPLAYABLE` or `LOGIN_REQUIRED` is a profile
	/// problem, not a video problem, so the ladder keeps going. Only when every
	/// profile agrees does that become the reported error.
	///
	/// Every profile passed over appends its reason to `skipped`, on the error
	/// path as well as the success path — a walk that ends in `Unplayable`
	/// should still be able to say what the profiles before it complained
	/// about, or a stale ladder looks like a dead video in the logs.
	pub async fn extract_from(
		&self,
		video_id: &str,
		start: usize,
		skipped: &mut Vec<String>,
	) -> Result<Attempt, ExtractError> {
		let mut tried = Vec::new();
		let mut last_reason: Option<String> = None;

		for (index, profile) in self.profiles.iter().enumerate().skip(start) {
			tried.push(profile.name.as_str());
			let response = match self.player(profile, video_id).await {
				Ok(response) => response,
				Err(error) => {
					let reason = format!("{}: {error}", profile.name);
					skipped.push(reason.clone());
					last_reason = Some(reason);
					continue;
				}
			};

			let status = response
				.pointer("/playabilityStatus/status")
				.and_then(Value::as_str)
				.unwrap_or("UNKNOWN");
			if status != "OK" {
				let reason = response
					.pointer("/playabilityStatus/reason")
					.and_then(Value::as_str)
					.unwrap_or(status);
				let reason = format!("{}: {status} ({reason})", profile.name);
				skipped.push(reason.clone());
				last_reason = Some(reason);
				continue;
			}

			// A profile marked as needing player JS but handed back scrambled
			// URLs cannot be served yet: descrambling is fallback-only work.
			let Some(format) = best_opus(&response) else {
				let reason = format!("{}: no direct Opus format", profile.name);
				skipped.push(reason.clone());
				last_reason = Some(reason);
				continue;
			};

			let duration_ms = response
				.pointer("/videoDetails/lengthSeconds")
				.and_then(Value::as_str)
				.and_then(|seconds| seconds.parse::<u32>().ok())
				.map(|seconds| seconds * 1_000)
				.unwrap_or(format.duration_ms);

			return Ok(Attempt {
				extraction: Extraction {
					video_id: video_id.to_owned(),
					title: response
						.pointer("/videoDetails/title")
						.and_then(Value::as_str)
						.map(str::to_owned),
					duration_ms,
					format,
					profile: profile.name.clone(),
					user_agent: profile.user_agent.clone(),
				},
				next: index + 1,
			});
		}

		// Every profile agreeing on the same refusal means the video really is
		// gone, which is worth distinguishing from "our clients are all stale".
		match last_reason {
			Some(reason)
				if reason.contains("unavailable")
					|| reason.contains("private")
					|| reason.contains("LOGIN_REQUIRED") =>
			{
				Err(ExtractError::Unplayable(reason))
			}
			_ => Err(ExtractError::NoProfileWorked(tried.join(", "))),
		}
	}

	/// First profile that works, for callers with no interest in retrying.
	pub async fn extract(&self, video_id: &str) -> Result<Extraction, ExtractError> {
		let mut skipped = Vec::new();
		self.extract_from(video_id, 0, &mut skipped).await.map(|attempt| attempt.extraction)
	}

	pub fn profile_count(&self) -> usize {
		self.profiles.len()
	}

	async fn player(&self, profile: &Profile, video_id: &str) -> Result<Value, ExtractError> {
		let body = json!({
			"videoId": video_id,
			"context": profile.context,
			"contentCheckOk": true,
			"racyCheckOk": true,
		});

		let mut request = self
			.client
			.post(PLAYER_ENDPOINT)
			.header("Content-Type", "application/json")
			.header("User-Agent", &profile.user_agent)
			.header("X-Youtube-Client-Name", profile.client_id.to_string())
			.header(
				"X-Youtube-Client-Version",
				profile
					.context
					.pointer("/client/clientVersion")
					.and_then(Value::as_str)
					.unwrap_or_default(),
			);
		for (name, value) in &profile.headers {
			request = request.header(name.as_str(), value.as_str());
		}

		Ok(request.json(&body).send().await?.error_for_status()?.json::<Value>().await?)
	}

	pub fn client(&self) -> &reqwest::Client {
		&self.client
	}
}

/// Pull the eleven-character video id out of whatever the user pasted.
pub fn video_id(input: &str) -> Option<String> {
	fn valid(candidate: &str) -> bool {
		candidate.len() == 11
			&& candidate.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
	}

	let trimmed = input.trim();
	if valid(trimmed) {
		return Some(trimmed.to_owned());
	}

	// Cheap scan rather than a URL parser: every YouTube form puts the id
	// either after `v=` or as the last path segment.
	let without_query = trimmed.split(['?', '&', '#']).next().unwrap_or(trimmed);
	if let Some(index) = trimmed.find("v=") {
		let candidate: String =
			trimmed[index + 2..].chars().take_while(|c| *c != '&' && *c != '#').collect();
		if valid(&candidate) {
			return Some(candidate);
		}
	}
	let last = without_query.rsplit('/').find(|segment| !segment.is_empty())?;
	valid(last).then(|| last.to_owned())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn default_profiles_parse() {
		let profiles = load_profiles(None).unwrap();
		assert!(!profiles.is_empty());
		// The ladder is ordered: token-free clients must come first, or every
		// fetch pays a wasted round trip before it succeeds.
		assert_eq!(profiles[0].name, "android_vr");
		assert!(!profiles[0].needs_player_js);

		// Every token-free profile has to precede every descrambling one, or a
		// bot check on the first client costs a wasted player-JS round trip
		// before the cheap backups are even tried.
		let first_scrambled =
			profiles.iter().position(|profile| profile.needs_player_js).unwrap_or(profiles.len());
		assert!(profiles[first_scrambled..].iter().all(|profile| profile.needs_player_js));
		assert!(first_scrambled >= 4, "the ladder needs backups for when android_vr is gated");

		// The embedded TV client is refused outright without its embed url.
		let embedded = profiles.iter().find(|profile| profile.name == "tv_embedded").unwrap();
		assert!(embedded.context.pointer("/thirdParty/embedUrl").is_some());
	}

	#[test]
	fn ids_are_pulled_from_every_url_shape() {
		let expected = Some("dQw4w9WgXcQ".to_owned());
		assert_eq!(video_id("dQw4w9WgXcQ"), expected);
		assert_eq!(video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), expected);
		assert_eq!(video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RD"), expected);
		assert_eq!(video_id("https://youtu.be/dQw4w9WgXcQ"), expected);
		assert_eq!(video_id("https://youtu.be/dQw4w9WgXcQ?t=43"), expected);
		assert_eq!(video_id("https://www.youtube.com/shorts/dQw4w9WgXcQ"), expected);
		assert_eq!(video_id("  dQw4w9WgXcQ  "), expected);
	}

	#[test]
	fn non_ids_are_refused() {
		assert_eq!(video_id("https://example.com/"), None);
		assert_eq!(video_id("not an id"), None);
		assert_eq!(video_id("toolongtobeanid123"), None);
		assert_eq!(video_id(""), None);
	}
}
