/**
 * Merc Contract System — Hit Backfill & Recovery Script
 * -----------------------------------------------------
 * Recovers mercenary hits that were missed or skipped by the attack validator,
 * such as hits landed during an unintended pause window or skipped due to
 * watermark desynchronization.
 *
 * USAGE
 *   Scan all recent contracts (Dry Run):
 *     bun run merc:backfill
 *
 *   Scan a specific contract:
 *     bun run merc:backfill --contract <contract-id>
 *
 *   Apply changes (Inserts missed hits to DB & resets watermarks):
 *     bun run merc:backfill --apply
 *     bun run merc:backfill --contract <contract-id> --apply
 *     bun run merc:backfill --contract <contract-id> --apply --clear-pause-windows
 *
 *   Manually credit specific attack IDs:
 *     bun run merc:backfill --contract <contract-id> --apply --attack-ids 12345678,12345679
 */

import {
	closeDatabase,
	db,
	eq,
	guildApiKeys,
	inArray,
	isAttackProcessed,
	mapRowToMercContract,
	mercContracts,
	recordMercContractHit,
	sql,
	sqlClient,
	systemStates,
} from "../packages/database";
import { decryptApiKey, TornApiClient } from "../packages/torn-api";

const APPLY = process.argv.includes("--apply");
const CLEAR_PAUSE_WINDOWS = process.argv.includes("--clear-pause-windows");

function getArgValue(flag: string): string | null {
	const idx = process.argv.indexOf(flag);
	if (idx !== -1 && process.argv[idx + 1]) {
		return process.argv[idx + 1] ?? null;
	}
	const prefix = `${flag}=`;
	const match = process.argv.find((arg) => arg.startsWith(prefix));
	if (match) {
		return match.slice(prefix.length);
	}
	return null;
}

const TARGET_CONTRACT_ID = getArgValue("--contract");
const ATTACK_IDS_ARG = getArgValue("--attack-ids");

interface OutgoingAttack {
	id: number;
	code?: string;
	/** `/faction/attacks` returns `started`/`ended`; `/torn/{id}` uses the timestamp_* names. */
	started?: number;
	ended?: number;
	timestamp_started?: number;
	timestamp_ended?: number;
	attacker?: {
		id: number;
		name: string;
		faction?: {
			id: number;
			name: string;
		} | null;
	} | null;
	defender?: {
		id: number;
		name: string;
		faction?: {
			id: number;
			name: string;
		} | null;
		faction_id?: number;
	} | null;
	result: string;
	finishing_hit_effects?: Array<{ name: string }>;
}

/**
 * Resolves when an attack finished, accepting either endpoint's field naming.
 *
 * `/faction/attacks` returns `started`/`ended`, whereas `/torn/{id}` returns
 * `timestamp_started`/`timestamp_ended`. Reading only the timestamp_* names made
 * every faction-feed attack look timestamp-less, so the contract timeframe window
 * was never applied and every hit was stamped with the moment the script ran.
 */
function resolveAttackEnded(attack: OutgoingAttack): number {
	return (
		attack.ended ??
		attack.timestamp_ended ??
		attack.started ??
		attack.timestamp_started ??
		0
	);
}

const DISQUALIFYING_RESULTS = new Set([
	"Lost",
	"Stalemate",
	"Escape",
	"Assist",
	"Interrupted",
	"Timeout",
]);

async function getMasterApiKeys(
	guildId: string,
): Promise<Array<{ factionId?: number; apiKey: string }>> {
	const keys: Array<{ factionId?: number; apiKey: string }> = [];
	const masterKey = process.env.ENCRYPTION_KEY ?? "";

	try {
		const stateKey = `merc:master_keys:${guildId}`;
		const [stateRow] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, stateKey));

		if (stateRow?.data && typeof stateRow.data === "object") {
			const map = stateRow.data as Record<
				string,
				{ keyId?: string; factionId?: number }
			>;
			const keyIds = Object.values(map)
				.map((item) => item.keyId)
				.filter((k): k is string => Boolean(k));

			if (keyIds.length > 0) {
				const rows = await db
					.select()
					.from(guildApiKeys)
					.where(inArray(guildApiKeys.id, keyIds));

				for (const r of rows) {
					if (r.apiKeyEncrypted) {
						try {
							const plain = decryptApiKey(r.apiKeyEncrypted, masterKey);
							const factionId = Object.values(map).find(
								(m) => m.keyId === r.id,
							)?.factionId;
							keys.push({ factionId, apiKey: plain });
						} catch {}
					}
				}
			}
		}
	} catch {}

	if (keys.length === 0 && process.env.TORN_API_KEY) {
		keys.push({ apiKey: process.env.TORN_API_KEY });
	}

	return keys;
}

async function processSingleContract(
	contractRow: typeof mercContracts.$inferSelect,
) {
	const contract = mapRowToMercContract(contractRow);
	const line = "-".repeat(60);
	console.log(`\n${line}`);
	console.log(`Contract ID : ${contract.id}`);
	console.log(`Target      : ${contract.factionName} [${contract.factionId}]`);
	console.log(`Guild ID    : ${contract.guildId}`);
	console.log(
		`Status in DB: ${contractRow.status} (mapped: ${contract.status})`,
	);
	console.log(`Start Time  : ${contract.startTime}`);
	console.log(`End Time    : ${contract.endTime ?? "ongoing"}`);
	console.log(
		`Hit Price   : $${contract.hitPrice.toLocaleString()}${contract.strickenHitPrice ? ` (Stricken: $${contract.strickenHitPrice.toLocaleString()})` : ""}`,
	);
	const pauseCount = contract.pausedWindows?.length ?? 0;
	console.log(
		`Pause Windows: ${pauseCount > 0 ? JSON.stringify(contract.pausedWindows) : "none"}`,
	);
	console.log(`${line}`);

	if (APPLY && (CLEAR_PAUSE_WINDOWS || pauseCount > 0)) {
		console.log(`Clearing pause windows on contract ${contract.id}...`);
		await db
			.update(mercContracts)
			.set({
				pausedWindows: [],
				updatedAt: new Date(),
			})
			.where(eq(mercContracts.id, contract.id));
		console.log(`Cleared pause windows.`);
	}

	const keys = await getMasterApiKeys(contract.guildId);
	if (keys.length === 0) {
		console.warn(
			`  No master Torn API keys found for guild ${contract.guildId}. Skipping.`,
		);
		return;
	}

	const chosenKey = keys[0]?.apiKey;
	if (!chosenKey) {
		console.warn("  Could not resolve a valid Torn API key. Skipping.");
		return;
	}

	const apiClient = new TornApiClient({ defaultApiKey: chosenKey });
	const contractStartSec = Math.floor(
		new Date(contract.startTime).getTime() / 1000,
	);
	// 15-minute grace window after end_time to capture hits landed right at conclusion
	const contractEndSec = contract.endTime
		? Math.floor(new Date(contract.endTime).getTime() / 1000) + 900
		: null;

	const candidateAttacks: OutgoingAttack[] = [];

	if (ATTACK_IDS_ARG) {
		const ids = ATTACK_IDS_ARG.split(",")
			.map((s) => Number(s.trim()))
			.filter((n) => Number.isInteger(n) && n > 0);

		console.log(
			`  Fetching ${ids.length} specified attack(s) from Torn API: ${ids.join(", ")}`,
		);
		for (const id of ids) {
			try {
				const res = (await apiClient.get(`/torn/${id}`, {
					apiKey: chosenKey,
					queryParams: { selections: "attacks" },
				})) as { attack?: OutgoingAttack };

				if (res?.attack) {
					candidateAttacks.push(res.attack);
				}
			} catch (err) {
				console.warn(`  Failed fetching attack ${id}:`, err);
			}
		}
	} else {
		console.log(`  Fetching outgoing attacks for contractor faction...`);
		let currentQueryParams: Record<string, unknown> = {
			filters: "outgoing",
			sort: "DESC",
			limit: 100,
		};

		let page = 1;
		const MAX_PAGES = 10;
		let reachedStop = false;

		while (page <= MAX_PAGES && !reachedStop) {
			const attacksRes = (await apiClient.get("/faction/attacks", {
				apiKey: chosenKey,
				queryParams: currentQueryParams,
			})) as {
				attacks?: OutgoingAttack[];
				_metadata?: { links?: { next?: string } };
			};

			const attacks = attacksRes.attacks ?? [];
			if (attacks.length === 0) break;

			for (const attack of attacks) {
				const attackEnded = resolveAttackEnded(attack);
				if (attackEnded > 0 && attackEnded < contractStartSec) {
					reachedStop = true;
					break;
				}
				if (contractEndSec && attackEnded > contractEndSec) {
					continue;
				}
				candidateAttacks.push(attack);
			}

			if (reachedStop) break;

			const nextLink = attacksRes._metadata?.links?.next;
			if (!nextLink) break;

			try {
				const url = new URL(nextLink, "https://api.torn.com");
				const nextParams: Record<string, unknown> = {
					filters: "outgoing",
					sort: "DESC",
					limit: 100,
				};
				for (const [k, v] of url.searchParams.entries()) {
					if (k === "key" || k === "comment" || k === "timestamp") continue;
					const num = Number(v);
					nextParams[k] = !Number.isNaN(num) && String(num) === v ? num : v;
				}
				currentQueryParams = nextParams;
			} catch {
				break;
			}

			page++;
		}
	}

	console.log(
		`  Scanned ${candidateAttacks.length} total attack(s) in contract timeframe.`,
	);

	const missedHitsToCredit: Array<{
		attackId: number;
		attackerId: number;
		attackerName: string;
		attackerFactionId?: number | null;
		attackerFactionName?: string | null;
		defenderId: number;
		defenderName: string;
		result: string;
		isStricken: boolean;
		payoutValue: number;
		timestamp: Date;
	}> = [];

	// Diagnostics: tally every reason a qualifying attack was dropped so a dry run
	// explains itself instead of silently reporting only what survived.
	const dropReasons: Record<string, number> = {
		no_participants: 0,
		disqualifying_result: 0,
		wrong_defender_faction: 0,
		excluded_member: 0,
		already_recorded: 0,
	};
	let qualifying = 0;

	for (const attack of candidateAttacks) {
		if (!attack.attacker || !attack.defender) {
			dropReasons.no_participants++;
			continue;
		}
		if (DISQUALIFYING_RESULTS.has(attack.result)) {
			dropReasons.disqualifying_result++;
			continue;
		}

		// The DEFENDER must belong to the target faction
		const defenderFactionId =
			attack.defender.faction?.id ?? attack.defender.faction_id ?? null;
		if (defenderFactionId !== contract.factionId) {
			dropReasons.wrong_defender_faction++;
			continue;
		}

		// Excluded members check
		if (contract.excludedMembers?.includes(attack.defender.id)) {
			dropReasons.excluded_member++;
			continue;
		}

		qualifying++;

		// Check if already recorded in database
		const alreadyInDb = await isAttackProcessed(attack.id, contract.id);
		if (alreadyInDb) {
			dropReasons.already_recorded++;
			continue;
		}

		// Calculate payout value: only hospitalized attacks receive payout
		const isHospitalized = attack.result.toLowerCase() === "hospitalized";
		const isStricken = Boolean(
			attack.finishing_hit_effects?.some(
				(e) => e.name.toLowerCase() === "stricken",
			),
		);

		let payoutValue = 0;
		if (isHospitalized) {
			payoutValue =
				isStricken && contract.strickenHitPrice
					? contract.strickenHitPrice
					: contract.hitPrice;
		}

		const resolvedEnded = resolveAttackEnded(attack);
		// Never fall back to "now": a fabricated timestamp silently corrupts the
		// hit history and any payout period derived from it.
		if (resolvedEnded <= 0) {
			console.warn(
				`  Attack ${attack.id} has no usable timestamp; skipping rather than stamping it with the current time.`,
			);
			continue;
		}
		const attackTimestampSec = resolvedEnded;

		missedHitsToCredit.push({
			attackId: attack.id,
			attackerId: attack.attacker.id,
			attackerName: attack.attacker.name,
			attackerFactionId: attack.attacker.faction?.id ?? null,
			attackerFactionName: attack.attacker.faction?.name ?? null,
			defenderId: attack.defender.id,
			defenderName: attack.defender.name,
			result: attack.result,
			isStricken,
			payoutValue,
			timestamp: new Date(attackTimestampSec * 1000),
		});
	}

	console.log(
		`  ${qualifying} attack(s) hit the target faction and passed all contract rules.`,
	);
	console.log(`  Drop reasons: ${JSON.stringify(dropReasons)}`);

	if (missedHitsToCredit.length === 0) {
		console.log(`  No missed hits found for this contract.`);
		return;
	}

	console.log(
		`\n  FOUND ${missedHitsToCredit.length} MISSED HIT(S) FOR CONTRACT ${contract.id}:`,
	);
	console.table(
		missedHitsToCredit.map((h) => ({
			"Attack ID": h.attackId,
			Attacker: `${h.attackerName} [${h.attackerId}]`,
			Defender: `${h.defenderName} [${h.defenderId}]`,
			Result: h.result,
			Stricken: h.isStricken ? "YES" : "NO",
			Payout: `$${h.payoutValue.toLocaleString()}`,
			"Timestamp (TCT)": h.timestamp
				.toISOString()
				.replace("T", " ")
				.slice(0, 19),
		})),
	);

	if (!APPLY) {
		console.log(
			`  Run with \`--apply --contract ${contract.id}\` to insert these hits.`,
		);
		return;
	}

	console.log(
		`  Inserting ${missedHitsToCredit.length} hit(s) into \`merc_contract_hits\`...`,
	);
	let creditedCount = 0;
	for (const hit of missedHitsToCredit) {
		const success = await recordMercContractHit({
			contractId: contract.id,
			guildId: contract.guildId,
			attackId: hit.attackId,
			attackerId: hit.attackerId,
			attackerName: hit.attackerName,
			attackerFactionId: hit.attackerFactionId,
			attackerFactionName: hit.attackerFactionName,
			defenderId: hit.defenderId,
			defenderName: hit.defenderName,
			result: hit.result,
			isStricken: hit.isStricken,
			payoutValue: hit.payoutValue,
			timestamp: hit.timestamp,
		});

		if (success) {
			creditedCount++;
			console.log(
				`  Credited attack ${hit.attackId}: ${hit.attackerName} -> ${hit.defenderName} ($${hit.payoutValue.toLocaleString()})`,
			);
		}
	}

	await sqlClient`
		DELETE FROM system_states WHERE id LIKE ${`merc:attack_validator:${contract.guildId}:${contract.id}:%`}
	`;
	console.log(`  Reset validator watermark for contract ${contract.id}.`);
	console.log(`  Successfully credited ${creditedCount} hit(s)!`);
}

async function main() {
	console.log(
		`\n================================================================`,
	);
	console.log(
		`  Merc Contract Hit Recovery & Backfill — ${APPLY ? "APPLY" : "DRY RUN"}`,
	);
	console.log(
		`================================================================`,
	);

	try {
		const allRecentRows = await db
			.select()
			.from(mercContracts)
			.orderBy(sql`${mercContracts.createdAt} DESC`)
			.limit(10);

		if (allRecentRows.length === 0) {
			console.log("\nNo mercenary contracts found in database.\n");
			return;
		}

		console.log(`\nRecent Contracts in Database:`);
		console.table(
			allRecentRows.map((r, i) => ({
				"#": i + 1,
				"Contract ID": r.id,
				Target: `${r.factionName} [${r.factionId}]`,
				Status: r.status,
				"Start Time": r.startTime.toISOString().replace("T", " ").slice(0, 19),
				"End Time": r.endTime
					? r.endTime.toISOString().replace("T", " ").slice(0, 19)
					: "ongoing",
				"Pause Windows": Array.isArray(r.pausedWindows)
					? r.pausedWindows.length
					: 0,
			})),
		);

		let targetRows: (typeof mercContracts.$inferSelect)[] = [];

		if (TARGET_CONTRACT_ID && TARGET_CONTRACT_ID !== "all") {
			const found = allRecentRows.filter((r) => r.id === TARGET_CONTRACT_ID);
			if (found.length === 0) {
				const [fetched] = await db
					.select()
					.from(mercContracts)
					.where(eq(mercContracts.id, TARGET_CONTRACT_ID))
					.limit(1);
				if (fetched) {
					targetRows = [fetched];
				} else {
					console.error(`\nContract ID "${TARGET_CONTRACT_ID}" not found.`);
					return;
				}
			} else {
				targetRows = found;
			}
		} else {
			// Scan all recent contracts (last 10)
			console.log(
				`\nScanning all ${allRecentRows.length} recent contract(s)...`,
			);
			targetRows = allRecentRows;
		}

		for (const row of targetRows) {
			await processSingleContract(row);
		}

		console.log("\nFinished processing.\n");
	} catch (err) {
		console.error("Backfill failed:", err);
		process.exitCode = 1;
	} finally {
		await closeDatabase();
	}
}

await main();
