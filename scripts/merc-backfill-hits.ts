/**
 * Merc Contract System — Hit Backfill & Recovery Script
 * -----------------------------------------------------
 * Recovers mercenary hits that were missed or skipped by the attack validator,
 * such as hits landed during an unintended pause window or skipped due to
 * watermark desynchronization.
 *
 * USAGE
 *   Preview (Dry Run):
 *     bun run merc:backfill
 *     bun run merc:backfill --contract <contract-id>
 *     bun run merc:backfill --attack-ids 12345678,12345679
 *
 *   Apply (Writes hits to database & clears pause windows):
 *     bun run merc:backfill --apply
 *     bun run merc:backfill --apply --clear-pause-windows
 *     bun run merc:backfill --apply --attack-ids 12345678,12345679
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
	} | null;
	result: string;
	finishing_hit_effects?: Array<{ name: string }>;
}

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

async function main() {
	console.log(
		`\n================================================================`,
	);
	console.log(
		`  Merc Contract Hit Recovery & Backfill — ${APPLY ? "APPLY" : "DRY RUN"}`,
	);
	console.log(
		`================================================================\n`,
	);

	try {
		// 1. Locate the target contract
		let contractRow: typeof mercContracts.$inferSelect | undefined;
		if (TARGET_CONTRACT_ID) {
			const [row] = await db
				.select()
				.from(mercContracts)
				.where(eq(mercContracts.id, TARGET_CONTRACT_ID))
				.limit(1);
			contractRow = row;
		} else {
			// Find most recent active, paused, or completed contract
			const rows = await db
				.select()
				.from(mercContracts)
				.orderBy(sql`${mercContracts.createdAt} DESC`)
				.limit(5);

			contractRow =
				rows.find((r) => r.status === "active" || r.status === "paused") ??
				rows[0];
		}

		if (!contractRow) {
			console.log("No mercenary contract found in database.\n");
			return;
		}

		const contract = mapRowToMercContract(contractRow);
		console.log(`Contract: ${contract.id}`);
		console.log(`Faction: ${contract.factionName} [${contract.factionId}]`);
		console.log(`Guild: ${contract.guildId}`);
		console.log(
			`Status in DB: ${contractRow.status} (mapped: ${contract.status})`,
		);
		console.log(`Start Time: ${contract.startTime}`);
		console.log(`End Time: ${contract.endTime ?? "ongoing"}`);
		console.log(`Hit Price: $${contract.hitPrice.toLocaleString()}`);
		console.log(
			`Stricken Price: $${contract.strickenHitPrice?.toLocaleString() ?? "N/A"}`,
		);
		console.log(
			`Pause Windows: ${JSON.stringify(contract.pausedWindows ?? [])}\n`,
		);

		// Optionally clear pause windows if requested or if paused windows exist
		if (
			APPLY &&
			(CLEAR_PAUSE_WINDOWS ||
				(contract.pausedWindows && contract.pausedWindows.length > 0))
		) {
			console.log(`Clearing pause windows on contract ${contract.id}...`);
			await db
				.update(mercContracts)
				.set({
					pausedWindows: [],
					status:
						contractRow.status === "paused" ? "active" : contractRow.status,
					updatedAt: new Date(),
				})
				.where(eq(mercContracts.id, contract.id));
			console.log(`Cleared pause windows.\n`);
		}

		// 2. Fetch master keys
		const keys = await getMasterApiKeys(contract.guildId);
		if (keys.length === 0) {
			console.error(
				"No Torn API keys available for this guild or in environment.",
			);
			return;
		}

		const chosenKey =
			keys.find((k) => k.factionId === contract.factionId)?.apiKey ??
			keys[0]?.apiKey;

		if (!chosenKey) {
			console.error("Unable to select a Torn API key.");
			return;
		}

		const apiClient = new TornApiClient({ defaultApiKey: chosenKey });
		const contractStartSec = Math.floor(
			new Date(contract.startTime).getTime() / 1000,
		);
		const contractEndSec = contract.endTime
			? Math.floor(new Date(contract.endTime).getTime() / 1000)
			: null;

		const candidateAttacks: OutgoingAttack[] = [];

		if (ATTACK_IDS_ARG) {
			// Manually specified attack IDs
			const ids = ATTACK_IDS_ARG.split(",")
				.map((s) => Number(s.trim()))
				.filter((n) => Number.isInteger(n) && n > 0);

			console.log(
				`Fetching ${ids.length} specified attack(s) from Torn API: ${ids.join(", ")}`,
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
					console.warn(`Failed fetching attack ${id}:`, err);
				}
			}
		} else {
			// Scan faction outgoing attacks
			console.log(
				`Scanning faction attacks for faction ${contract.factionId}...`,
			);
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
					const attackEnded =
						attack.timestamp_ended ?? attack.timestamp_started ?? 0;
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
			`Scanned ${candidateAttacks.length} attacks within contract window.`,
		);

		// 3. Filter for missed hits
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

		for (const attack of candidateAttacks) {
			if (!attack.attacker || !attack.defender) continue;

			// Verify not already recorded
			const alreadyInDb = await isAttackProcessed(attack.id, contract.id);
			if (alreadyInDb) continue;

			// Verify attacker belonged to contracting faction (or opponent check)
			const attackerFactionId = attack.attacker.faction?.id ?? null;
			if (
				attackerFactionId !== null &&
				attackerFactionId !== contract.factionId
			) {
				continue;
			}

			// Excluded members check
			if (contract.excludedMembers?.includes(attack.defender.id)) {
				continue;
			}

			// Check result
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

			const attackTimestampSec =
				attack.timestamp_ended ?? attack.timestamp_started ?? Date.now() / 1000;

			missedHitsToCredit.push({
				attackId: attack.id,
				attackerId: attack.attacker.id,
				attackerName: attack.attacker.name,
				attackerFactionId,
				attackerFactionName: attack.attacker.faction?.name ?? null,
				defenderId: attack.defender.id,
				defenderName: attack.defender.name,
				result: attack.result,
				isStricken,
				payoutValue,
				timestamp: new Date(attackTimestampSec * 1000),
			});
		}

		if (missedHitsToCredit.length === 0) {
			console.log(
				"\nNo missed hits detected. Database is completely up to date!\n",
			);
			return;
		}

		console.log(`\nFound ${missedHitsToCredit.length} missed hit(s):`);
		console.table(
			missedHitsToCredit.map((h) => ({
				"Attack ID": h.attackId,
				Attacker: `${h.attackerName} [${h.attackerId}]`,
				Defender: `${h.defenderName} [${h.defenderId}]`,
				Result: h.result,
				Stricken: h.isStricken ? "YES" : "NO",
				Payout: `$${h.payoutValue.toLocaleString()}`,
				Timestamp: h.timestamp.toISOString(),
			})),
		);

		if (!APPLY) {
			console.log(
				"\nRe-run with `--apply` to insert these hits and credit the mercenaries:\n",
			);
			console.log(`  bun run merc:backfill --apply\n`);
			return;
		}

		// 4. Apply backfill
		console.log("\nInserting missed hits into `merc_contract_hits`...");
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
					`Credited attack ${hit.attackId}: ${hit.attackerName} -> ${hit.defenderName} ($${hit.payoutValue.toLocaleString()})`,
				);
			}
		}

		// 5. Reset validator watermarks so scheduler stays synchronized
		await sqlClient`
			DELETE FROM system_states WHERE id LIKE ${`merc:attack_validator:${contract.guildId}:${contract.id}:%`}
		`;
		console.log(`Reset validator watermark for contract ${contract.id}.`);

		console.log(`\nSuccessfully credited ${creditedCount} missed hit(s)!\n`);
	} catch (err) {
		console.error("Backfill failed:", err);
		process.exitCode = 1;
	} finally {
		await closeDatabase();
	}
}

await main();
