//! Gemma 4 as the speech recogniser: a language model that takes audio.
//!
//! Unlike the sherpa-onnx recognisers, the model is not loaded here. Each
//! window goes, as a WAV file, to an OpenAI-compatible server that has it —
//! llama.cpp's `llama-server` with the model's audio projector, which the bot
//! starts — in a chat request, and the answer is the transcript. The same
//! server and model can read the command afterwards, so one model is held
//! where there were two.
//!
//! Gemma 4 takes audio in its E2B, E4B and 12B sizes, up to 30 seconds of it;
//! a command's window is at most eight.

use std::time::Duration;

use serde_json::{Value, json};

use super::sherpa::{LANGUAGES, language_name, script_language};
use super::{ModelError, Transcriber, Transcript, clips};

/// How long the server has to answer. A command is a few seconds of audio
/// and a line of text; past this the model is still loading, or stuck.
const ANSWER_WITHIN: Duration = Duration::from_secs(30);
/// The most a command comes to, in tokens, as for Qwen3-ASR.
const MAX_TOKENS: u32 = 96;

/// The formatting Gemma's model card asks for with a transcription.
const FORMAT: &str = "Follow these specific instructions for formatting the answer:\n\
	* Only output the transcription, with no newlines.\n\
	* When transcribing numbers, write the digits, i.e. write 1.7 and not one point seven, and write 3 instead of three.";

pub struct GemmaRecogniser {
	/// The server's `/v1`, without a trailing slash.
	url: String,
	model: String,
	/// The language every window is heard in, unless one comes with it.
	pinned: Option<&'static str>,
	/// Made on first use, on the recogniser's thread, which is where it is
	/// then waited on: that thread is not one of the sidecar's runtime's.
	client: Option<(tokio::runtime::Runtime, reqwest::Client)>,
}

impl GemmaRecogniser {
	/// Nothing is asked of the server yet: the bot starts it alongside the
	/// sidecar, and fetching the model the first time takes minutes.
	pub fn new(url: &str, model: &str, language: &str) -> Result<Self, ModelError> {
		let pinned = match language {
			"auto" => None,
			language => Some(*LANGUAGES.iter().find(|code| **code == language).ok_or_else(|| ModelError::Load {
				what: "Gemma 4",
				reason: format!("unknown language {language:?}; use auto, {}", LANGUAGES.join(", ")),
			})?),
		};
		if !url.starts_with("http://") && !url.starts_with("https://") {
			return Err(ModelError::Load { what: "Gemma 4", reason: format!("{url:?} is not a server's URL") });
		}
		Ok(Self { url: url.trim_end_matches('/').to_owned(), model: model.to_owned(), pinned, client: None })
	}

	fn recognise(
		&mut self,
		samples: &[f32],
		language: Option<&'static str>,
		hint: Option<&Transcript>,
	) -> Result<Transcript, ModelError> {
		let failed = |reason: String| ModelError::Recognition(reason);
		let mut wav = Vec::with_capacity(44 + samples.len() * 2);
		clips::write_wav(&mut wav, samples).map_err(|error| failed(error.to_string()))?;
		let body = request(&self.model, &base64(&wav), language, hint);
		let (runtime, client) = match &self.client {
			Some(client) => client,
			None => {
				let runtime = tokio::runtime::Builder::new_current_thread()
					.enable_all()
					.build()
					.map_err(|error| failed(error.to_string()))?;
				// reqwest is built here to take its TLS from whoever
				// installs it, and will not make a client before someone has.
				amhra_voice::gateway::install_default_crypto_provider();
				let client = reqwest::Client::builder()
					.timeout(ANSWER_WITHIN)
					.build()
					.map_err(|error| failed(error.to_string()))?;
				self.client.insert((runtime, client))
			}
		};
		let url = format!("{}/chat/completions", self.url);
		let answer: Value = runtime.block_on(async {
			let response = client
				.post(&url)
				.json(&body)
				.send()
				.await
				.map_err(|error| failed(format!("the model's server at {url} did not answer: {error}")))?;
			let status = response.status();
			if !status.is_success() {
				let said: String = response.text().await.unwrap_or_default().chars().take(200).collect();
				return Err(failed(format!("the model's server at {url} answered {status}: {said}")));
			}
			response.json().await.map_err(|error| failed(error.to_string()))
		})?;
		let text = transcript(&answer).ok_or_else(|| failed("no transcript in the server's answer".to_owned()))?;
		// Gemma does not say what language it heard: it is the one asked
		// for, or read off the writing.
		let lang = match language {
			Some(code) if !text.is_empty() => Some(code.to_owned()),
			Some(_) => None,
			None => script_language(&text).map(str::to_owned),
		};
		Ok(Transcript { text, lang })
	}
}

impl Transcriber for GemmaRecogniser {
	fn transcribe(&mut self, samples: &[f32]) -> Result<Transcript, ModelError> {
		self.recognise(samples, self.pinned, None)
	}

	fn transcribe_in(&mut self, samples: &[f32], language: Option<&str>) -> Result<Transcript, ModelError> {
		self.transcribe_hinted(samples, language, None)
	}

	fn transcribe_hinted(
		&mut self,
		samples: &[f32],
		language: Option<&str>,
		hint: Option<&Transcript>,
	) -> Result<Transcript, ModelError> {
		let code = language.and_then(|language| LANGUAGES.iter().find(|code| **code == language).copied());
		self.recognise(samples, code.or(self.pinned), hint)
	}
}

/// The chat request for one window: what to do, then the audio, which is the
/// order Gemma wants them in. With a `hint`, what another recogniser heard
/// is in the text too.
fn request(model: &str, wav: &str, language: Option<&str>, hint: Option<&Transcript>) -> Value {
	let mut task = match language.and_then(language_name) {
		Some(name) => format!("Transcribe the following speech segment in {name} into {name} text."),
		None => "Transcribe the following speech segment in its original language.".to_owned(),
	};
	if let Some(hint) = hint.filter(|hint| !hint.text.trim().is_empty()) {
		// Its language is only worth saying when Gemma was not told one.
		let heard_as = match hint.lang.as_deref().and_then(language_name).filter(|_| language.is_none()) {
			Some(name) => format!(" as {name}"),
			None => String::new(),
		};
		// As JSON, so that quotes in it stay inside the quotes.
		let text = Value::from(hint.text.trim()).to_string();
		task.push_str(&format!(
			"\n\nA smaller, less accurate speech recogniser heard it{heard_as}: {text}\n\
			 Use that only as a hint. Go by the audio: correct what it got wrong, and if the speech is in another language, write what you hear."
		));
	}
	json!({
		"model": model,
		"messages": [{
			"role": "user",
			"content": [
				{ "type": "text", "text": format!("{task}\n\n{FORMAT}") },
				{ "type": "input_audio", "input_audio": { "data": wav, "format": "wav" } },
			],
		}],
		"temperature": 0,
		"max_tokens": MAX_TOKENS,
		"stream": false,
		// A transcript wants no thinking first.
		"chat_template_kwargs": { "enable_thinking": false },
	})
}

/// What the model wrote, on one line.
fn transcript(answer: &Value) -> Option<String> {
	let content = answer.get("choices")?.get(0)?.get("message")?.get("content")?.as_str()?;
	Some(content.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Standard base64, padded.
fn base64(bytes: &[u8]) -> String {
	const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for chunk in bytes.chunks(3) {
		let group = u32::from(chunk[0]) << 16
			| u32::from(chunk.get(1).copied().unwrap_or(0)) << 8
			| u32::from(chunk.get(2).copied().unwrap_or(0));
		for place in 0..4 {
			if place <= chunk.len() {
				out.push(char::from(ALPHABET[(group >> (18 - 6 * place) & 63) as usize]));
			} else {
				out.push('=');
			}
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn base64_pads_what_does_not_fill_a_group() {
		assert_eq!(base64(b""), "");
		assert_eq!(base64(b"f"), "Zg==");
		assert_eq!(base64(b"fo"), "Zm8=");
		assert_eq!(base64(b"foo"), "Zm9v");
		assert_eq!(base64(b"foobar"), "Zm9vYmFy");
		assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
	}

	#[test]
	fn the_request_puts_the_task_before_the_audio() {
		let body = request("gemma", "UklGRg==", None, None);
		assert_eq!(body["model"], "gemma");
		let content = &body["messages"][0]["content"];
		assert_eq!(content[0]["type"], "text");
		assert!(content[0]["text"].as_str().unwrap().starts_with("Transcribe the following speech segment in its original"));
		assert_eq!(content[1]["type"], "input_audio");
		assert_eq!(content[1]["input_audio"]["data"], "UklGRg==");
		assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
	}

	#[test]
	fn a_language_is_named_in_the_task() {
		let body = request("gemma", "", Some("yue"), None);
		let task = body["messages"][0]["content"][0]["text"].as_str().unwrap();
		assert!(task.starts_with("Transcribe the following speech segment in Cantonese into Cantonese text."));
	}

	#[test]
	fn a_hint_is_what_another_recogniser_heard_and_in_what() {
		let hint = Transcript { text: " 다음 \"곡\" 틀어줘 ".to_owned(), lang: Some("ko".to_owned()) };
		let task = |language| {
			let body = request("gemma", "", language, Some(&hint));
			body["messages"][0]["content"][0]["text"].as_str().unwrap().to_owned()
		};
		let auto = task(None);
		assert!(auto.starts_with("Transcribe the following speech segment in its original language.\n\n"));
		assert!(auto.contains("heard it as Korean: \"다음 \\\"곡\\\" 틀어줘\"\n"));
		assert!(auto.ends_with(FORMAT));
		// Told the language, Gemma is not told the other's guess at it.
		let told = task(Some("en"));
		assert!(told.contains("heard it: \"다음"));
		// Nothing heard is no hint.
		let nothing = Transcript { text: " ".to_owned(), lang: None };
		assert_eq!(request("gemma", "", None, Some(&nothing)), request("gemma", "", None, None));
	}

	#[test]
	fn the_transcript_is_the_answer_on_one_line() {
		let answer = json!({ "choices": [{ "message": { "content": " play\nthe next  song \n" } }] });
		assert_eq!(transcript(&answer).as_deref(), Some("play the next song"));
		assert_eq!(transcript(&json!({ "choices": [] })), None);
		assert_eq!(transcript(&json!({ "error": "busy" })), None);
	}

	#[test]
	fn a_language_or_a_url_it_cannot_use_is_refused() {
		assert!(GemmaRecogniser::new("http://127.0.0.1:8085/v1/", "gemma", "auto").is_ok());
		assert_eq!(GemmaRecogniser::new("http://127.0.0.1:8085/v1/", "gemma", "ja").unwrap().url, "http://127.0.0.1:8085/v1");
		assert!(GemmaRecogniser::new("http://127.0.0.1:8085/v1", "gemma", "fr").is_err());
		assert!(GemmaRecogniser::new("127.0.0.1:8085", "gemma", "auto").is_err());
	}
}
