import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits (NIST standard)
const AUTH_TAG_LENGTH = 16; // 128 bits

function deriveKeyFromMaster(masterKey: string): Buffer {
	return createHash("sha256").update(masterKey).digest();
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
