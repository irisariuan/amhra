//! The wake words: plain phrases in a file, spelled into the spotter's word
//! pieces when the sidecar starts.
//!
//! The spotter does not read text. It matches sequences of the BPE pieces its
//! model was trained on — `AMHRA` is `▁AM H RA` to it — and sherpa-onnx
//! expects the keywords file already written that way. Asking whoever edits
//! the list to tokenise by hand would make adding "Hey Amhra" a research
//! project, so the file holds phrases and this module does the spelling, using
//! the model's own `bpe.model`.
//!
//! It also checks every line before sherpa-onnx sees it. A piece the model does
//! not know makes sherpa-onnx *exit the process*, which here would take every
//! guild's audio down with it; a typo in a text file has to be an error message
//! instead.
//!
//! ```text
//! # one phrase per line; '#' at the start of a line is a comment
//! AMHRA
//! HEY AMHRA :2.0 #0.20
//! ```
//!
//! `:<boost>` pulls the decoder towards the phrase; `#<threshold>` is the
//! confidence it must reach to fire, from 0 to 1. Lower fires more readily,
//! and falsely more often.

use std::collections::{HashMap, HashSet};

/// SentencePiece's word-boundary marker.
const BOUNDARY: char = '▁';

#[derive(Debug, thiserror::Error)]
pub enum KeywordError {
	#[error("bpe.model is not a SentencePiece model: {0}")]
	Model(&'static str),
	#[error("keywords line {line}: {reason}")]
	Line { line: usize, reason: String },
	#[error("keywords line {line}: \"{phrase}\" spells as {piece:?}, which the model has no token for")]
	UnknownPiece { line: usize, phrase: String, piece: String },
	#[error("no keywords: the file has no phrases in it")]
	Empty,
}

/// One phrase from the file.
#[derive(Debug, Clone, PartialEq)]
pub struct Keyword {
	/// Upper case, single-spaced: what a detection reports.
	pub phrase: String,
	pub boost: Option<f32>,
	pub threshold: Option<f32>,
	/// Line number, for errors.
	pub line: usize,
}

/// Read the phrases out of a keywords file.
pub fn parse(text: &str) -> Result<Vec<Keyword>, KeywordError> {
	let mut keywords = Vec::new();
	for (index, raw) in text.lines().enumerate() {
		let line = index + 1;
		let content = raw.trim();
		// A threshold also starts with '#', but never as the first word.
		if content.is_empty() || content.starts_with('#') {
			continue;
		}
		let mut words = Vec::new();
		let (mut boost, mut threshold) = (None, None);
		for word in content.split_whitespace() {
			let number = |value: &str, what: &str| {
				value.parse::<f32>().map_err(|_| KeywordError::Line {
					line,
					reason: format!("{what} {value:?} is not a number"),
				})
			};
			if let Some(value) = word.strip_prefix(':') {
				boost = Some(number(value, "boost")?);
			} else if let Some(value) = word.strip_prefix('#') {
				let value = number(value, "threshold")?;
				if !(0.0..=1.0).contains(&value) {
					return Err(KeywordError::Line {
						line,
						reason: format!("threshold {value} is outside 0..1"),
					});
				}
				threshold = Some(value);
			} else if boost.is_some() || threshold.is_some() {
				return Err(KeywordError::Line {
					line,
					reason: "the phrase must come before :boost and #threshold".to_owned(),
				});
			} else if !word.chars().all(|c| c.is_alphanumeric() || c == '\'') {
				return Err(KeywordError::Line {
					line,
					reason: format!("{word:?}: phrases are letters only"),
				});
			} else {
				words.push(word.to_uppercase());
			}
		}
		if words.is_empty() {
			return Err(KeywordError::Line { line, reason: "no phrase".to_owned() });
		}
		keywords.push(Keyword { phrase: words.join(" "), boost, threshold, line });
	}
	if keywords.is_empty() {
		return Err(KeywordError::Empty);
	}
	Ok(keywords)
}

/// Write `keywords` the way sherpa-onnx reads them: pieces, then the boost, the
/// threshold and the phrase to report (spaces as underscores — it takes one
/// word there).
///
/// Every line gets an explicit boost and threshold. sherpa-onnx reads a line
/// without one as zero, not as the default, once any line has one.
pub fn spotter_lines(
	keywords: &[Keyword],
	vocabulary: &Vocabulary,
	tokens: &HashSet<String>,
	default_boost: f32,
	default_threshold: f32,
) -> Result<String, KeywordError> {
	let mut out = String::new();
	for keyword in keywords {
		let mut pieces = Vec::new();
		for word in keyword.phrase.split(' ') {
			for piece in vocabulary.encode(word) {
				if !tokens.contains(&piece) {
					return Err(KeywordError::UnknownPiece {
						line: keyword.line,
						phrase: keyword.phrase.clone(),
						piece,
					});
				}
				pieces.push(piece);
			}
		}
		out.push_str(&format!(
			"{} :{} #{} @{}\n",
			pieces.join(" "),
			keyword.boost.unwrap_or(default_boost),
			keyword.threshold.unwrap_or(default_threshold),
			keyword.phrase.replace(' ', "_"),
		));
	}
	Ok(out)
}

/// The phrase a detection names, from what [`spotter_lines`] wrote.
pub fn phrase(reported: &str) -> String {
	reported.replace('_', " ")
}

/// The token list of a sherpa-onnx model: `tokens.txt`, one `<piece> <id>` per
/// line.
pub fn token_set(tokens_txt: &str) -> HashSet<String> {
	tokens_txt
		.lines()
		.filter_map(|line| line.split_whitespace().next())
		.map(str::to_owned)
		.collect()
}

/// A SentencePiece BPE vocabulary: enough of one to spell words with it.
#[derive(Debug, Default)]
pub struct Vocabulary {
	scores: HashMap<String, f32>,
}

impl Vocabulary {
	/// From pieces and their merge scores. Higher scores merge first.
	pub fn from_scores<'a>(pieces: impl IntoIterator<Item = (&'a str, f32)>) -> Self {
		Self { scores: pieces.into_iter().map(|(piece, score)| (piece.to_owned(), score)).collect() }
	}

	/// Read a `bpe.model` file.
	///
	/// It is a protobuf `ModelProto`, whose field 1 repeats `SentencePiece {
	/// string piece = 1; float score = 2; Type type = 3; }`. Those three
	/// fields are all that spelling needs, so they are read by hand rather
	/// than pulling in a protobuf toolchain for one message.
	pub fn from_sentencepiece(bytes: &[u8]) -> Result<Self, KeywordError> {
		let mut scores = HashMap::new();
		let mut reader = Reader { bytes, at: 0 };
		while !reader.done() {
			let (field, kind) = reader.key()?;
			if field == 1 && kind == 2 {
				let mut piece_reader = Reader { bytes: reader.bytes()?, at: 0 };
				let (mut piece, mut score, mut piece_type) = (None, 0.0, 1);
				while !piece_reader.done() {
					match piece_reader.key()? {
						(1, 2) => {
							piece = Some(
								std::str::from_utf8(piece_reader.bytes()?)
									.map_err(|_| KeywordError::Model("a piece is not UTF-8"))?,
							)
						}
						(2, 5) => score = f32::from_le_bytes(piece_reader.fixed::<4>()?),
						(3, 0) => piece_type = piece_reader.varint()?,
						(_, kind) => piece_reader.skip(kind)?,
					}
				}
				// Only normal and user-defined pieces take part in merges;
				// <unk>, <s>, </s> and unused slots never do.
				if let Some(piece) = piece
					&& matches!(piece_type, 1 | 4)
				{
					scores.insert(piece.to_owned(), score);
				}
			} else {
				reader.skip(kind)?;
			}
		}
		if scores.is_empty() {
			return Err(KeywordError::Model("it has no pieces"));
		}
		Ok(Self { scores })
	}

	/// Spell one word, as SentencePiece's BPE does: start from characters
	/// (the first marked as a word start) and keep merging the adjacent pair
	/// whose union scores highest, leftmost first on a tie, until no pair is a
	/// piece.
	pub fn encode(&self, word: &str) -> Vec<String> {
		let mut symbols: Vec<String> =
			std::iter::once(BOUNDARY).chain(word.chars()).map(String::from).collect();
		loop {
			let mut best: Option<(usize, f32)> = None;
			for index in 0..symbols.len().saturating_sub(1) {
				let merged = format!("{}{}", symbols[index], symbols[index + 1]);
				if let Some(&score) = self.scores.get(&merged)
					&& best.is_none_or(|(_, best)| score > best)
				{
					best = Some((index, score));
				}
			}
			let Some((index, _)) = best else { return symbols };
			let right = symbols.remove(index + 1);
			symbols[index].push_str(&right);
		}
	}
}

struct Reader<'a> {
	bytes: &'a [u8],
	at: usize,
}

impl<'a> Reader<'a> {
	fn done(&self) -> bool {
		self.at >= self.bytes.len()
	}

	fn varint(&mut self) -> Result<u64, KeywordError> {
		let mut value = 0u64;
		for shift in (0..64).step_by(7) {
			let byte = *self.bytes.get(self.at).ok_or(KeywordError::Model("truncated varint"))?;
			self.at += 1;
			value |= u64::from(byte & 0x7f) << shift;
			if byte & 0x80 == 0 {
				return Ok(value);
			}
		}
		Err(KeywordError::Model("overlong varint"))
	}

	fn key(&mut self) -> Result<(u64, u8), KeywordError> {
		let key = self.varint()?;
		Ok((key >> 3, (key & 7) as u8))
	}

	fn take(&mut self, length: usize) -> Result<&'a [u8], KeywordError> {
		let end = self.at.checked_add(length).ok_or(KeywordError::Model("bad length"))?;
		let slice = self.bytes.get(self.at..end).ok_or(KeywordError::Model("truncated field"))?;
		self.at = end;
		Ok(slice)
	}

	fn bytes(&mut self) -> Result<&'a [u8], KeywordError> {
		let length = self.varint()?;
		self.take(usize::try_from(length).map_err(|_| KeywordError::Model("bad length"))?)
	}

	fn fixed<const N: usize>(&mut self) -> Result<[u8; N], KeywordError> {
		Ok(self.take(N)?.try_into().expect("took N bytes"))
	}

	fn skip(&mut self, kind: u8) -> Result<(), KeywordError> {
		match kind {
			0 => self.varint().map(drop),
			1 => self.take(8).map(drop),
			2 => self.bytes().map(drop),
			5 => self.take(4).map(drop),
			_ => Err(KeywordError::Model("unsupported wire type")),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn vocabulary() -> Vocabulary {
		Vocabulary::from_scores([
			("▁A", -1.0),
			("▁AM", -2.0),
			("RA", -3.0),
			("▁H", -3.5),
			("▁HE", -4.0),
			("▁HEY", -5.0),
			("HR", -9.0),
		])
	}

	fn tokens() -> HashSet<String> {
		["▁AM", "H", "RA", "▁HEY", "▁A", "M"].iter().map(|piece| (*piece).to_owned()).collect()
	}

	#[test]
	fn words_merge_highest_score_first() {
		// "HR" is a piece too, but "RA" outscores it, so it wins the R.
		assert_eq!(vocabulary().encode("AMHRA"), vec!["▁AM", "H", "RA"]);
		assert_eq!(vocabulary().encode("HEY"), vec!["▁HEY"]);
	}

	#[test]
	fn phrases_become_spotter_lines_with_explicit_settings() {
		let keywords = parse("# the name\nAmhra\n\nhey  amhra :2 #0.1\n").unwrap();
		assert_eq!(keywords.len(), 2);
		assert_eq!(keywords[1].phrase, "HEY AMHRA");
		let lines = spotter_lines(&keywords, &vocabulary(), &tokens(), 1.5, 0.25).unwrap();
		assert_eq!(lines, "▁AM H RA :1.5 #0.25 @AMHRA\n▁HEY ▁AM H RA :2 #0.1 @HEY_AMHRA\n");
		assert_eq!(phrase("HEY_AMHRA"), "HEY AMHRA");
	}

	#[test]
	fn a_piece_the_model_lacks_is_an_error_not_a_crash() {
		let keywords = parse("AMHRAZ").unwrap();
		let error = spotter_lines(&keywords, &vocabulary(), &tokens(), 1.5, 0.25).unwrap_err();
		assert!(matches!(error, KeywordError::UnknownPiece { line: 1, ref piece, .. } if piece == "Z"));
	}

	#[test]
	fn malformed_lines_are_refused_with_their_line_number() {
		for (text, line) in [
			("AMHRA\n:2 AMHRA", 2),
			("AMHRA #2", 1),
			("AMHRA :fast", 1),
			("AM-HRA", 1),
			("AMHRA :2 HEY", 1),
		] {
			match parse(text) {
				Err(KeywordError::Line { line: found, .. }) => assert_eq!(found, line, "{text}"),
				other => panic!("{text}: {other:?}"),
			}
		}
		assert!(matches!(parse("# only a comment\n"), Err(KeywordError::Empty)));
	}

	/// A `ModelProto` written out by hand, with fields the reader must skip.
	#[test]
	fn reads_pieces_from_a_sentencepiece_model() {
		fn piece(text: &str, score: f32, piece_type: Option<u8>) -> Vec<u8> {
			let mut body = vec![0x0a, text.len() as u8];
			body.extend_from_slice(text.as_bytes());
			body.push(0x15);
			body.extend_from_slice(&score.to_le_bytes());
			if let Some(piece_type) = piece_type {
				body.extend_from_slice(&[0x18, piece_type]);
			}
			let mut field = vec![0x0a, body.len() as u8];
			field.extend(body);
			field
		}
		let mut model = Vec::new();
		model.extend(piece("<unk>", 0.0, Some(2)));
		model.extend(piece("▁AM", -2.0, None));
		model.extend(piece("RA", -3.0, Some(1)));
		// A trainer spec (field 2), which is skipped.
		model.extend_from_slice(&[0x12, 0x02, 0x08, 0x01]);
		model.extend(piece("▁A", -1.0, Some(1)));

		let vocabulary = Vocabulary::from_sentencepiece(&model).unwrap();
		assert_eq!(vocabulary.scores.len(), 3, "<unk> is not a mergeable piece");
		assert_eq!(vocabulary.encode("AMRA"), vec!["▁AM", "RA"]);
		assert!(Vocabulary::from_sentencepiece(&model[..model.len() - 3]).is_err());
	}
}
