//! Picking an audio format out of `streamingData`.
//!
//! The player is fed Opus frames verbatim, so the only formats worth having are
//! WebM/Opus at 48kHz. An AAC track would have to be decoded and re-encoded on
//! every play — which is the cost this whole migration exists to delete — so it
//! is not selected even when it is the only thing on offer. A video with no
//! Opus is a job for the yt-dlp fallback, not for a silent quality downgrade.

use serde_json::Value;

/// Opus itags YouTube serves, ordered by the bitrate they usually carry.
/// The list is not consulted for ranking — `bitrate` is — but it keeps a
/// non-Opus format that happens to claim a WebM mime type from slipping in.
const OPUS_ITAGS: [u32; 4] = [251, 250, 249, 774];

#[derive(Debug, Clone)]
pub struct AudioFormat {
	pub itag: u32,
	pub url: String,
	pub mime_type: String,
	pub bitrate: u32,
	/// Total size in bytes, as declared by `contentLength`. Zero when the
	/// server did not say, in which case the downloader discovers it.
	pub content_length: u64,
	pub duration_ms: u32,
}

/// Best Opus format with a directly usable URL.
///
/// Formats carrying `signatureCipher` instead of `url` are skipped: those need
/// player-JS descrambling, which the primary path deliberately does not do.
pub fn best_opus(response: &Value) -> Option<AudioFormat> {
	let formats = response.pointer("/streamingData/adaptiveFormats")?.as_array()?;

	formats
		.iter()
		.filter_map(parse_format)
		.filter(|format| {
			format.mime_type.contains("opus") && OPUS_ITAGS.contains(&format.itag)
		})
		.max_by_key(|format| format.bitrate)
}

fn parse_format(raw: &Value) -> Option<AudioFormat> {
	// No `url` means the format is behind `signatureCipher`.
	let url = raw.get("url")?.as_str()?.to_owned();
	Some(AudioFormat {
		itag: raw.get("itag")?.as_u64()? as u32,
		url,
		mime_type: raw.get("mimeType").and_then(Value::as_str).unwrap_or_default().to_owned(),
		bitrate: raw.get("bitrate").and_then(Value::as_u64).unwrap_or(0) as u32,
		content_length: raw
			.get("contentLength")
			.and_then(Value::as_str)
			.and_then(|length| length.parse().ok())
			// Some clients return it as a number rather than a string.
			.or_else(|| raw.get("contentLength").and_then(Value::as_u64))
			.unwrap_or(0),
		duration_ms: raw
			.get("approxDurationMs")
			.and_then(Value::as_str)
			.and_then(|ms| ms.parse().ok())
			.unwrap_or(0),
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	fn response(formats: Value) -> Value {
		json!({ "streamingData": { "adaptiveFormats": formats } })
	}

	#[test]
	fn picks_the_highest_bitrate_opus() {
		let body = response(json!([
			{"itag": 249, "url": "u249", "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 49496, "contentLength": "100"},
			{"itag": 251, "url": "u251", "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 136544, "contentLength": "300"},
			{"itag": 250, "url": "u250", "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 65508, "contentLength": "200"},
		]));
		let picked = best_opus(&body).unwrap();
		assert_eq!(picked.itag, 251);
		assert_eq!(picked.content_length, 300);
	}

	#[test]
	fn aac_is_never_selected() {
		// itag 140 is the usual AAC track and often the only one present.
		let body = response(json!([
			{"itag": 140, "url": "u140", "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 130677},
		]));
		assert!(best_opus(&body).is_none());
	}

	#[test]
	fn scrambled_formats_are_skipped() {
		let body = response(json!([
			{"itag": 251, "signatureCipher": "s=abc&url=https://x", "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 136544},
			{"itag": 249, "url": "u249", "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 49496},
		]));
		// The 251 is better but unusable without descrambling.
		assert_eq!(best_opus(&body).unwrap().itag, 249);
	}

	#[test]
	fn missing_streaming_data_is_not_a_panic() {
		assert!(best_opus(&json!({})).is_none());
		assert!(best_opus(&json!({"streamingData": {}})).is_none());
		assert!(best_opus(&response(json!([]))).is_none());
	}

	#[test]
	fn numeric_content_length_is_accepted() {
		let body = response(json!([
			{"itag": 251, "url": "u", "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 1, "contentLength": 4242},
		]));
		assert_eq!(best_opus(&body).unwrap().content_length, 4242);
	}
}
