import { isValidApiKey, TornApiClient } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";

const logger = new Logger("Scheduler", "ElimsKeyVerifier");

export interface VerifiedKeyResult {
	tornId: number;
	tornName: string;
}

/**
 * Verifies a candidate Torn API key by making a live profile lookup to Torn API.
 * Validates the key format and ensures a valid player ID is returned.
 */
export async function verifyElimsKey(
	apiKey: string,
): Promise<VerifiedKeyResult> {
	const trimmedKey = apiKey.trim();

	if (!isValidApiKey(trimmedKey)) {
		throw new Error(
			"Torn API keys must be exactly 16 alphanumeric characters.",
		);
	}

	const client = new TornApiClient();

	const profile = await client.getRaw<{
		player_id?: number;
		name?: string;
	}>("user/", {
		apiKey: trimmedKey,
		queryParams: { selections: "profile" },
	});

	const tornId = profile?.player_id ?? null;
	const tornName = profile?.name ?? `Player ${tornId}`;

	if (!tornId) {
		throw new Error(
			"Unable to retrieve a valid Torn Player ID using this API key.",
		);
	}

	logger.info(`Successfully verified Torn API key for ${tornName} [${tornId}]`);

	return {
		tornId,
		tornName,
	};
}
