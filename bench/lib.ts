/**
 * Shared measurement helpers for the benchmark suite.
 *
 * Medians rather than means: one descheduled run should not move the answer,
 * and what is being compared is what usually happens. p95 is reported next to
 * it, because a tail that is far from the median is itself the finding — an
 * audio path is only as good as its worst tick.
 */

export interface Measurement {
	name: string;
	medianMs: number;
	p95Ms: number;
	/** Throughput, when the work has a size. */
	mibPerSec?: number;
	/** Per-frame cost, for work measured a frame at a time. */
	usPerFrame?: number;
	/** Share of one 20ms tick that per-frame cost consumes. */
	percentOfTick?: number;
	notes?: string;
}

export interface Suite {
	stack: "typescript" | "rust";
	file?: string;
	frames?: number;
	results: Measurement[];
}

function quantile(samples: number[], fraction: number) {
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.round((sorted.length - 1) * fraction);
	return sorted[index];
}

/**
 * Run `body` `runs` times after one untimed warm-up pass, returning median and
 * p95 in milliseconds.
 */
export async function measure(runs: number, body: () => unknown | Promise<unknown>) {
	// Warm-up: pages faulted in, JIT tiered up, caches populated. Timing the
	// first run of a JIT-compiled function measures the compiler.
	await body();

	const samples: number[] = [];
	for (let i = 0; i < runs; i++) {
		const started = Bun.nanoseconds();
		await body();
		samples.push((Bun.nanoseconds() - started) / 1e6);
	}
	return { medianMs: quantile(samples, 0.5), p95Ms: quantile(samples, 0.95) };
}

/** Measure work done one frame at a time, reported per frame. */
export async function perFrame(
	runs: number,
	frames: number,
	body: () => unknown | Promise<unknown>,
) {
	for (let i = 0; i < frames; i++) await body();

	const samples: number[] = [];
	for (let run = 0; run < runs; run++) {
		const started = Bun.nanoseconds();
		for (let i = 0; i < frames; i++) await body();
		samples.push((Bun.nanoseconds() - started) / 1000 / frames);
	}
	const usPerFrame = quantile(samples, 0.5);
	return {
		usPerFrame,
		// A frame is due every 20ms. This is the share of that budget one
		// stream spends here, which is what decides how many fit on a core.
		percentOfTick: (usPerFrame / 20_000) * 100,
		medianMs: usPerFrame / 1000,
		p95Ms: quantile(samples, 0.95) / 1000,
	};
}

export function bytesToMib(bytes: number) {
	return bytes / (1024 * 1024);
}

/** Run a command and return its stdout, stderr and wall time. */
export async function run(command: string[], options: { quiet?: boolean } = {}) {
	const started = Bun.nanoseconds();
	const proc = Bun.spawn(command, {
		stdout: "pipe",
		stderr: options.quiet ? "ignore" : "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = options.quiet ? "" : await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { stdout, stderr, code, wallMs: (Bun.nanoseconds() - started) / 1e6 };
}

/** Peak resident memory of a command, in MiB, via /usr/bin/time. */
export async function peakRssMib(command: string[]) {
	// -l on BSD/macOS and -v on GNU both report it, in different formats and
	// different units, so both are parsed rather than assuming a platform.
	const { stderr } = await run(["/usr/bin/time", "-l", ...command]);
	const bsd = stderr.match(/(\d+)\s+maximum resident set size/);
	if (bsd) return Number(bsd[1]) / (1024 * 1024);
	const gnu = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
	if (gnu) return Number(gnu[1]) / 1024;
	return Number.NaN;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function pad(text: string, width: number, align: "left" | "right" = "left") {
	// Padding is computed on the visible length, so colour codes do not shift
	// the columns.
	const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
	const spaces = " ".repeat(Math.max(0, width - visible.length));
	return align === "left" ? text + spaces : spaces + text;
}

function format(value: number | undefined, digits: number) {
	return value === undefined || Number.isNaN(value) ? "—" : value.toFixed(digits);
}

/**
 * Print one stack's results, or two side by side with the ratio between them.
 *
 * The ratio is always "how many times faster is Rust", so a number below 1 is
 * a case where the TypeScript path wins — which is worth seeing, not hiding.
 */
export function report(title: string, typescript: Measurement[], rust: Measurement[] = []) {
	console.log(`\n${BOLD}${title}${RESET}`);

	const names = [...new Set([...typescript.map((r) => r.name), ...rust.map((r) => r.name)])];
	const byName = (list: Measurement[], name: string) => list.find((r) => r.name === name);

	const widths = { name: 26, value: 14 };
	console.log(
		DIM +
			pad("measurement", widths.name) +
			pad("typescript", widths.value, "right") +
			pad("rust", widths.value, "right") +
			pad("speedup", 12, "right") +
			RESET,
	);

	for (const name of names) {
		const ts = byName(typescript, name);
		const rs = byName(rust, name);
		const unit = ts?.usPerFrame ?? rs?.usPerFrame ? "µs/frame" : "ms";
		const tsValue = ts?.usPerFrame ?? ts?.medianMs;
		const rsValue = rs?.usPerFrame ?? rs?.medianMs;

		let speedup = "—";
		if (tsValue !== undefined && rsValue !== undefined && rsValue > 0) {
			const ratio = tsValue / rsValue;
			const colour = ratio >= 1 ? GREEN : RED;
			// Past a certain point the honest description is that the work was
			// removed, not that it got faster: a four-figure ratio is comparing
			// a codec round trip against a pointer copy.
			speedup =
				ratio >= 1000
					? `${GREEN}removed${RESET}`
					: `${colour}${ratio >= 100 ? ratio.toFixed(0) : ratio.toFixed(1)}×${RESET}`;
		}

		console.log(
			pad(name, widths.name) +
				pad(format(tsValue, 3), widths.value, "right") +
				pad(format(rsValue, 3), widths.value, "right") +
				pad(speedup, 12, "right") +
				DIM +
				`  ${unit}` +
				RESET,
		);
		const note = ts?.notes ?? rs?.notes;
		if (note) console.log(`${DIM}  ${note}${RESET}`);
	}
}
