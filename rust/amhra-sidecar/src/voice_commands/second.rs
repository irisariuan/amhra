//! A second recogniser, hearing every window before the first.
//!
//! Gemma 4 is a language model asked over HTTP: its server may still be
//! loading, or not answer, and told no language it may write a command down
//! in another one, or translate it. A sherpa-onnx recogniser — SenseVoice by
//! default, 30–50ms a command — hears the window first. What it made of it,
//! and the language it heard, go to Gemma with the audio as a hint; and its
//! transcript is the one used when Gemma has none (see [`choose`]).

use super::sherpa::script_language;
use super::{ModelError, Transcriber, Transcript};

pub struct WithSecond {
	first: Box<dyn Transcriber>,
	second: Box<dyn Transcriber>,
	/// The first is always told the language, so its transcript's is that
	/// one, whatever the second heard.
	pinned: bool,
}

impl WithSecond {
	pub fn new(first: Box<dyn Transcriber>, second: Box<dyn Transcriber>, pinned: bool) -> Self {
		Self { first, second, pinned }
	}

	fn both(&mut self, samples: &[f32], language: Option<&str>) -> Result<Transcript, ModelError> {
		let Self { first, second, pinned } = self;
		// The second first, as the first is shown what it heard: it is the
		// quick one, so the first starts tens of milliseconds later.
		let second = second.transcribe_in(samples, language);
		let first = first.transcribe_hinted(samples, language, second.as_ref().ok());
		let (transcript, which) = choose(first, second, *pinned || language.is_some())?;
		match which {
			Chosen::First => {}
			// What was heard stays out of the log; why is all that goes in.
			Chosen::Second(why) => eprintln!("voice commands: used the second recogniser's transcript: {why}"),
		}
		Ok(transcript)
	}
}

impl Transcriber for WithSecond {
	fn transcribe(&mut self, samples: &[f32]) -> Result<Transcript, ModelError> {
		self.both(samples, None)
	}

	fn transcribe_in(&mut self, samples: &[f32], language: Option<&str>) -> Result<Transcript, ModelError> {
		self.both(samples, language)
	}
}

#[derive(Debug, PartialEq)]
enum Chosen {
	First,
	Second(String),
}

/// Which transcript to go by.
///
/// The first's, which was made knowing the second's, unless it failed or
/// heard nothing where the second heard something.
///
/// Its language, when the first was told none (`told`), is the second's
/// where the first's writing could be that language: the second tells
/// Mandarin from Cantonese and Japanese in kanji from Chinese by ear, which
/// writing does not show. Where it could not be, the first heard another
/// language than the second and said so by writing it.
fn choose(
	first: Result<Transcript, ModelError>,
	second: Result<Transcript, ModelError>,
	told: bool,
) -> Result<(Transcript, Chosen), ModelError> {
	let second = second.ok().filter(|second| !second.text.trim().is_empty());
	let first = match first {
		Ok(first) if !first.text.trim().is_empty() => first,
		Ok(first) => {
			return Ok(match second {
				Some(second) => (second, Chosen::Second("the first heard nothing".to_owned())),
				None => (first, Chosen::First),
			});
		}
		Err(error) => {
			return match second {
				Some(second) => Ok((second, Chosen::Second(format!("the first failed: {error}")))),
				None => Err(error),
			};
		}
	};
	let Some(second) = second else { return Ok((first, Chosen::First)) };
	if told {
		return Ok((first, Chosen::First));
	}
	let wrote = script_language(&first.text);
	let heard = second.lang.as_deref().or_else(|| script_language(&second.text));
	match (wrote, heard) {
		(Some(wrote), Some(heard)) if same_writing(wrote, heard) => {
			let lang = Some(heard.to_owned());
			Ok((Transcript { lang, ..first }, Chosen::First))
		}
		_ => Ok((first, Chosen::First)),
	}
}

/// Whether text that reads as `wrote` could be speech in `heard`. Han
/// characters alone are Mandarin, Cantonese or Japanese; the rest are only
/// themselves.
fn same_writing(wrote: &str, heard: &str) -> bool {
	wrote == heard || (matches!(wrote, "zh" | "yue") && matches!(heard, "zh" | "yue" | "ja"))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn heard(text: &str, lang: Option<&str>) -> Result<Transcript, ModelError> {
		Ok(Transcript { text: text.to_owned(), lang: lang.map(str::to_owned) })
	}

	fn failed() -> Result<Transcript, ModelError> {
		Err(ModelError::Recognition("the model's server did not answer".to_owned()))
	}

	#[test]
	fn the_first_is_used_when_both_hear_the_same_language() {
		let (transcript, which) = choose(heard("play the next song", Some("en")), heard("play the next song.", Some("en")), false).unwrap();
		assert_eq!(transcript.text, "play the next song");
		assert_eq!(which, Chosen::First);
	}

	#[test]
	fn the_second_says_which_language_han_characters_are() {
		let (transcript, which) = choose(heard("暫停", Some("zh")), heard("暫停。", Some("yue")), false).unwrap();
		assert_eq!(transcript.text, "暫停");
		assert_eq!(transcript.lang.as_deref(), Some("yue"));
		assert_eq!(which, Chosen::First);
		let (transcript, which) = choose(heard("米津玄師", Some("zh")), heard("よねづけんし", Some("ja")), false).unwrap();
		assert_eq!((transcript.text.as_str(), transcript.lang.as_deref()), ("米津玄師", Some("ja")));
		assert_eq!(which, Chosen::First);
	}

	#[test]
	fn the_first_stands_when_it_wrote_another_language_than_the_second_heard() {
		// It saw the second's transcript and still wrote this.
		let (transcript, which) = choose(heard("Play the next song", Some("en")), heard("什么号啊？", Some("zh")), false).unwrap();
		assert_eq!(transcript.text, "Play the next song");
		assert_eq!(transcript.lang.as_deref(), Some("en"));
		assert_eq!(which, Chosen::First);
	}

	#[test]
	fn a_language_the_first_was_told_is_not_argued_with() {
		let (transcript, which) = choose(heard("Play the next song", Some("en")), heard("다음 곡 틀어줘", Some("ko")), true).unwrap();
		assert_eq!(transcript.text, "Play the next song");
		assert_eq!(transcript.lang.as_deref(), Some("en"));
		assert_eq!(which, Chosen::First);
	}

	#[test]
	fn the_second_stands_in_when_the_first_fails_or_hears_nothing() {
		for told in [false, true] {
			let (transcript, which) = choose(failed(), heard("skip", Some("en")), told).unwrap();
			assert_eq!(transcript.text, "skip");
			assert!(matches!(which, Chosen::Second(_)));
			let (transcript, which) = choose(heard(" ", None), heard("skip", Some("en")), told).unwrap();
			assert_eq!(transcript.text, "skip");
			assert!(matches!(which, Chosen::Second(_)));
		}
	}

	#[test]
	fn without_a_second_transcript_the_first_stands_as_it_is() {
		let (transcript, which) = choose(heard("skip", Some("en")), failed(), false).unwrap();
		assert_eq!((transcript.text.as_str(), which), ("skip", Chosen::First));
		let (transcript, _) = choose(heard("skip", Some("en")), heard("", None), false).unwrap();
		assert_eq!(transcript.text, "skip");
		assert!(choose(failed(), failed(), false).is_err());
		assert!(choose(failed(), heard("", None), false).is_err());
		assert_eq!(choose(heard("", None), failed(), false).unwrap().0.text, "");
	}
}
