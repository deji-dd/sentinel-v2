import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits (NIST standard)
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Memoised master-key derivation. `decryptApiKey` is called once per key per key
 * pool resolution, and pool resolutions happen in hot polling loops, so the
 * SHA-256 is cached rather than recomputed on every call. Bounded to a handful
 * of entries because the master key is effectively a process-wide constant.
 */
const derivedKeyCache = new Map<string, Buffer>();
const MAX_DERIVED_KEY_ENTRIES = 4;

function deriveKeyFromMaster(masterKey: string): Buffer {
	const cached = derivedKeyCache.get(masterKey);
	if (cached) return cached;

	const derived = createHash("sha256").update(masterKey).digest();
	if (derivedKeyCache.size >= MAX_DERIVED_KEY_ENTRIES) {
		const oldest = derivedKeyCache.keys().next().value;
		if (oldest !== undefined) derivedKeyCache.delete(oldest);
	}
	derivedKeyCache.set(masterKey, derived);
	return derived;
}

export function encryptApiKey(apiKey: string, masterKey: string): string {
	const derivedKey = deriveKeyFromMaster(masterKey);
	const iv = randomBytes(IV_LENGTH);

	const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
	let encrypted = cipher.update(apiKey, "utf8", "hex");
	encrypted += cipher.final("hex");

	const authTag = cipher.getAuthTag();

	return iv.toString("hex") + authTag.toString("hex") + encrypted;
}

export function decryptApiKey(encrypted: string, masterKey: string): string {
	if (!encrypted || isValidApiKey(encrypted) || !masterKey) {
		return encrypted;
	}

	const minExpectedLength = (IV_LENGTH + AUTH_TAG_LENGTH + 16) * 2;

	if (encrypted.length < minExpectedLength) {
		return encrypted;
	}

	try {
		const derivedKey = deriveKeyFromMaster(masterKey);

		const ivHex = encrypted.slice(0, IV_LENGTH * 2);
		const tagHex = encrypted.slice(
			IV_LENGTH * 2,
			IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2,
		);
		const ciphertextHex = encrypted.slice(IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2);

		const iv = Buffer.from(ivHex, "hex");
		const authTag = Buffer.from(tagHex, "hex");
		const ciphertext = Buffer.from(ciphertextHex, "hex");

		const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
		decipher.setAuthTag(authTag);

		let decrypted = decipher.update(ciphertext, undefined, "utf8");
		decrypted += decipher.final("utf8");

		return decrypted;
	} catch {
		return encrypted;
	}
}

export function hashApiKey(apiKey: string, pepper: string): string {
	return createHash("sha256")
		.update(apiKey + pepper)
		.digest("hex");
}

export function isValidApiKey(key: string): boolean {
	return Boolean(key && /^[a-zA-Z0-9]{16}$/.test(key));
}

export function isValidMasterKey(key: string): boolean {
	return Boolean(key && key.length >= 32);
}
