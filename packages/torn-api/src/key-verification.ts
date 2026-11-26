import type { TornSchema } from "@sentinel/schemas";

import { TornApiClient } from "./client";
import { isValidApiKey } from "./crypto";

/** Access levels above this are not eligible for the Alliance key pool. */
const PUBLIC_KEY_LEVEL = 1;
const PUBLIC_KEY_TYPE = "Public Only";

export interface VerifiedPublicKeyResult {
	tornId: number;
	tornName: string;
	accessLevel: number;
	accessType: string;
}

/**
 * Error raised when a donated key is valid but carries more permissions than a
 * public key. The message is safe to show to the donor.
 */
export class PublicKeyRequiredError extends Error {
	constructor(accessLevel: number, accessType: string) {
		super(
			`This key has **${accessType}** permissions (level ${accessLevel}). Only **Public Only** keys are accepted — please create a new key with no extra selections on Torn.`,
		);
		this.name = "PublicKeyRequiredError";
	}
}

/**
 * Verifies a candidate key in two live calls:
 *  1. `/key` reports the key's access level/type — anything above public is rejected.
 *  2. `/user` resolves the owning Torn player for donor attribution.
 *
 * Both calls are made with the candidate key itself, never with a service key.
 */
export async function verifyPublicApiKey(
	apiKey: string,
): Promise<VerifiedPublicKeyResult> {
	const trimmedKey = apiKey.trim();
	if (!isValidApiKey(trimmedKey)) {
		throw new Error(
			"Torn API keys must be exactly 16 alphanumeric characters.",
		);
	}

	const client = new TornApiClient();

	const keyInfo: unknown = await client.get("/key", {
		apiKey: trimmedKey,
		queryParams: { selections: ["info"] },
	});

	if (!keyInfo || typeof keyInfo !== "object" || !("info" in keyInfo)) {
		throw new Error("Torn did not return key information for this API key.");
	}

	const access = (keyInfo as TornSchema<"KeyInfoResponse">).info?.access;
	const accessLevel = access?.level;
	const accessType = access?.type;

	if (
		typeof accessLevel !== "number" ||
		typeof accessType !== "string" ||
		accessLevel > PUBLIC_KEY_LEVEL ||
		accessType !== PUBLIC_KEY_TYPE
	) {
		throw new PublicKeyRequiredError(
			typeof accessLevel === "number" ? accessLevel : 0,
			typeof accessType === "string" ? accessType : "Unknown",
		);
	}

	const profile = await client.getRaw<{
		player_id?: number;
		name?: string;
	}>("user/", {
		apiKey: trimmedKey,
		queryParams: { selections: "profile" },
	});

	const tornId = profile?.player_id;
	if (!tornId) {
		throw new Error(
			"Unable to retrieve a valid Torn Player ID using this API key.",
		);
	}

	return {
		tornId,
		tornName: profile?.name ?? `Player ${tornId}`,
		accessLevel,
		accessType,
	};
}
