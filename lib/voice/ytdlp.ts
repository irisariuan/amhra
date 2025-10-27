import { spawn } from "node:child_process";
export function updateYtdlpVersion() {
	const proc = spawn("pip3", ["install", "--upgrade", "yt-dlp"], {
		stdio: "inherit",
	});
	return new Promise<void>((resolve, error) => {
		proc.on("exit", (number) => {
			if (number === 0) {
				console.log("yt-dlp updated successfully");
				resolve();
			} else {
				console.error(`yt-dlp update failed with exit code ${number}`);
				error(number);
			}
		});
	});
}
