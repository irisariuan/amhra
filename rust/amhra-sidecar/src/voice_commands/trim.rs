//! Taking the name off the front of a transcript, by when it was said.
//!
//! The window starts a little before the spotter says the name ended, so the
//! command's first syllables are not lost — which means the recogniser hears
//! the tail of the name too, and writes it however it likes: "T, skip a
//! song.", "Para, skip this song.", "Per, play the song.". No list of
//! spellings keeps up with that. But the recogniser also says when each token
//! started, and the gate knows where in the window the name ended, so words
//! that began before that point are the name, whatever they were written as.
//!
//! When the spotter puts the end too early, the name lies past the cut and
//! survives; the bot's own matching strips what is left. When it puts it too
//! late, a command's first word is cut and nothing is run: the failure is a
//! missed command, never a different one.

/// One token of a transcript, and when it started, in seconds from the start
/// of the window.
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
	pub text: String,
	pub start: f32,
}

/// Slack past the name's end. SenseVoice times tokens in 60ms steps, so a
/// token stamped at the end itself is still the name's; the earliest command
/// word measured began 120ms after it.
const TOLERANCE: f32 = 0.05;

/// `text` without the words that began before `name_end` seconds. Unchanged
/// when there are no tokens to go by, or when the tokens do not line up with
/// the text closely enough to know which words to drop.
pub fn after_name(text: &str, tokens: &[Token], name_end: f32) -> String {
	let words = words(tokens);
	let drop = words.iter().take_while(|word| word.start <= name_end + TOLERANCE).count();
	if drop == 0 {
		return text.to_owned();
	}

	let joined: String = tokens.iter().map(|token| token.text.as_str()).collect();
	let kept = if same(&joined, text) {
		// The tokens spell the text exactly, so the rest of them is the rest
		// of it.
		words[drop..].iter().flat_map(|word| word.tokens.iter().map(|token| token.text.as_str())).collect()
	} else if text.split_whitespace().count() == words.len() {
		// Inverse text normalisation rewrote something ("three" to "3") but
		// kept the words where they were.
		text.split_whitespace().skip(drop).collect::<Vec<_>>().join(" ")
	} else {
		return text.to_owned();
	};
	kept.trim_start_matches(|c: char| c.is_whitespace() || is_punctuation(c)).trim_end().to_owned()
}

struct Word<'a> {
	start: f32,
	tokens: Vec<&'a Token>,
}

/// Tokens grouped into words. A word starts at a token that begins with a
/// space, and at every token in a script written without them; punctuation
/// belongs to the word before it.
fn words(tokens: &[Token]) -> Vec<Word<'_>> {
	let mut words: Vec<Word> = Vec::new();
	for token in tokens {
		let first = token.text.chars().next();
		let punctuation = !token.text.is_empty() && token.text.trim().chars().all(is_punctuation);
		let starts = words.is_empty()
			|| (!punctuation && (first.is_some_and(char::is_whitespace) || first.is_some_and(unspaced)));
		match words.last_mut() {
			Some(word) if !starts => word.tokens.push(token),
			_ => words.push(Word { start: token.start, tokens: vec![token] }),
		}
	}
	words
}

/// Chinese, Japanese and Korean: one token is one word as far as cutting goes.
fn unspaced(c: char) -> bool {
	matches!(c as u32,
		0x3040..=0x30FF // kana
		| 0x3400..=0x9FFF // CJK ideographs
		| 0xAC00..=0xD7AF // hangul
		| 0xF900..=0xFAFF)
}

fn is_punctuation(c: char) -> bool {
	c.is_ascii_punctuation() || matches!(c, '，' | '。' | '、' | '！' | '？' | '：' | '；')
}

fn same(a: &str, b: &str) -> bool {
	a.split_whitespace().eq(b.split_whitespace())
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Tokens as SenseVoice gave them for real windows, times shifted to the
	/// window's start (the sidecar pads 300ms in front).
	fn tokens(pairs: &[(&str, f32)]) -> Vec<Token> {
		pairs.iter().map(|(text, start)| Token { text: (*text).to_owned(), start: *start }).collect()
	}

	/// The name ends 300ms into every window: the gate's pre-roll.
	const NAME_END: f32 = 0.3;

	#[test]
	fn the_name_goes_however_it_was_written() {
		let heard = tokens(&[("T", 0.0), (",", 0.30), (" skip", 0.42), (" a", 0.66), (" song", 0.90), (".", 1.62)]);
		assert_eq!(after_name("T, skip a song.", &heard, NAME_END), "skip a song.");

		let heard = tokens(&[("P", 0.0), ("ara", 0.24), (",", 0.42), (" skip", 0.66), (" this", 0.96), (" song", 1.2), (".", 1.92)]);
		assert_eq!(after_name("Para, skip this song.", &heard, NAME_END), "skip this song.");

		// Stamped at the end itself: still the name.
		let heard = tokens(&[("P", 0.0), ("er", 0.30), (",", 0.48), (" play", 0.78), (" the", 1.2), (" song", 1.44), (".", 2.22)]);
		assert_eq!(after_name("Per, play the song.", &heard, NAME_END), "play the song.");

		// Live: "T are play expectations."
		let heard = tokens(&[("T", 0.0), (" are", 0.18), (" play", 0.48), (" expect", 0.72), ("ations", 0.96), (".", 1.5)]);
		assert_eq!(after_name("T are play expectations.", &heard, NAME_END), "play expectations.");
	}

	#[test]
	fn a_name_heard_late_is_left_for_the_bot_to_strip() {
		// The spotter put the end too early: the name is past the cut.
		let heard = tokens(&[("I", 0.9), ("m", 1.14), ("har", 1.26), ("ra", 1.5), (",", 1.62), (" play", 1.8)]);
		assert_eq!(after_name("Imharra, play", &heard, NAME_END), "Imharra, play");
	}

	#[test]
	fn the_name_alone_leaves_nothing() {
		let heard = tokens(&[("E", 0.0), ("har", 0.12), ("ra", 0.24), (".", 0.9)]);
		assert_eq!(after_name("Ehara.", &heard, NAME_END), "");
	}

	#[test]
	fn rewritten_text_is_cut_by_words() {
		// "three" became "3": the tokens no longer spell the text.
		let heard = tokens(&[("T", 0.0), (" play", 0.48), (" track", 0.72), (" three", 0.96)]);
		assert_eq!(after_name("T play track 3", &heard, NAME_END), "play track 3");
	}

	#[test]
	fn chinese_is_cut_by_characters() {
		let heard = tokens(&[("嗯", 0.0), ("哈", 0.12), ("拉", 0.24), ("，", 0.30), ("暂", 0.48), ("停", 0.6), ("。", 0.9)]);
		assert_eq!(after_name("嗯哈拉，暂停。", &heard, NAME_END), "暂停。");
	}

	#[test]
	fn without_tokens_nothing_is_cut() {
		assert_eq!(after_name("Para, skip.", &[], NAME_END), "Para, skip.");
	}
}
