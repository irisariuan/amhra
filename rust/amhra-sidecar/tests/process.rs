//! The sidecar as the bot sees it: a process on the other end of two pipes.
//!
//! Nothing here touches Discord. What is under test is the boundary — framing,
//! dispatch, error reporting and shutdown — which is exactly the part that
//! fails silently if it is only ever exercised by hand.

use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command as OsCommand, Stdio};
use std::time::Duration;

use amhra_sidecar::framing::{read_frame, write_frame};
use amhra_sidecar::protocol::{Command, Event};

struct Sidecar {
	child: Child,
	stdin: ChildStdin,
	stdout: BufReader<ChildStdout>,
	buffer: Vec<u8>,
}

impl Sidecar {
	fn start() -> Self {
		let mut child = OsCommand::new(env!("CARGO_BIN_EXE_amhra-sidecar"))
			.arg("--cache-dir")
			.arg(std::env::temp_dir())
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
			.expect("the sidecar binary runs");
		let stdin = child.stdin.take().expect("stdin is piped");
		let stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
		Self { child, stdin, stdout, buffer: Vec::new() }
	}

	fn send(&mut self, command: Command) {
		write_frame(&mut self.stdin, &command).expect("command written");
	}

	fn next_event(&mut self) -> Event {
		read_frame(&mut self.stdout, &mut self.buffer).expect("an event")
	}
}

impl Drop for Sidecar {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

#[test]
fn it_announces_itself_before_anything_is_asked() {
	let mut sidecar = Sidecar::start();
	let Event::Hello { version, pid } = sidecar.next_event() else {
		panic!("the first event must be hello");
	};
	assert_eq!(version, amhra_sidecar::protocol::PROTOCOL_VERSION);
	assert!(pid > 0);
}

#[test]
fn it_reports_no_sessions_when_idle() {
	let mut sidecar = Sidecar::start();
	sidecar.next_event(); // hello

	sidecar.send(Command::ListSessions);
	let Event::Sessions { guilds } = sidecar.next_event() else {
		panic!("expected a sessions listing");
	};
	assert!(guilds.is_empty());
}

#[test]
fn commands_for_an_unknown_guild_are_refused_not_ignored() {
	let mut sidecar = Sidecar::start();
	sidecar.next_event();

	// A bot whose state drifted from the sidecar's must be told, or it will
	// wait forever for a track that was never going to play.
	sidecar.send(Command::Skip { guild_id: "999".to_owned() });
	let Event::Error { guild_id, message } = sidecar.next_event() else {
		panic!("expected an error");
	};
	assert_eq!(guild_id.as_deref(), Some("999"));
	assert!(message.contains("not connected"), "unhelpful message: {message}");
}

#[test]
fn playing_without_a_connection_is_refused_before_the_cache_is_consulted() {
	let mut sidecar = Sidecar::start();
	sidecar.next_event();

	// Connection is checked first, so this says "not connected" rather than
	// anything about the track. Asserting the message keeps a later reordering
	// from turning this into a test of nothing.
	sidecar.send(Command::Play {
		guild_id: "1".to_owned(),
		track_id: "does-not-exist".to_owned(),
		start_ms: 0,
	});
	let Event::Error { guild_id, message } = sidecar.next_event() else {
		panic!("expected an error");
	};
	assert_eq!(guild_id.as_deref(), Some("1"));
	assert!(message.contains("not connected"), "unexpected message: {message}");
}

#[test]
fn a_malformed_frame_does_not_end_the_process() {
	let mut sidecar = Sidecar::start();
	sidecar.next_event();

	// Well-framed, but not a command this build knows.
	let payload = br#"{"type":"explode"}"#;
	sidecar.stdin.write_all(&(payload.len() as u32).to_be_bytes()).unwrap();
	sidecar.stdin.write_all(payload).unwrap();
	sidecar.stdin.flush().unwrap();

	let Event::Error { guild_id, message } = sidecar.next_event() else {
		panic!("expected an error");
	};
	assert!(guild_id.is_none());
	assert!(message.contains("bad command frame"), "unhelpful message: {message}");

	// And it is still answering afterwards.
	sidecar.send(Command::ListSessions);
	assert!(matches!(sidecar.next_event(), Event::Sessions { .. }));
}

#[test]
fn shutdown_ends_the_process() {
	let mut sidecar = Sidecar::start();
	sidecar.next_event();

	sidecar.send(Command::Shutdown);
	for _ in 0..50 {
		if let Some(status) = sidecar.child.try_wait().expect("wait works") {
			assert!(status.success(), "the sidecar should exit cleanly");
			return;
		}
		std::thread::sleep(Duration::from_millis(20));
	}
	panic!("the sidecar ignored shutdown");
}

#[test]
fn closing_the_pipe_ends_the_process() {
	// The bot dying is the other shutdown path, and the one that actually
	// happens: a sidecar outliving its bot would hold a voice connection with
	// nothing behind it.
	let mut sidecar = Sidecar::start();
	sidecar.next_event();

	let stdin = std::mem::replace(&mut sidecar.stdin, {
		let mut placeholder = OsCommand::new("true").stdin(Stdio::piped()).spawn().unwrap();
		placeholder.stdin.take().unwrap()
	});
	drop(stdin);

	for _ in 0..50 {
		if sidecar.child.try_wait().expect("wait works").is_some() {
			return;
		}
		std::thread::sleep(Duration::from_millis(20));
	}
	panic!("the sidecar outlived its bot");
}
