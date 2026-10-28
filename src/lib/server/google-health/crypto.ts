const AES_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export interface EncryptedTokenEnvelope {
	encryptedRefreshToken: string;
	tokenNonce: string;
	tokenTag: string;
	tokenKeyVersion: string;
}

export interface TokenKeyring {
	readonly activeKey: string;
	readonly activeVersion: string;
	readonly previousKeys: Readonly<Record<string, string>>;
}

export interface DecryptedRefreshToken {
	refreshToken: string;
	needsReencryption: boolean;
}

export interface RotatedRefreshTokenEnvelope {
	refreshToken: string;
	envelope: EncryptedTokenEnvelope;
	reencrypted: boolean;
}

function bytesToBinary(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return binary;
}

function binaryToBytes(binary: string): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
	return btoa(bytesToBinary(bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new Error('Invalid token envelope encoding');
	}

	const standard = value.replaceAll('-', '+').replaceAll('_', '/');
	const paddingLength = (4 - (standard.length % 4)) % 4;
	if (paddingLength === 3) {
		throw new Error('Invalid token envelope encoding');
	}

	try {
		const decoded = binaryToBytes(atob(`${standard}${'='.repeat(paddingLength)}`));
		if (encodeBase64Url(decoded) !== value) {
			throw new Error('Invalid token envelope encoding');
		}
		return decoded;
	} catch {
		throw new Error('Invalid token envelope encoding');
	}
}

function decodeEncryptionKey(encodedKey: string): Uint8Array<ArrayBuffer> {
	if (
		encodedKey.length === 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedKey)
	) {
		throw new Error('Token encryption keys must be valid base64');
	}

	let decoded: Uint8Array<ArrayBuffer>;
	try {
		decoded = binaryToBytes(atob(encodedKey));
	} catch {
		throw new Error('Token encryption keys must be valid base64');
	}

	if (decoded.byteLength !== AES_KEY_BYTES) {
		throw new Error('Token encryption keys must decode to exactly 32 bytes');
	}
	if (btoa(bytesToBinary(decoded)) !== encodedKey) {
		throw new Error('Token encryption keys must be canonical base64');
	}

	return decoded;
}

function assertKeyVersion(version: string): void {
	if (version.length === 0 || version.length > 80 || !/^[A-Za-z0-9._-]+$/.test(version)) {
		throw new Error('Token key versions must be non-empty safe identifiers');
	}
}

export function parsePreviousTokenKeys(value?: string): Readonly<Record<string, string>> {
	if (value === undefined || value.trim() === '') {
		return Object.freeze({});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('Previous token keys must be valid JSON');
	}

	if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
		throw new Error('Previous token keys must be a JSON object');
	}

	const previousKeys: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const [version, encodedKey] of Object.entries(parsed)) {
		assertKeyVersion(version);
		if (typeof encodedKey !== 'string') {
			throw new Error('Previous token key values must be base64 strings');
		}
		decodeEncryptionKey(encodedKey);
		previousKeys[version] = encodedKey;
	}

	return Object.freeze(previousKeys);
}

export function createTokenKeyring(
	activeKey: string,
	activeVersion: string,
	previousKeysJson?: string
): TokenKeyring {
	assertKeyVersion(activeVersion);
	decodeEncryptionKey(activeKey);
	const previousKeys = parsePreviousTokenKeys(previousKeysJson);
	if (Object.hasOwn(previousKeys, activeVersion)) {
		throw new Error('Previous token keys must not redefine the active version');
	}

	return Object.freeze({ activeKey, activeVersion, previousKeys });
}

function validateKeyring(keyring: TokenKeyring): void {
	assertKeyVersion(keyring.activeVersion);
	decodeEncryptionKey(keyring.activeKey);
	if (Object.hasOwn(keyring.previousKeys, keyring.activeVersion)) {
		throw new Error('Previous token keys must not redefine the active version');
	}
	for (const [version, encodedKey] of Object.entries(keyring.previousKeys)) {
		assertKeyVersion(version);
		decodeEncryptionKey(encodedKey);
	}
}

function selectEnvelopeKey(envelope: EncryptedTokenEnvelope, keyring: TokenKeyring): string {
	validateKeyring(keyring);
	if (envelope.tokenKeyVersion === keyring.activeVersion) {
		return keyring.activeKey;
	}

	if (!Object.hasOwn(keyring.previousKeys, envelope.tokenKeyVersion)) {
		throw new Error('Unknown token key version');
	}
	const previousKey = keyring.previousKeys[envelope.tokenKeyVersion];
	return previousKey;
}

async function importAesKey(encodedKey: string, usage: KeyUsage): Promise<CryptoKey> {
	return await crypto.subtle.importKey('raw', decodeEncryptionKey(encodedKey), 'AES-GCM', false, [
		usage
	]);
}

function tokenAdditionalData(userId: string, keyVersion: string): Uint8Array<ArrayBuffer> {
	if (userId.length === 0) {
		throw new Error('Token owner must be provided');
	}
	return new TextEncoder().encode(`${userId}:${keyVersion}`);
}

export async function encryptRefreshToken(
	refreshToken: string,
	userId: string,
	encodedKey: string,
	keyVersion: string
): Promise<EncryptedTokenEnvelope> {
	if (refreshToken.length === 0) {
		throw new Error('Refresh token must be provided');
	}
	assertKeyVersion(keyVersion);

	const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
	const key = await importAesKey(encodedKey, 'encrypt');
	const encryptedWithTag = new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: 'AES-GCM',
				iv: nonce,
				additionalData: tokenAdditionalData(userId, keyVersion),
				tagLength: AES_GCM_TAG_BYTES * 8
			},
			key,
			new TextEncoder().encode(refreshToken)
		)
	);
	const tagOffset = encryptedWithTag.byteLength - AES_GCM_TAG_BYTES;

	return {
		encryptedRefreshToken: encodeBase64Url(encryptedWithTag.slice(0, tagOffset)),
		tokenNonce: encodeBase64Url(nonce),
		tokenTag: encodeBase64Url(encryptedWithTag.slice(tagOffset)),
		tokenKeyVersion: keyVersion
	};
}

export async function decryptRefreshToken(
	envelope: EncryptedTokenEnvelope,
	userId: string,
	keyring: TokenKeyring
): Promise<DecryptedRefreshToken> {
	assertKeyVersion(envelope.tokenKeyVersion);
	const encodedKey = selectEnvelopeKey(envelope, keyring);

	try {
		const nonce = decodeBase64Url(envelope.tokenNonce);
		const ciphertext = decodeBase64Url(envelope.encryptedRefreshToken);
		const tag = decodeBase64Url(envelope.tokenTag);
		if (nonce.byteLength !== AES_GCM_NONCE_BYTES || tag.byteLength !== AES_GCM_TAG_BYTES) {
			throw new Error('Invalid token envelope dimensions');
		}

		const encryptedWithTag = new Uint8Array(ciphertext.byteLength + tag.byteLength);
		encryptedWithTag.set(ciphertext);
		encryptedWithTag.set(tag, ciphertext.byteLength);
		const key = await importAesKey(encodedKey, 'decrypt');
		const plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: nonce,
				additionalData: tokenAdditionalData(userId, envelope.tokenKeyVersion),
				tagLength: AES_GCM_TAG_BYTES * 8
			},
			key,
			encryptedWithTag
		);

		return {
			refreshToken: new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
			needsReencryption: envelope.tokenKeyVersion !== keyring.activeVersion
		};
	} catch {
		throw new Error('Unable to decrypt refresh token');
	}
}

export async function rotateRefreshTokenEnvelope(
	envelope: EncryptedTokenEnvelope,
	userId: string,
	keyring: TokenKeyring
): Promise<RotatedRefreshTokenEnvelope> {
	const decrypted = await decryptRefreshToken(envelope, userId, keyring);
	if (!decrypted.needsReencryption) {
		return {
			refreshToken: decrypted.refreshToken,
			envelope,
			reencrypted: false
		};
	}

	return {
		refreshToken: decrypted.refreshToken,
		envelope: await encryptRefreshToken(
			decrypted.refreshToken,
			userId,
			keyring.activeKey,
			keyring.activeVersion
		),
		reencrypted: true
	};
}
