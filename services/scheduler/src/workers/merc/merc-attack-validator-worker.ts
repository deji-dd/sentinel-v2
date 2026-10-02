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
	started?: number;
	ended?: number;
	timestamp_started?: number;
	timestamp_ended?: number;
	attacker: {
		id: number;
		name: string;
		faction?: {
			id: number;
			name: string;
		} | null;
	} | null;
	defender: {
		id: number;
		name: string;
		faction?: {
			id: number;
			name: string;
		} | null;
		faction_id?: number | null;
	};
	result: string;
	finishing_hit_effects?: FinishingHitEffect[];
}

export function getAttackEndedTimestamp(attack: OutgoingAttack): number {
	return Number(
		attack.ended ??
			attack.timestamp_ended ??
			attack.started ??
			attack.timestamp_started ??
			0,
	);
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
	contractId: string,
	keyInfo: { factionId?: number; apiKey: string },
): string {
	const keyIdentifier = keyInfo.factionId
		? `faction_${keyInfo.factionId}`
		: `key_${createHash("sha256").update(keyInfo.apiKey).digest("hex").slice(0, 12)}`;
	return `merc:attack_validator:${guildId}:${contractId}:${keyIdentifier}`;
}

export async function getAttackValidatorProgress(
	guildId: string,
	contractId: string,
	keyInfo: { factionId?: number; apiKey: string },
): Promise<AttackValidatorProgress | null> {
	const stateId = getProgressStateId(guildId, contractId, keyInfo);

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
	contractId: string,
	keyInfo: { factionId?: number; apiKey: string },
	lastAttackId: number,
	lastAttackTimestamp: number,
): Promise<void> {
	const stateId = getProgressStateId(guildId, contractId, keyInfo);

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

/**
 * Determines whether an attack timestamp falls inside a pause window for the contract.
 * An open window (resumedAt === null) extends to the present, so hits landing while
 * the contract was paused are excluded from payout.
 */
export function isWithinPausedWindow(
	pausedWindows: MercContract["pausedWindows"] | undefined | null,
	attackEndedSec: number,
): boolean {
	if (!pausedWindows || pausedWindows.length === 0) return false;
	if (attackEndedSec <= 0) return false;

	for (const w of pausedWindows) {
		const startSec = Math.floor(new Date(w.pausedAt).getTime() / 1000);
		const endSec = w.resumedAt
			? Math.floor(new Date(w.resumedAt).getTime() / 1000)
			: Number.POSITIVE_INFINITY;
		if (attackEndedSec >= startSec && attackEndedSec <= endSec) {
			return true;
		}
	}
	return false;
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
	const nowMs = Date.now();

	// 1. Fetch active, upcoming and paused contracts. Paused contracts are
	//    selected so we can close any window opened while they were paused, but
	//    they are never eligible for validation (see below).
	const rows = await db
		.select()
		.from(mercContracts)
		.where(inArray(mercContracts.status, ["active", "upcoming", "paused"]));

	if (rows.length === 0) {
		return Date.now() + 30_000;
	}

	const allContracts = rows.map(mapRowToMercContract);
	const activeContracts: MercContract[] = [];

	for (const contract of allContracts) {
		const startMs = new Date(contract.startTime).getTime();

		// Paused contracts are excluded from validation entirely: no target
		// posting and no hit crediting while paused.
		if (contract.status === "paused") {
			continue;
		}

		// If any contract in DB was marked 'upcoming' but has reached start time, transition to active
		if (contract.status === "upcoming" && nowMs >= startMs) {
			logger.info(
				`Upcoming contract ${contract.id} (${contract.factionName}) start time reached. Transitioning to active.`,
			);
			await db
				.update(mercContracts)
				.set({ status: "active", updatedAt: new Date() })
				.where(eq(mercContracts.id, contract.id));

			contract.status = "active";
			activeContracts.push(contract);
		} else if (contract.status === "active" && nowMs >= startMs) {
			activeContracts.push(contract);
		}
	}

	if (activeContracts.length === 0) {
		return Date.now() + 30_000;
	}

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

		for (const contract of contracts) {
			const contractStartSec = Math.floor(
				new Date(contract.startTime).getTime() / 1000,
			);
			const contractEndSec = contract.endTime
				? Math.floor(new Date(contract.endTime).getTime() / 1000)
				: null;

			for (const keyInfo of masterKeys) {
				try {
					const progress = await getAttackValidatorProgress(
						guildId,
						contract.id,
						keyInfo,
					);
					let lastAttackId = progress?.lastAttackId ?? null;

					if (lastAttackId === null) {
						// Fallback to checking the highest credited hit in DB for this specific contract
						const [maxHitRow] = await db
							.select({
								maxAttackId: sql<number>`MAX(${mercContractHits.attackId})`,
							})
							.from(mercContractHits)
							.where(eq(mercContractHits.contractId, contract.id));
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

							const attackEnded = getAttackEndedTimestamp(attack);

							// 1. Reached where this specific contract last stopped:
							if (
								lastAttackId !== null &&
								lastAttackId > 0 &&
								attack.id <= lastAttackId
							) {
								reachedStopPoint = true;
								break;
							}

							// 2. Attack occurred before this contract's start time:
							if (attackEnded > 0 && attackEnded < contractStartSec) {
								reachedStopPoint = true;
								break;
							}

							// Watermark is advanced only for attacks that survive the
							// stop-point and timeframe gates above. Advancing it for
							// discarded attacks previously skipped past attacks that
							// should have been credited on the next run.
							if (attack.id > highestAttackIdSeen) {
								highestAttackIdSeen = attack.id;
								highestAttackTimestampSeen = attackEnded;
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
							const oldestEnded = oldestAttack
								? getAttackEndedTimestamp(oldestAttack)
								: 0;
							if (oldestEnded > 0) {
								currentQueryParams = {
									filters: "outgoing",
									sort: "DESC",
									limit: 100,
									to: oldestEnded,
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
							`Paginated ${page} pages (${collectedAttacks.length} new attacks collected) for contract ${contract.id} (${contract.factionName}) up to last stopped point (${lastAttackId ?? "none"}).`,
						);
					}

					// Process collected attacks in chronological order (oldest to newest)
					collectedAttacks.reverse();

					for (const attack of collectedAttacks) {
						// Disqualify non-offensive or non-winning results
						if (DISQUALIFYING_RESULTS.has(attack.result)) {
							continue;
						}

						const defenderFactionId =
							attack.defender.faction?.id ?? attack.defender.faction_id ?? null;

						// Check target faction match
						if (defenderFactionId !== contract.factionId) {
							continue;
						}

						// Check excluded members: skip if defender was excluded from contract
						if (
							contract.excludedMembers &&
							contract.excludedMembers.length > 0 &&
							contract.excludedMembers.includes(attack.defender.id)
						) {
							continue;
						}

						const attackEnded = getAttackEndedTimestamp(attack);

						// Check timeframe
						if (attackEnded > 0) {
							if (attackEnded < contractStartSec) {
								continue;
							}
							if (contractEndSec && attackEnded > contractEndSec) {
								continue;
							}
						}

						// Exclude hits that landed while the contract was paused
						if (isWithinPausedWindow(contract.pausedWindows, attackEnded)) {
							logger.info(
								`Skipped merc attack ${attack.id}: occurred during a paused window for contract ${contract.id}.`,
							);
							continue;
						}

						// Check database deduplication for this contract
						const alreadyInDb = await isAttackProcessed(attack.id, contract.id);
						if (alreadyInDb) {
							continue;
						}

						// Detect Stricken weapon bonus effect on finishing hit (only "stricken")
						const isStricken = Boolean(
							attack.finishing_hit_effects?.some((e) => {
								return e.name.toLowerCase() === "stricken";
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

						const hitTimestampMs =
							attackEnded > 0
								? attackEnded < 1e11
									? attackEnded * 1000
									: attackEnded
								: Date.now();
						const hitDate = new Date(hitTimestampMs);

						const attackerId = attack.attacker?.id ?? 0;
						const attackerName = attack.attacker?.name ?? "Unknown Mercenary";
						const attackerFactionId =
							attack.attacker?.faction?.id ?? keyInfo.factionId ?? null;
						const attackerFactionName = attack.attacker?.faction?.name ?? null;

						// Record hit in database
						await recordMercContractHit({
							contractId: contract.id,
							guildId: contract.guildId,
							attackId: attack.id,
							attackerId,
							attackerName,
							attackerFactionId,
							attackerFactionName,
							defenderId: attack.defender.id,
							defenderName: attack.defender.name,
							result: attack.result,
							isStricken,
							payoutValue,
							timestamp: hitDate,
						});

						logger.info(
							`Validated merc hit: ${attackerName} [${attackerId}] ${attack.result} ${attack.defender.name} [${attack.defender.id}] ($${payoutValue.toLocaleString()}${isStricken ? " STRICKEN" : ""}${!isHospitalized ? " [NO PAYOUT - NOT HOSP]" : ""})`,
						);

						// Post validated hit log to #merc-log (strictly zero emojis)
						void notifyBotAction("post_merc_hit_log", {
							guildId: contract.guildId,
							channelName: logChannel,
							hitData: {
								attackerName: attackerName,
								attackerId: attackerId,
								defenderName: attack.defender.name,
								defenderId: attack.defender.id,
								result: attack.result,
								isStricken,
								payoutValue,
								attackId: attack.id,
								attackCode: attack.code,
								timestamp: hitDate,
							},
						});

						// Target was hit -> down target embed from #targets immediately
						await mercTargetManager.downTarget(contract.id, attack.defender.id);
					}

					// Persist progress to systemStates per contract
					if (highestAttackIdSeen > (lastAttackId ?? 0)) {
						await saveAttackValidatorProgress(
							guildId,
							contract.id,
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
							`Error checking merc attacks for contract ${contract.id}: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
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
