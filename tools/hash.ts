import crypto from "node:crypto";
import { input } from "@inquirer/prompts";

/**
 * Hash a dashboard password into the value AUTH_TOKEN expects.
 *
 * It is printed rather than written: AUTH_TOKEN lives in `.env` now, and a tool
 * that edits a credential file behind the operator's back is how a secret ends
 * up somewhere nobody remembers putting it.
 */
input({ message: "Password" }).then((password) => {
	const hash = crypto
		.createHash("sha256")
		.update(`Basic ${password}`)
		.digest("hex");
	console.log(`\nAdd this line to .env:\n\nAUTH_TOKEN=${hash}\n`);
});
