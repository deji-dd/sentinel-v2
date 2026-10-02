import { createHash } from "node:crypto";
import {
	db,
	eq,
	getMercChannelConfig,
	guildApiKeys,
	inArray,
	isAttackProcessed,
	type MercContract,
	mapRowToMercContract,
	mercContractHits,
	mercContracts,
	recordMercContractHit,
	sql,
	systemStates,
} from "@sentinel/database";
import { decryptApiKey, TornApiClient, TornError } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { notifyBotAction } from "@sentinel/utils/ipc";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import { mercTargetManager } from "./merc-contract-worker";

const logger = new Logger("Scheduler", "MercAttackValidator");

interface FinishingHitEffect {
	name: string;
	value: number;
}

interface OutgoingAttack {
	id: number;
	code?: string;
	timestamp_started: number;
	timestamp_ended: number;
	attacker: {
		id: number;
		name: string;
		faction?: {
			id: number;
			name: string;
		};
	};
	defender: {
		id: number;
		name: string;
		faction?: {
			id: number;
			name: string;
		};
	};
	result: string;
	finishing_hit_effects?: FinishingHitEffect[];
}

interface TornFactionAttacksResponse {
	attacks?: OutgoingAttack[];
	_metadata?: {
		links?: {
			next?: string | null;
			prev?: string | null;
		};
	};
}

export interface AttackValidatorProgress {
	lastAttackId: number;
	lastAttackTimestamp: number;
	updatedAt: string;
}

const inMemoryProgress = new Map<string, AttackValidatorProgress>();

export function getProgressStateId(
	guildId: string,
	keyInfo: { factionId?: number; apiKey: string },
): string {
	const keyIdentifier = keyInfo.factionId
		? `faction_${keyInfo.factionId}`
		: `key_${createHash("sha256").update(keyInfo.apiKey).digest("hex").slice(0, 12)}`;
	return `merc:attack_validator:${guildId}:${keyIdentifier}`;
}

export async function getAttackValidatorProgress(
	guildId: string,
	keyInfo: { factionId?: number; apiKey: string },
): Promise<AttackValidatorProgress | null> {
	const stateId = getProgressStateId(guildId, keyInfo);

	const cached = inMemoryProgress.get(stateId);
	if (cached) return cached;

	try {
		const [row] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, stateId));

		if (row?.data && typeof row.data === "object") {
			const data = row.data as Partial<AttackValidatorProgress>;
			if (typeof data.lastAttackId === "number") {
				const progress: AttackValidatorProgress = {
					lastAttackId: data.lastAttackId,
					lastAttackTimestamp: data.lastAttackTimestamp ?? 0,
					updatedAt: data.updatedAt ?? new Date().toISOString(),
				};
				inMemoryProgress.set(stateId, progress);
				return progress;
			}
		}
	} catch (err) {
		logger.warn(
			`Failed loading attack validator progress for ${stateId}:`,
			err,
		);
	}

	return null;
}

export async function saveAttackValidatorProgress(
	guildId: string,
	keyInfo: { factionId?: number; apiKey: string },
	lastAttackId: number,
	lastAttackTimestamp: number,
): Promise<void> {
	const stateId = getProgressStateId(guildId, keyInfo);

	const progress: AttackValidatorProgress = {
		lastAttackId,
		lastAttackTimestamp,
		updatedAt: new Date().toISOString(),
	};

	inMemoryProgress.set(stateId, progress);

	try {
		await db
			.insert(systemStates)
			.values({
				id: stateId,
				init: true,
				data: progress,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					data: progress,
					updatedAt: new Date(),
				},
			});
	} catch (err) {
		logger.warn(`Failed saving attack validator progress for ${stateId}:`, err);
	}
}

export function parseNextLinkParams(nextLink: string): Record<string, unknown> {
	const params: Record<string, unknown> = {
		filters: "outgoing",
		sort: "DESC",
		limit: 100,
	};
	try {
		const url = new URL(nextLink, "https://api.torn.com");
		for (const [key, val] of url.searchParams.entries()) {
			if (key === "key" || key === "comment" || key === "timestamp") continue;
			const num = Number(val);
			params[key] = !Number.isNaN(num) && String(num) === val ? num : val;
		}
	} catch {
		const toMatch = nextLink.match(/[?&]to=(\d+)/);
		const toVal = toMatch?.[1];
		if (toVal) {
			params.to = Number.parseInt(toVal, 10);
		}
	}
	return params;
}

// In-memory set for zero-overhead attack deduplication
const processedAttackIds = new Set<number>();

// Maximum size for in-memory attack ID cache before pruning old entries
const MAX_PROCESSED_CACHE_SIZE = 10_000;

function rememberAttackId(id: number): void {
	if (processedAttackIds.size >= MAX_PROCESSED_CACHE_SIZE) {
		const iter = processedAttackIds.values();
		for (let i = 0; i < 2_000; i++) {
			const val = iter.next().value;
			if (val !== undefined) {
				processedAttackIds.delete(val);
			}
		}
	}
	processedAttackIds.add(id);
}

/**
 * Retrieves usable master API keys for a guild with active merc contracts.
 */
async function getMasterApiKeysForGuild(
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
						} catch (err) {
							logger.warn(`Failed decrypting master key ${r.id}:`, err);
						}
					}
				}
			}
		}
	} catch (err) {
		logger.warn(`Failed reading master keys for guild ${guildId}:`, err);
	}

	// Fallback to environment API key if no master keys configured
	if (keys.length === 0 && process.env.TORN_API_KEY) {
		keys.push({ apiKey: process.env.TORN_API_KEY });
	}

	return keys;
}

const DISQUALIFYING_RESULTS = new Set([
	"Lost",
	"Stalemate",
	"Escape",
	"Assist",
	"Interrupted",
	"Timeout",
]);

/**
 * Runs a single cycle of the Mercenary Attack Validator.
 * Queries /faction/attacks?filters=outgoing periodically using family master keys.
 */
export async function runMercAttackValidationCycle(): Promise<number> {
	// 1. Fetch active contracts
	const rows = await db
		.select()
		.from(mercContracts)
		.where(eq(mercContracts.status, "active"));

	if (rows.length === 0) {
		return Date.now() + 30_000;
	}

	const activeContracts = rows.map(mapRowToMercContract);

	// Group contracts by guildId
	const contractsByGuild = new Map<string, MercContract[]>();
	for (const c of activeContracts) {
		const list = contractsByGuild.get(c.guildId) ?? [];
		list.push(c);
		contractsByGuild.set(c.guildId, list);
	}

	const apiClient = new TornApiClient();

	for (const [guildId, contracts] of contractsByGuild.entries()) {
		const channelConfig = await getMercChannelConfig(guildId);
		const logChannel = channelConfig.mercLog || "merc-logs";
		const masterKeys = await getMasterApiKeysForGuild(guildId);

		if (masterKeys.length === 0) {
			logger.warn(`No master API keys available for guild ${guildId}.`);
			continue;
		}

		const earliestContractStartTime = Math.min(
			...contracts.map((c) =>
				Math.floor(new Date(c.startTime).getTime() / 1000),
			),
		);

		for (const keyInfo of masterKeys) {
			try {
				const progress = await getAttackValidatorProgress(guildId, keyInfo);
				let lastAttackId = progress?.lastAttackId ?? null;

				if (lastAttackId === null) {
					// Fallback to checking the highest credited hit in DB for this guild
					const [maxHitRow] = await db
						.select({
							maxAttackId: sql<number>`MAX(${mercContractHits.attackId})`,
						})
						.from(mercContractHits)
						.where(eq(mercContractHits.guildId, guildId));
					if (maxHitRow?.maxAttackId) {
						lastAttackId = Number(maxHitRow.maxAttackId);
					}
				}

				let currentQueryParams: Record<string, unknown> = {
					filters: "outgoing",
					sort: "DESC",
					limit: 100,
				};

				const collectedAttacks: OutgoingAttack[] = [];
				const seenAttackIds = new Set<number>();
				let reachedStopPoint = false;
				let page = 1;
				const MAX_PAGES = 30; // Supports up to 3,000 attacks during high-volume periods
				let highestAttackIdSeen = lastAttackId ?? 0;
				let highestAttackTimestampSeen = progress?.lastAttackTimestamp ?? 0;

				while (page <= MAX_PAGES && !reachedStopPoint) {
					const attacksRes = (await apiClient.get("/faction/attacks", {
						apiKey: keyInfo.apiKey,
						queryParams: currentQueryParams,
					})) as TornFactionAttacksResponse;

					const attacks = attacksRes.attacks ?? [];
					if (attacks.length === 0) break;

					for (const attack of attacks) {
						if (seenAttackIds.has(attack.id)) continue;
						seenAttackIds.add(attack.id);

						if (attack.id > highestAttackIdSeen) {
							highestAttackIdSeen = attack.id;
							highestAttackTimestampSeen = attack.timestamp_ended;
						}

						// 1. Reached where we last stopped:
						if (
							lastAttackId !== null &&
							lastAttackId > 0 &&
							attack.id <= lastAttackId
						) {
							reachedStopPoint = true;
							break;
						}

						// 2. Attack occurred before the earliest active contract start time:
						if (attack.timestamp_ended < earliestContractStartTime) {
							reachedStopPoint = true;
							break;
						}

						collectedAttacks.push(attack);
					}

					if (reachedStopPoint) break;

					const nextLink = attacksRes._metadata?.links?.next;
					if (nextLink) {
						currentQueryParams = parseNextLinkParams(nextLink);
						page++;
					} else if (attacks.length >= 100) {
						const oldestAttack = attacks[attacks.length - 1];
						if (oldestAttack) {
							currentQueryParams = {
								filters: "outgoing",
								sort: "DESC",
								limit: 100,
								to: oldestAttack.timestamp_ended,
							};
							page++;
						} else {
							break;
						}
					} else {
						break;
					}
				}

				if (page > 1) {
					logger.info(
						`Paginated ${page} pages (${collectedAttacks.length} new attacks collected) for guild ${guildId} up to last stopped point (${lastAttackId ?? "none"}).`,
					);
				}

				// Process collected attacks in chronological order (oldest to newest)
				collectedAttacks.reverse();

				for (const attack of collectedAttacks) {
					// Disqualify non-offensive or non-winning results
					if (DISQUALIFYING_RESULTS.has(attack.result)) {
						continue;
					}

					// Fast in-memory deduplication check
					if (processedAttackIds.has(attack.id)) {
						continue;
					}

					// Match attack against contracts
					for (const contract of contracts) {
						// Check target faction match
						if (attack.defender.faction?.id !== contract.factionId) {
							continue;
						}

						const startSec = Math.floor(
							new Date(contract.startTime).getTime() / 1000,
						);
						const endSec = contract.endTime
							? Math.floor(new Date(contract.endTime).getTime() / 1000)
							: null;

						// Check timeframe
						if (attack.timestamp_ended < startSec) {
							continue;
						}
						if (endSec && attack.timestamp_ended > endSec) {
							continue;
						}

						// Check database deduplication
						const alreadyInDb = await isAttackProcessed(attack.id);
						if (alreadyInDb) {
							rememberAttackId(attack.id);
							continue;
						}

						// Detect Stricken effect (named "warlord" or "stricken" in Torn API)
						const isStricken = Boolean(
							attack.finishing_hit_effects?.some((e) => {
								const lower = e.name.toLowerCase();
								return lower === "warlord" || lower === "stricken";
							}),
						);

						// Calculate hit payout value: only count payout if result is Hospitalized
						const isHospitalized =
							attack.result.toLowerCase() === "hospitalized";
						let payoutValue = 0;
						if (isHospitalized) {
							payoutValue =
								isStricken && contract.strickenHitPrice
									? contract.strickenHitPrice
									: (contract.hitPrice ?? 0);
						}

						// Record hit in database
						await recordMercContractHit({
							contractId: contract.id,
							guildId: contract.guildId,
							attackId: attack.id,
							attackerId: attack.attacker.id,
							attackerName: attack.attacker.name,
							defenderId: attack.defender.id,
							defenderName: attack.defender.name,
							result: attack.result,
							isStricken,
							payoutValue,
							timestamp: new Date(attack.timestamp_ended * 1000),
						});

						rememberAttackId(attack.id);

						logger.info(
							`Validated merc hit: ${attack.attacker.name} [${attack.attacker.id}] ${attack.result} ${attack.defender.name} [${attack.defender.id}] ($${payoutValue.toLocaleString()}${isStricken ? " STRICKEN" : ""}${!isHospitalized ? " [NO PAYOUT - NOT HOSP]" : ""})`,
						);

						// Post validated hit log to #merc-log (strictly zero emojis)
						void notifyBotAction("post_merc_hit_log", {
							guildId: contract.guildId,
							channelName: logChannel,
							hitData: {
								attackerName: attack.attacker.name,
								attackerId: attack.attacker.id,
								defenderName: attack.defender.name,
								defenderId: attack.defender.id,
								result: attack.result,
								isStricken,
								payoutValue,
								attackId: attack.id,
								attackCode: attack.code,
								timestamp: new Date(attack.timestamp_ended * 1000),
							},
						});

						// Target was hit -> down target embed from #targets immediately
						await mercTargetManager.downTarget(contract.id, attack.defender.id);
					}
				}

				// Persist progress to systemStates so it survives restarts
				if (highestAttackIdSeen > (lastAttackId ?? 0)) {
					await saveAttackValidatorProgress(
						guildId,
						keyInfo,
						highestAttackIdSeen,
						highestAttackTimestampSeen,
					);
				}
			} catch (err) {
				if (err instanceof TornError) {
					logger.warn(
						`Torn API error during merc attack validation (${err.code}): ${err.message}`,
					);
				} else {
					logger.warn(
						`Error checking merc attacks for guild ${guildId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}

	// 5-second cadence during active contracts
	return Date.now() + 5_000;
}

/**
 * Starts the Mercenary Attack Validator Worker in the scheduler service.
 */
export const startMercAttackValidatorWorker: WorkerStarter = (options) => {
	startEventDrivenRunner({
		worker: "merc:attack_validator",
		defaultCadenceSeconds: 5,
		initialDelayMs: options?.initialDelayMs ?? 2000,
		handler: runMercAttackValidationCycle,
	});
};
