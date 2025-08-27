import { PrismaClient } from "@prisma/client";
import { misc, globalApp } from "../misc";

export const prisma = new PrismaClient();

export async function newUser({
	id,
	token,
	tokenType,
	refreshToken,
	refreshTokenExpiresAt,
	permission = 1,
}: {
	id: string;
	token: string;
	tokenType: string;
	refreshToken: string;
	refreshTokenExpiresAt: number;
	permission?: number;
}) {
	return await prisma.user.upsert({
		where: { id },
		update: {
			accessToken: misc.generateToken(36),
			refreshToken,
			token,
			refreshTokenExpiresAt,
			permission,
		},
		create: {
			accessToken: misc.generateToken(36),
			id,
			refreshToken,
			token,
			refreshTokenExpiresAt,
			tokenType,
			permission,
		},
	});
}

export async function getUser(accessToken: string) {
	return await prisma.user.findFirst({
		where: { accessToken: misc.removeBearer(accessToken) },
	});
}

export async function countUser(accessToken: string) {
	return await prisma.user.count({
		where: { accessToken: misc.removeBearer(accessToken) },
	});
}

export async function hasUser(accessToken: string) {
	return (
		(await prisma.user.count({
			where: { accessToken: misc.removeBearer(accessToken) },
		})) > 0
	);
}

process.on("exit", async () => {
	globalApp.important("Disconnecting from database");
	await prisma.$disconnect();
});
