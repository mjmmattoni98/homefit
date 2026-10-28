import { describe, expect, it } from 'vitest';
import { protobufBytesField, signatureFixture, toBase64 } from '../testing/webhook-signing';
import { verifyGoogleHealthSignature } from './webhook-signature';

describe('Google Health Tink webhook signature verification', () => {
	it('accepts an enabled matching Tink P-256 key and exact raw body', async () => {
		const fixture = await signatureFixture();
		const rawBody = '{"data":{"version":"1","subscription":"café"}}';

		expect(
			await verifyGoogleHealthSignature(rawBody, await fixture.sign(rawBody), fixture.keyset)
		).toBe(true);
	});

	it('rejects changed bodies, wrong key ids, malformed prefixes, disabled keys, and missing headers', async () => {
		const fixture = await signatureFixture();
		const rawBody = '{"data":{"version":"1"}}';
		const signature = await fixture.sign(rawBody);
		const wrongKeyIdFixture = await signatureFixture(0x0506_0708);
		const disabledKeyset = structuredClone(fixture.keyset);
		disabledKeyset.key[0].status = 'DISABLED';
		const malformedPrefix = Uint8Array.from(atob(signature), (character) =>
			character.charCodeAt(0)
		);
		malformedPrefix[0] = 0;

		expect(await verifyGoogleHealthSignature(`${rawBody} `, signature, fixture.keyset)).toBe(false);
		expect(await verifyGoogleHealthSignature(rawBody, signature, wrongKeyIdFixture.keyset)).toBe(
			false
		);
		expect(
			await verifyGoogleHealthSignature(rawBody, toBase64(malformedPrefix), fixture.keyset)
		).toBe(false);
		expect(await verifyGoogleHealthSignature(rawBody, signature, disabledKeyset)).toBe(false);
		expect(await verifyGoogleHealthSignature(rawBody, null, fixture.keyset)).toBe(false);
	});

	it('rejects malformed and non-canonical public coordinates', async () => {
		const fixture = await signatureFixture();
		const rawBody = '{}';
		const signature = await fixture.sign(rawBody);
		const malformed = structuredClone(fixture.keyset);
		malformed.key[0].keyData.value = toBase64(
			Uint8Array.from([
				...protobufBytesField(3, new Uint8Array(34)),
				...protobufBytesField(4, new Uint8Array(32))
			])
		);

		expect(await verifyGoogleHealthSignature(rawBody, signature, malformed)).toBe(false);
	});
});
