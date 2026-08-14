import { describe, expect, it } from 'vitest';
import {
	createTokenKeyring,
	decryptRefreshToken,
	encryptRefreshToken,
	parsePreviousTokenKeys,
	rotateRefreshTokenEnvelope
} from './crypto';

const ACTIVE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const PREVIOUS_KEY = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';

describe('Google Health refresh-token encryption', () => {
	it('round-trips with AES-256-GCM and uses a fresh nonce for every envelope', async () => {
		const keyring = createTokenKeyring(ACTIVE_KEY, 'v2');
		const first = await encryptRefreshToken('refresh-token', 'clerk|user-a', ACTIVE_KEY, 'v2');
		const second = await encryptRefreshToken('refresh-token', 'clerk|user-a', ACTIVE_KEY, 'v2');

		expect(first).not.toEqual(second);
		expect(first.tokenNonce).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(first.tokenTag).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(first.tokenNonce).toHaveLength(16);
		expect(first.tokenTag).toHaveLength(22);
		expect(first.tokenKeyVersion).toBe('v2');
		expect(await decryptRefreshToken(first, 'clerk|user-a', keyring)).toEqual({
			refreshToken: 'refresh-token',
			needsReencryption: false
		});
	});

	it('binds the token envelope to the owning user and rejects tampering', async () => {
		const keyring = createTokenKeyring(ACTIVE_KEY, 'v2');
		const encrypted = await encryptRefreshToken('refresh-token', 'clerk|user-a', ACTIVE_KEY, 'v2');
		const replacement = encrypted.encryptedRefreshToken.startsWith('A') ? 'B' : 'A';
		const tampered = {
			...encrypted,
			encryptedRefreshToken: `${replacement}${encrypted.encryptedRefreshToken.slice(1)}`
		};

		await expect(decryptRefreshToken(encrypted, 'clerk|user-b', keyring)).rejects.toThrow(
			'Unable to decrypt refresh token'
		);
		await expect(decryptRefreshToken(tampered, 'clerk|user-a', keyring)).rejects.toThrow(
			'Unable to decrypt refresh token'
		);
	});

	it('decrypts previous versions and returns an active-key replacement envelope', async () => {
		const oldEnvelope = await encryptRefreshToken(
			'refresh-token',
			'clerk|user-a',
			PREVIOUS_KEY,
			'v1'
		);
		const keyring = createTokenKeyring(ACTIVE_KEY, 'v2', JSON.stringify({ v1: PREVIOUS_KEY }));

		expect(await decryptRefreshToken(oldEnvelope, 'clerk|user-a', keyring)).toEqual({
			refreshToken: 'refresh-token',
			needsReencryption: true
		});

		const rotated = await rotateRefreshTokenEnvelope(oldEnvelope, 'clerk|user-a', keyring);

		expect(rotated.reencrypted).toBe(true);
		expect(rotated.envelope.tokenKeyVersion).toBe('v2');
		expect(rotated.envelope).not.toEqual(oldEnvelope);
		expect(await decryptRefreshToken(rotated.envelope, 'clerk|user-a', keyring)).toEqual({
			refreshToken: 'refresh-token',
			needsReencryption: false
		});
	});

	it('rejects unknown versions and every malformed key in the configured keyring', async () => {
		const unknownEnvelope = await encryptRefreshToken(
			'refresh-token',
			'clerk|user-a',
			PREVIOUS_KEY,
			'unknown'
		);

		await expect(
			decryptRefreshToken(unknownEnvelope, 'clerk|user-a', createTokenKeyring(ACTIVE_KEY, 'v2'))
		).rejects.toThrow('Unknown token key version');
		expect(() => createTokenKeyring('c2hvcnQ=', 'v2')).toThrow(
			'Token encryption keys must decode to exactly 32 bytes'
		);
		expect(() =>
			parsePreviousTokenKeys(JSON.stringify({ v1: PREVIOUS_KEY, broken: 'c2hvcnQ=' }))
		).toThrow('Token encryption keys must decode to exactly 32 bytes');
		expect(() => parsePreviousTokenKeys('[]')).toThrow('Previous token keys must be a JSON object');
	});
});
