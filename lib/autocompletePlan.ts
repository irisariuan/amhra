/**
 * Suggestions for options that name an item by its place in a list, such as
 * `/mix remove layer` or `/remove index`. Users still get the 1-based number
 * they would have typed; the suggestion just shows what each number is.
 *
 * Kept free of imports, like `mixPlan.ts`, so the matching is testable without
 * loading discord.js or the player.
 */

/** Discord shows at most 25 suggestions. */
export const MAX_CHOICES = 25;
/** And cuts each one's name off at 100 characters. */
const MAX_NAME_LENGTH = 100;

export interface IndexChoice {
	name: string;
	value: number;
}

function truncate(text: string, length: number) {
	return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

/**
 * One suggestion per label, numbered from 1, narrowed to what the user has
 * typed so far. A number matches positions starting with it, so "1" offers 1,
 * 10 and 11; anything else matches the label's text, ignoring case.
 */
export function indexChoices(labels: readonly string[], typed: string): IndexChoice[] {
	const query = typed.trim().toLowerCase();
	const byNumber = /^\d+$/.test(query);
	const choices: IndexChoice[] = [];
	for (let i = 0; i < labels.length && choices.length < MAX_CHOICES; i++) {
		const position = i + 1;
		const label = labels[i];
		if (
			query &&
			!(byNumber
				? String(position).startsWith(query)
				: label.toLowerCase().includes(query))
		)
			continue;
		const prefix = `${position}. `;
		choices.push({
			name: prefix + truncate(label, MAX_NAME_LENGTH - prefix.length),
			value: position,
		});
	}
	return choices;
}
