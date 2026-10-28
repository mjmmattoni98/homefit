const TINK_PREFIX_LENGTH = 5;
const TINK_PREFIX = 0x01;
const ECDSA_PUBLIC_KEY_TYPE_URL = 'type.googleapis.com/google.crypto.tink.EcdsaPublicKey';
const MAX_SIGNATURE_BYTES = 512;
const MAX_KEYSET_KEYS = 64;
const MAX_PUBLIC_KEY_PROTO_BYTES = 16 * 1024;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64(value: string, maximumBytes: number): Uint8Array | null {
	if (
		value.length === 0 ||
		value.length > Math.ceil((maximumBytes * 4) / 3) + 4 ||
		value.length % 4 === 1 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		return null;
	}
	try {
		const binary = atob(value);
		if (binary.length > maximumBytes) return null;
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

function encodeBase64Url(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
	let value = 0;
	let multiplier = 1;
	for (let index = start; index < bytes.byteLength && index < start + 10; index += 1) {
		const byte = bytes[index];
		value += (byte & 0x7f) * multiplier;
		if (!Number.isSafeInteger(value)) return null;
		if ((byte & 0x80) === 0) return { value, next: index + 1 };
		multiplier *= 128;
	}
	return null;
}

function skipProtobufField(bytes: Uint8Array, wireType: number, start: number): number | null {
	if (wireType === 0) return readVarint(bytes, start)?.next ?? null;
	if (wireType === 1) return start + 8 <= bytes.byteLength ? start + 8 : null;
	if (wireType === 5) return start + 4 <= bytes.byteLength ? start + 4 : null;
	if (wireType !== 2) return null;
	const length = readVarint(bytes, start);
	if (length === null || length.value > bytes.byteLength - length.next) return null;
	return length.next + length.value;
}

function normalizeCoordinate(value: Uint8Array): Uint8Array | null {
	if (value.byteLength === 32) return value;
	if (value.byteLength !== 33 || value[0] !== 0) return null;
	return value.slice(1);
}

function parsePublicKeyCoordinates(bytes: Uint8Array): { x: Uint8Array; y: Uint8Array } | null {
	let offset = 0;
	let x: Uint8Array | null = null;
	let y: Uint8Array | null = null;
	while (offset < bytes.byteLength) {
		const tag = readVarint(bytes, offset);
		if (tag === null || tag.value === 0) return null;
		offset = tag.next;
		const field = Math.floor(tag.value / 8);
		const wireType = tag.value & 7;
		if ((field === 3 || field === 4) && wireType === 2) {
			const length = readVarint(bytes, offset);
			if (length === null || length.value > bytes.byteLength - length.next) return null;
			const coordinate = normalizeCoordinate(bytes.slice(length.next, length.next + length.value));
			if (coordinate === null) return null;
			if (field === 3) {
				if (x !== null) return null;
				x = coordinate;
			} else {
				if (y !== null) return null;
				y = coordinate;
			}
			offset = length.next + length.value;
			continue;
		}
		const next = skipProtobufField(bytes, wireType, offset);
		if (next === null) return null;
		offset = next;
	}
	return x === null || y === null ? null : { x, y };
}

function matchingPublicKey(
	keyset: unknown,
	keyId: number
): { x: Uint8Array; y: Uint8Array } | null {
	if (!isPlainObject(keyset) || !Array.isArray(keyset.key) || keyset.key.length > MAX_KEYSET_KEYS) {
		return null;
	}
	for (const key of keyset.key) {
		if (
			!isPlainObject(key) ||
			key.keyId !== keyId ||
			key.status !== 'ENABLED' ||
			key.outputPrefixType !== 'TINK' ||
			!isPlainObject(key.keyData) ||
			key.keyData.typeUrl !== ECDSA_PUBLIC_KEY_TYPE_URL ||
			key.keyData.keyMaterialType !== 'ASYMMETRIC_PUBLIC' ||
			typeof key.keyData.value !== 'string'
		) {
			continue;
		}
		const publicKey = decodeBase64(key.keyData.value, MAX_PUBLIC_KEY_PROTO_BYTES);
		if (publicKey === null) return null;
		return parsePublicKeyCoordinates(publicKey);
	}
	return null;
}

function readDerInteger(
	bytes: Uint8Array,
	start: number
): { value: Uint8Array; next: number } | null {
	if (bytes[start] !== 0x02 || start + 2 > bytes.byteLength) return null;
	const length = bytes[start + 1];
	const valueStart = start + 2;
	const valueEnd = valueStart + length;
	if (length === 0 || length > 33 || valueEnd > bytes.byteLength) return null;
	const encoded = bytes.slice(valueStart, valueEnd);
	if ((encoded[0] & 0x80) !== 0) return null;
	if (encoded.byteLength > 1 && encoded[0] === 0 && (encoded[1] & 0x80) === 0) return null;
	const unsigned = encoded[0] === 0 ? encoded.slice(1) : encoded;
	if (unsigned.byteLength > 32 || unsigned.every((byte) => byte === 0)) return null;
	const value = new Uint8Array(32);
	value.set(unsigned, 32 - unsigned.byteLength);
	return { value, next: valueEnd };
}

function derToP1363(bytes: Uint8Array): Uint8Array | null {
	if (bytes.byteLength < 8 || bytes.byteLength > 72 || bytes[0] !== 0x30) return null;
	const length = bytes[1];
	if ((length & 0x80) !== 0 || length !== bytes.byteLength - 2) return null;
	const r = readDerInteger(bytes, 2);
	if (r === null) return null;
	const s = readDerInteger(bytes, r.next);
	if (s === null || s.next !== bytes.byteLength) return null;
	const signature = new Uint8Array(64);
	signature.set(r.value, 0);
	signature.set(s.value, 32);
	return signature;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

export async function verifyGoogleHealthSignature(
	rawBody: string,
	signatureHeader: string | null,
	keyset: unknown
): Promise<boolean> {
	try {
		if (signatureHeader === null) return false;
		const signature = decodeBase64(signatureHeader, MAX_SIGNATURE_BYTES);
		if (
			signature === null ||
			signature.byteLength <= TINK_PREFIX_LENGTH ||
			signature[0] !== TINK_PREFIX
		) {
			return false;
		}
		const keyId = new DataView(
			signature.buffer,
			signature.byteOffset,
			TINK_PREFIX_LENGTH
		).getUint32(1, false);
		const coordinates = matchingPublicKey(keyset, keyId);
		const p1363 = derToP1363(signature.slice(TINK_PREFIX_LENGTH));
		if (coordinates === null || p1363 === null) return false;
		const jwk: JsonWebKey = {
			kty: 'EC',
			crv: 'P-256',
			x: encodeBase64Url(coordinates.x),
			y: encodeBase64Url(coordinates.y),
			ext: true,
			key_ops: ['verify']
		};
		const publicKey = await crypto.subtle.importKey(
			'jwk',
			jwk,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify']
		);
		return await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			publicKey,
			ownedArrayBuffer(p1363),
			ownedArrayBuffer(new TextEncoder().encode(rawBody))
		);
	} catch {
		return false;
	}
}
