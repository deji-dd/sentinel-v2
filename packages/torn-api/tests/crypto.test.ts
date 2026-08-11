import { describe, expect, it } from "bun:test";
import {
	decryptApiKey,
	encryptApiKey,
	hashApiKey,
	isValidApiKey,
	isValidMasterKey,
} from "../src/crypto";

const MASTER_KEY = "12345678901234567890123456789012";
const VALID_KEY = "abcde12345ABCDE6";

describe("Crypto Utils", () => {
	it("encrypts and decrypts keys using standard 12-byte IV (88 hex chars)", () => {
		const encrypted = encryptApiKey(VALID_KEY, MASTER_KEY);
		expect(encrypted.length).toBe(88); // 24 (IV) + 32 (Tag) + 32 (Cipher)

		const decrypted = decryptApiKey(encrypted, MASTER_KEY);
		expect(decrypted).toBe(VALID_KEY);
	});


	it("returns original string if key is already unencrypted", () => {
		expect(decryptApiKey(VALID_KEY, MASTER_KEY)).toBe(VALID_KEY);
	});

	it("hashes API keys consistently", () => {
		const hash1 = hashApiKey(VALID_KEY, "pepper");
		const hash2 = hashApiKey(VALID_KEY, "pepper");
		expect(hash1).toBe(hash2);
		expect(hash1.length).toBe(64); // SHA-256 hex length
	});

	it("validates API keys and master keys correctly", () => {
		expect(isValidApiKey(VALID_KEY)).toBe(true);
		expect(isValidApiKey("invalid-key")).toBe(false);
		expect(isValidMasterKey(MASTER_KEY)).toBe(true);
		expect(isValidMasterKey("short")).toBe(false);
	});
});
