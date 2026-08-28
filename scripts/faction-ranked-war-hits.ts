import { join } from "node:path";
import { TornApiClient } from "../packages/torn-api";
import { Logger } from "../packages/utils";

const logger = new Logger("FactionRWHitsReporter");

interface FactionMemberResult {
	rank: number;
	id: number;
	name: string;
	level: number;
	daysInFaction: number;
	position: string;
	rankedWarHits: number;
	raidHits: number;
	attacksWon: number;
	defendsWon: number;
	totalDamage: number;
	lastAction: string;
}

function escapeCsvField(value: string | number | undefined | null): string {
	if (value === undefined || value === null) {
		return "";
	}
	const stringValue = String(value);
	if (
		stringValue.includes(",") ||
		stringValue.includes('"') ||
		stringValue.includes("\n") ||
		stringValue.includes("\r")
	) {
		return `"${stringValue.replaceAll('"', '""')}"`;
	}
	return stringValue;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const finish = logger.time();

	const factionIdArg = process.argv[2];
	const factionId = factionIdArg ? Number.parseInt(factionIdArg, 10) : 2013;

	if (Number.isNaN(factionId) || factionId <= 0) {
		throw new Error(
			`Invalid faction ID provided: ${factionIdArg ?? "undefined"}`,
		);
	}

	const apiKey =
		process.env.TORN_API_KEY ||
		process.env.VITE_TORN_API_KEY ||
		"";

	if (!apiKey) {
		throw new Error(
			"No Torn API key found. Please set TORN_API_KEY in your environment or .env file.",
		);
	}

	const client = new TornApiClient();

	logger.info(`Fetching member roster for faction ID ${factionId}...`);
	const factionResponse = await client.get("/faction/{id}/members", {
		apiKey,
		pathParams: { id: factionId },
	});

	const members = factionResponse.members;
	if (!members || members.length === 0) {
		logger.warn(`No members found for faction ${factionId}.`);
		return;
	}

	logger.info(
		`Found ${members.length} members. Querying ranked war hit stats...`,
	);

	const memberResults: Omit<FactionMemberResult, "rank">[] = [];

	for (let i = 0; i < members.length; i++) {
		const member = members[i];
		if (!member) continue;

		const progress = `[${i + 1}/${members.length}]`;

		try {
			// Polite delay between calls to respect rate limits
			if (i > 0) {
				await sleep(650);
			}

			const statsRes = await client.get("/user/{id}/personalstats", {
				apiKey,
				pathParams: { id: member.id },
				queryParams: { cat: "attacking" },
			});

			const attackingStats = (
				statsRes as {
					personalstats?: {
						attacking?: {
							faction?: {
								ranked_war_hits?: number;
								raid_hits?: number;
							};
							attacks?: {
								won?: number;
							};
							defends?: {
								won?: number;
							};
							damage?: {
								total?: number;
							};
						};
					};
				}
			)?.personalstats?.attacking;

			const rankedWarHits = attackingStats?.faction?.ranked_war_hits ?? 0;
			const raidHits = attackingStats?.faction?.raid_hits ?? 0;
			const attacksWon = attackingStats?.attacks?.won ?? 0;
			const defendsWon = attackingStats?.defends?.won ?? 0;
			const totalDamage = attackingStats?.damage?.total ?? 0;

			memberResults.push({
				id: member.id,
				name: member.name,
				level: member.level,
				daysInFaction: member.days_in_faction,
				position: member.position,
				rankedWarHits,
				raidHits,
				attacksWon,
				defendsWon,
				totalDamage,
				lastAction: `${member.last_action.status} (${member.last_action.relative})`,
			});

			logger.info(
				`${progress} ${member.name} [${member.id}] ➔ ${rankedWarHits.toLocaleString()} RW hits`,
			);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.warn(
				`${progress} Failed to fetch personal stats for ${member.name} [${member.id}]: ${errorMsg}`,
			);

			// Fallback with 0 hits so member is still in report
			memberResults.push({
				id: member.id,
				name: member.name,
				level: member.level,
				daysInFaction: member.days_in_faction,
				position: member.position,
				rankedWarHits: 0,
				raidHits: 0,
				attacksWon: 0,
				defendsWon: 0,
				totalDamage: 0,
				lastAction: `${member.last_action.status} (${member.last_action.relative})`,
			});
		}
	}

	// Sort members by Ranked War Hits descending, tie-break by Attacks Won
	memberResults.sort((a, b) => {
		if (b.rankedWarHits !== a.rankedWarHits) {
			return b.rankedWarHits - a.rankedWarHits;
		}
		return b.attacksWon - a.attacksWon;
	});

	const rankedList: FactionMemberResult[] = memberResults.map((m, index) => ({
		rank: index + 1,
		...m,
	}));

	// Build CSV content
	const headers = [
		"Rank",
		"Member ID",
		"Name",
		"Level",
		"Days In Faction",
		"Position",
		"Ranked War Hits",
		"Raid Hits",
		"Attacks Won",
		"Defends Won",
		"Total Damage",
		"Last Action",
	];

	const csvRows = [headers.map(escapeCsvField).join(",")];

	for (const row of rankedList) {
		const line = [
			row.rank,
			row.id,
			row.name,
			row.level,
			row.daysInFaction,
			row.position,
			row.rankedWarHits,
			row.raidHits,
			row.attacksWon,
			row.defendsWon,
			row.totalDamage,
			row.lastAction,
		]
			.map(escapeCsvField)
			.join(",");
		csvRows.push(line);
	}

	const csvContent = `${csvRows.join("\n")}\n`;
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outputFilename = `faction-${factionId}-ranked-war-hits-${timestamp}.csv`;
	const outputPath = join(process.cwd(), "data", outputFilename);

	await Bun.write(outputPath, csvContent);

	logger.info(
		`Successfully generated CSV report at: ${outputPath} (${rankedList.length} members)`,
	);

	// Print Top 15 to console
	console.log(
		"\n=================== TOP 15 RANKED WAR HITTERS ===================",
	);
	console.log(
		"Rank".padEnd(6) +
			"ID".padEnd(10) +
			"Name".padEnd(20) +
			"Level".padEnd(8) +
			"RW Hits".padEnd(12) +
			"Attacks Won",
	);
	console.log("-".repeat(70));
	for (const m of rankedList.slice(0, 15)) {
		console.log(
			String(m.rank).padEnd(6) +
				String(m.id).padEnd(10) +
				m.name.padEnd(20) +
				String(m.level).padEnd(8) +
				m.rankedWarHits.toLocaleString().padEnd(12) +
				m.attacksWon.toLocaleString(),
		);
	}
	console.log(
		"=================================================================\n",
	);

	finish();
}

main().catch((error) => {
	const msg = error instanceof Error ? error.message : String(error);
	logger.error(`Error executing script: ${msg}`);
	process.exit(1);
});
