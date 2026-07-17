import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { readSetting } from "../setting";
import {
	getCredentialById,
	getCredentialsForAccount,
	saveCredential,
	updateCredentialCounter,
} from "../db/credential";
import { prisma } from "../db/core";
import { createWebAccount } from "../db/account";

const setting = readSetting();

/**
 * Copies bytes into a fresh ArrayBuffer-backed Uint8Array. SimpleWebAuthn's
 * types require `Uint8Array<ArrayBuffer>`, which excludes the SharedArrayBuffer
 * possibility that `TextEncoder`/DB buffers carry.
 */
function toBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(input.byteLength);
	out.set(input);
	return out;
}

/**
 * Relying Party settings. The RP ID must be the registrable domain the
 * dashboard is served from (no scheme, no port); the origin is the full URL
 * the browser reports. Configure via WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN, falling
 * back to the site in setting.json for production.
 */
function rpConfig() {
	const rpID =
		process.env.WEBAUTHN_RP_ID ?? setting.WEBSITE ?? "localhost";
	const origin =
		process.env.WEBAUTHN_ORIGIN ??
		(setting.WEBSITE
			? `${setting.HTTPS ? "https" : "http"}://${setting.WEBSITE}`
			: "http://localhost:3000");
	return { rpID, rpName: "Amhra", origin };
}

const CHALLENGE_TTL_MS = 1000 * 60 * 5;

async function storeChallenge(
	challenge: string,
	kind: "registration" | "authentication",
	accountId?: string,
): Promise<string> {
	const row = await prisma.webAuthnChallenge.create({
		data: {
			challenge,
			kind,
			accountId,
			expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
		},
	});
	return row.id;
}

async function consumeChallenge(
	id: string,
	kind: "registration" | "authentication",
): Promise<{ challenge: string; accountId: string | null } | null> {
	const row = await prisma.webAuthnChallenge.findUnique({ where: { id } });
	if (!row) return null;
	// One-time use: always delete, whether or not it is still valid.
	await prisma.webAuthnChallenge.delete({ where: { id } }).catch(() => {});
	if (row.kind !== kind || row.expiresAt.getTime() < Date.now()) return null;
	return { challenge: row.challenge, accountId: row.accountId };
}

/**
 * Begins passkey registration for a brand-new web account. A pending account is
 * created up front so the credential has an owner; it is cleaned up by the
 * caller if the ceremony is abandoned (challenges expire in 5 minutes).
 */
export async function beginRegistration(displayName?: string) {
	const { rpID, rpName } = rpConfig();
	const account = await createWebAccount(displayName);
	const options = await generateRegistrationOptions({
		rpName,
		rpID,
		userName: displayName ?? `amhra-${account.id.slice(0, 8)}`,
		userID: toBytes(new TextEncoder().encode(account.id)),
		attestationType: "none",
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "preferred",
		},
	});
	const challengeId = await storeChallenge(
		options.challenge,
		"registration",
		account.id,
	);
	return { options, challengeId, accountId: account.id };
}

export async function finishRegistration(
	challengeId: string,
	response: RegistrationResponseJSON,
): Promise<{ accountId: string } | null> {
	const stored = await consumeChallenge(challengeId, "registration");
	if (!stored || !stored.accountId) return null;
	const { rpID, origin } = rpConfig();

	const verification = await verifyRegistrationResponse({
		response,
		expectedChallenge: stored.challenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		requireUserVerification: false,
	}).catch(() => null);

	if (!verification?.verified || !verification.registrationInfo) {
		// Abandon the pending account so failed ceremonies do not accumulate.
		await prisma.account
			.delete({ where: { id: stored.accountId } })
			.catch(() => {});
		return null;
	}

	const { credential, credentialDeviceType, credentialBackedUp } =
		verification.registrationInfo;
	await saveCredential({
		id: credential.id,
		accountId: stored.accountId,
		publicKey: credential.publicKey,
		counter: credential.counter,
		transports: credential.transports ?? [],
		deviceType: credentialDeviceType,
		backedUp: credentialBackedUp,
	});
	return { accountId: stored.accountId };
}

/** Adds an additional passkey to an already-authenticated web account. */
export async function beginAddCredential(accountId: string) {
	const { rpID, rpName } = rpConfig();
	const existing = await getCredentialsForAccount(accountId);
	const options = await generateRegistrationOptions({
		rpName,
		rpID,
		userName: `amhra-${accountId.slice(0, 8)}`,
		userID: toBytes(new TextEncoder().encode(accountId)),
		attestationType: "none",
		excludeCredentials: existing.map(c => ({ id: c.id })),
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "preferred",
		},
	});
	const challengeId = await storeChallenge(
		options.challenge,
		"registration",
		accountId,
	);
	return { options, challengeId };
}

export async function beginAuthentication() {
	const { rpID } = rpConfig();
	const options = await generateAuthenticationOptions({
		rpID,
		userVerification: "preferred",
	});
	const challengeId = await storeChallenge(options.challenge, "authentication");
	return { options, challengeId };
}

/**
 * Verifies an authentication assertion (usernameless — the credential ID
 * identifies the account) and returns the authenticated account ID.
 */
export async function finishAuthentication(
	challengeId: string,
	response: AuthenticationResponseJSON,
): Promise<{ accountId: string } | null> {
	const stored = await consumeChallenge(challengeId, "authentication");
	if (!stored) return null;
	const credential = await getCredentialById(response.id);
	if (!credential) return null;
	const { rpID, origin } = rpConfig();

	const verification = await verifyAuthenticationResponse({
		response,
		expectedChallenge: stored.challenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		requireUserVerification: false,
		credential: {
			id: credential.id,
			publicKey: toBytes(credential.publicKey),
			counter: credential.counter,
			transports: credential.transports as never,
		},
	}).catch(() => null);

	if (!verification?.verified) return null;
	await updateCredentialCounter(
		credential.id,
		verification.authenticationInfo.newCounter,
	);
	return { accountId: credential.accountId };
}
