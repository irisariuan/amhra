import { AudioPlayerSetting } from "../custom";
import { Language } from "../interaction";
import { prisma } from "./core";

export interface UserSetting extends AudioPlayerSetting {
	language: Language;
}

export interface UserSettingReturn {
	autoSkipNonMusic: boolean;
	loop: boolean;
	language: Language;
}

export default async function editUserSetting(userId: string, setting: UserSetting) {
	return await prisma.userSetting.upsert({
		create: {
			userId,
			autoSkipNonMusic: setting.autoSkipSegment,
			loop: setting.looping,
			language: setting.language,
		},
		update: {
			autoSkipNonMusic: setting.autoSkipSegment,
			loop: setting.looping,
			language: setting.language,
		},
		where: { userId },
	});
}

export async function getUserSetting(
	userId: string,
): Promise<UserSettingReturn | null> {
	const result = await prisma.userSetting.findUnique({ where: { userId } });
	return result
		? {
				autoSkipNonMusic: result.autoSkipNonMusic,
				loop: result.loop,
				language: result.language as Language,
			}
		: null;
}
