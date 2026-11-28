/**
 * Manual probe for the YABA collector. Uses TORN_API_KEY from the environment
 * (never a pooled key) to verify the public personalstats payload shape and
 * historical `stat`+`timestamp` access before wiring new metrics.
 *
 *   bun run scripts/yaba-probe.ts [optional Torn player id]
 */
import { TornApiClient } from "@sentinel/torn-api";

const apiKey = process.env.TORN_API_KEY?.trim();
if (!apiKey) {
	throw new Error(
		"Set TORN_API_KEY in the environment before running this probe.",
	);
}

const client = new TornApiClient();
const requestedId = process.argv[2] ? Number(process.argv[2]) : null;

const profile = await client.getRaw<{ player_id?: number; name?: string }>(
	"user/",
	{
		apiKey,
		queryParams: { selections: "profile" },
	},
);
const tornId = requestedId ?? profile.player_id;
if (!tornId || !Number.isInteger(tornId)) {
	throw new Error("Could not resolve a Torn player id.");
}

const popular = await client.get("/user/{id}/personalstats", {
	apiKey,
	pathParams: { id: tornId },
	queryParams: { cat: "popular" },
});
const root = popular as { personalstats?: Record<string, unknown> };
const personalstats = root.personalstats ?? {};
console.log(`Player ${tornId}`);
console.log("drugs.xanax:", personalstats.drugs);
console.log("other.activity:", personalstats.other);
console.log("attacking.faction:", personalstats.attacking);

const historical = await client.get("/user/{id}/personalstats", {
	apiKey,
	pathParams: { id: tornId },
	queryParams: {
		stat: [
			"xantaken",
			"timeplayed",
			"rankedwarhits",
			"revives",
			"reviveskill",
			"attackswon",
			"attackslost",
			"attackhits",
			"attackcriticalhits",
			"attackdamage",
		],
		timestamp: Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000),
	},
});
console.log("historical:", historical);
