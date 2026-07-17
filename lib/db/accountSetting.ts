import type { AudioPlayerSetting } from "../custom";
import { Language } from "../interaction";
import { prisma } from "./core";

export interface AccountSettingInput extends Partial<AudioPlayerSetting> {
	language?: Language;
	autoSuggest?: boolean;
}

export interface AccountSettingReturn {
	autoSkipNonMusic: boolean;
	loop: boolean;
	autoSuggest: boolean;
	language: Language;
}

export default async function editAccountSetting(
	accountId: string,
	setting: AccountSettingInput,
) {
	const data = {
		autoSkipNonMusic: setting.autoSkipSegment,
		loop: setting.looping,
		autoSuggest: setting.autoSuggest,
		language: setting.language,
	};
	return prisma.accountSetting.upsert({
		create: { accountId, ...data },
		update: data,
		where: { accountId },
	});
}

export async function getAccountSetting(
	accountId: string,
): Promise<AccountSettingReturn | null> {
	const result = await prisma.accountSetting.findUnique({
		where: { accountId },
	});
	return result
		? {
				autoSkipNonMusic: result.autoSkipNonMusic,
				loop: result.loop,
				autoSuggest: result.autoSuggest,
				language: result.language as Language,
			}
		: null;
}
