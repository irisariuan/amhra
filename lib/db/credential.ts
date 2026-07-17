import type { Credential } from "@prisma/client";
import { prisma } from "./core";

export interface StoredCredential {
	id: string;
	publicKey: Uint8Array;
	counter: number;
	transports: string[];
}

export async function saveCredential(data: {
	id: string;
	accountId: string;
	publicKey: Uint8Array;
	counter: number;
	transports: string[];
	deviceType?: string;
	backedUp?: boolean;
	nickname?: string;
}): Promise<Credential> {
	return prisma.credential.create({
		data: {
			id: data.id,
			accountId: data.accountId,
			publicKey: Buffer.from(data.publicKey),
			counter: BigInt(data.counter),
			transports: data.transports,
			deviceType: data.deviceType,
			backedUp: data.backedUp ?? false,
			nickname: data.nickname,
		},
	});
}

export async function getCredentialsForAccount(
	accountId: string,
): Promise<StoredCredential[]> {
	const creds = await prisma.credential.findMany({ where: { accountId } });
	return creds.map(toStored);
}

export async function getCredentialById(
	id: string,
): Promise<(StoredCredential & { accountId: string }) | null> {
	const cred = await prisma.credential.findUnique({ where: { id } });
	if (!cred) return null;
	return { ...toStored(cred), accountId: cred.accountId };
}

export async function updateCredentialCounter(
	id: string,
	counter: number,
): Promise<void> {
	await prisma.credential.update({
		where: { id },
		data: { counter: BigInt(counter), lastUsedAt: new Date() },
	});
}

function toStored(cred: Credential): StoredCredential {
	return {
		id: cred.id,
		publicKey: new Uint8Array(cred.publicKey),
		counter: Number(cred.counter),
		transports: cred.transports,
	};
}
