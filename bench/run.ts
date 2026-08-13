/**
 * Compare the Rust audio path against the one it replaces.
 *
 * ```text
 * bun bench/run.ts                      # audio benchmarks, no network
 * bun bench/run.ts --fetch              # also compare downloaders (network)
 * bun bench/run.ts --file cache/x.music # use a specific track
 * ```
 *
 * Both stacks run on the same file, in the same process invocation, on whatever
 * machine you are reading this on. The numbers are not portable and are not
 * meant to be: what is being compared is two implementations, not two machines.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { benchCrypto, benchDemux, benchVolume, loadFrames } from "./audio";
import { benchFetch } from "./fetch";
import { report, run, type Measurement } from "./lib";

const args = process.argv.slice(2);
const withFetch = args.includes("--fetch");
const fileArgument = args[args.indexOf("--file") + 1];

const CARGO = ["cargo", "run", "--release", "--quiet", "--manifest-path", "rust/Cargo.toml"];

/** The largest cached track, so the measurement is not dominated by overhead. */
function pickFile() {
	if (fileArgument && existsSync(fileArgument)) return fileArgument;
	const dir = `${process.cwd()}/cache`;
	if (!existsSync(dir)) throw new Error("no cache directory; play something first");

	const candidates = readdirSync(dir)
		.filter((name) => name.endsWith(".music") && !name.includes(".temp."))
		.map((name) => ({ path: `${dir}/${name}`, size: statSync(`${dir}/${name}`).size }))
		.sort((a, b) => b.size - a.size);
	if (!candidates.length) throw new Error("no cached tracks to benchmark");
	return candidates[0].path;
}

/** Run one of the Rust bench examples and parse its JSON. */
async function rustBench(pkg: string, example: string, file: string): Promise<Measurement[]> {
	const { stdout, code, stderr } = await run([
		...CARGO,
		"-p",
		pkg,
		"--example",
		example,
		"--",
		file,
	]);
	if (code !== 0) {
		console.error(`rust bench failed for ${pkg}:\n${stderr}`);
		return [];
	}
	// cargo may print its own lines first; the payload is the last one.
	const line = stdout.trim().split("\n").at(-1) ?? "";
	try {
		return JSON.parse(line).results as Measurement[];
	} catch {
		console.error(`could not parse rust output for ${pkg}: ${line.slice(0, 200)}`);
		return [];
	}
}

async function main() {
	const file = pickFile();
	const sizeMib = statSync(file).size / (1024 * 1024);
	console.log(`benchmarking against ${file} (${sizeMib.toFixed(1)} MiB)`);
	console.log("building the rust benches…");
	await run([...CARGO.slice(0, 2).concat(["--release", "--quiet"]), "--help"], { quiet: true });

	const { frames } = await loadFrames(file);

	const tsDemux = await benchDemux(file);
	const tsCrypto = await benchCrypto(frames);
	const tsVolume = await benchVolume(frames);

	const rustAudio = await rustBench("amhra-audio", "bench_audio", file);
	const rustVoice = await rustBench("amhra-voice", "bench_voice", file);

	report("Container parsing", tsDemux, rustAudio);
	report("Voice packet path", [...tsCrypto, ...tsVolume], rustVoice);

	// Seeking and opening have no TypeScript counterpart worth timing: the current
	// player seeks by re-reading and re-demuxing from the start, which is the
	// difference the index exists to remove.
	const rustOnly = rustAudio.filter((result) => ["open_track", "seek"].includes(result.name));
	if (rustOnly.length) {
		report("Rust only (no equivalent in the current pipeline)", [], rustOnly);
	}

	if (withFetch) {
		const fetchResults = await benchFetch();
		report("Downloading a track", fetchResults.typescript, fetchResults.rust);
	} else {
		console.log("\nskipping the download comparison; pass --fetch to include it");
	}

	console.log(
		"\nnotes:\n" +
			"  · µs/frame is per 20ms audio frame, so one stream at 50fps pays it 50 times a second\n" +
			"  · percent-of-tick in the rust output is the share of a 20ms budget one stream uses\n" +
			"  · DAVE framing has no TypeScript column: @snazzah/davey is itself Rust\n",
	);

}

await main();
