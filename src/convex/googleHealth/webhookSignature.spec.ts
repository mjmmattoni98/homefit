import { describe, expect, it } from 'vitest';
import { verifyGoogleHealthSignature } from './webhookSignature';

const TYPE_URL = 'type.googleapis.com/google.crypto.tink.EcdsaPublicKey';

function fromBase64Url(value: string): Uint8Array {
	const padding = '='.repeat((4 - (value.length % 4)) % 4);
	const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function encodeVarint(value: number): number[] {
	const bytes: number[] = [];
	let remaining = value;
	do {
		const next = remaining & 0x7f;
		remaining = Math.floor(remaining / 128);
		bytes.push(remaining === 0 ? next : next | 0x80);
	} while (remaining !== 0);
	return bytes;
}

function protobufBytesField(field: number, value: Uint8Array): number[] {
	return [...encodeVarint((field << 3) | 2), ...encodeVarint(value.byteLength), ...value];
}

function trimInteger(value: Uint8Array): Uint8Array {
	let first = 0;
	while (first < value.byteLength - 1 && value[first] === 0) first += 1;
	const trimmed = value.slice(first);
	if ((trimmed[0] & 0x80) === 0) return trimmed;
	return Uint8Array.from([0, ...trimmed]);
}

function p1363ToDer(signature: Uint8Array): Uint8Array {
	const r = trimInteger(signature.slice(0, 32));
	const s = trimInteger(signature.slice(32));
	return Uint8Array.from([
		0x30,
		2 + r.byteLength + 2 + s.byteLength,
		0x02,
		r.byteLength,
		...r,
		0x02,
		s.byteLength,
		...s
	]);
}

async function signatureFixture(keyId = 0x0102_0304) {
	const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	]);
	if (!('privateKey' in keys)) throw new Error('Expected an ECDSA key pair');
	const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
	if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
		throw new Error('Expected P-256 coordinates');
	}
	const x = fromBase64Url(jwk.x);
	const y = fromBase64Url(jwk.y);
	const publicKeyProto = Uint8Array.from([
		...protobufBytesField(3, Uint8Array.from([0, ...x])),
		...protobufBytesField(4, Uint8Array.from([0, ...y]))
	]);
	const keyset = {
		primaryKeyId: keyId,
		key: [
			{
				keyData: {
					typeUrl: TYPE_URL,
					value: toBase64(publicKeyProto),
					keyMaterialType: 'ASYMMETRIC_PUBLIC'
				},
				status: 'ENABLED',
				keyId,
				outputPrefixType: 'TINK'
			}
		]
	};

	async function sign(rawBody: string): Promise<string> {
		const p1363 = new Uint8Array(
			await crypto.subtle.sign(
				{ name: 'ECDSA', hash: 'SHA-256' },
				keys.privateKey,
				new TextEncoder().encode(rawBody)
			)
		);
		const der = p1363ToDer(p1363);
		const prefix = new Uint8Array(5);
		prefix[0] = 1;
		new DataView(prefix.buffer).setUint32(1, keyId, false);
		return toBase64(Uint8Array.from([...prefix, ...der]));
	}

	return { keyset, sign };
}

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
