import { join } from "node:path";
import { Logger } from "../packages/utils";

const logger = new Logger("FactionAlliancesRefresher");

const ALLIANCE_JSON_URL =
	"https://raw.githubusercontent.com/Marches0/torn-public/25b7cef36fd0949237b7ce2ee3fa53a9b7e5bc53/factions/alliances/factionAlliances.json";

const rootDir = process.cwd();
const outputPath = join(rootDir, "data", "faction-alliances.snapshot.json");

type AlliancePayload = {
	alliances: unknown[];
};

function assertValidPayload(
	payload: unknown,
): asserts payload is AlliancePayload {
	if (
		!payload ||
		typeof payload !== "object" ||
		!("alliances" in payload) ||
		!Array.isArray((payload as AlliancePayload).alliances)
	) {
		throw new Error("Invalid payload: expected top-level `alliances` array");
	}
}

async function main(): Promise<void> {
	const finish = logger.time();
	logger.info(`Fetching alliance snapshot.`);

	const response = await fetch(ALLIANCE_JSON_URL, {
		headers: { Accept: "application/json" },
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch JSON: HTTP ${response.status}`);
	}

	const payload: unknown = await response.json();
	assertValidPayload(payload);

	const pretty = `${JSON.stringify(payload, null, 2)}\n`;

	const bytesWritten = await Bun.write(outputPath, pretty);

	logger.info(`Snapshot successfully updated (${bytesWritten} bytes)`);
	finish();
}

main().catch((error) => {
	const msg = error instanceof Error ? error.message : String(error);
	logger.error(`Failed to refresh alliance snapshot: ${msg}`);
	process.exit(1);
});
