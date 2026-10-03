import {
	db,
	eq,
	getMercChannelConfig,
	getMercContractSummary,
	inArray,
	isAttackProcessed,
	type MercContract,
	mapRowToMercContract,
	mercContracts,
	recordMercContractHit,
} from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { notifyBotAction } from "@sentinel/utils/ipc";
import { schedulerEvents } from "../../lib/events";
import type { WorkerStarter } from "../registry";
import type { FactionAttackEvent } from "./faction-attack-feed-worker";
import { mercTargetManager } from "./merc-contract-worker";

const logger = new Logger("Scheduler", "MercAttackValidator");

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
 * Attack results that represent no damage dealt. Shared with the ranked war hit
 * counter so the two definitions of "a landed hit" cannot drift apart.
 */
export const DISQUALIFYING_RESULTS: ReadonlySet<string> = new Set([
	"Lost",
	"Stalemate",
	"Escape",
	"Assist",
	"Interrupted",
	"Timeout",
]);

/**
 * Whether an attack result counts as damage actually dealt. A missing result
 * is not a landed hit: an attack we could not classify must never inflate a
 * member's tally.
 */
export function isLandedHit(result: string | null | undefined): boolean {
	if (!result) return false;
	return !DISQUALIFYING_RESULTS.has(result);
}

/**
 * Promotes upcoming contracts to active once their start time has passed, and
 * drops paused contracts entirely: no target posting and no hit crediting while
 * paused.
 */
async function getValidatableContracts(): Promise<MercContract[]> {
	const nowMs = Date.now();

	const rows = await db
		.select()
		.from(mercContracts)
		.where(inArray(mercContracts.status, ["active", "upcoming", "paused"]));

	const validatable: MercContract[] = [];

	for (const contract of rows.map(mapRowToMercContract)) {
		const startMs = new Date(contract.startTime).getTime();

		if (contract.status === "paused") continue;

		if (contract.status === "upcoming" && nowMs >= startMs) {
			logger.info(
				`Upcoming contract ${contract.id} (${contract.factionName}) start time reached. Transitioning to active.`,
			);
			await db
				.update(mercContracts)
				.set({ status: "active", updatedAt: new Date() })
				.where(eq(mercContracts.id, contract.id));

			contract.status = "active";
			validatable.push(contract);
		} else if (contract.status === "active" && nowMs >= startMs) {
			validatable.push(contract);
		}
	}

	return validatable;
}

/** Applies auto-stop pricing and posts the end summary when the cap is hit. */
async function enforceAutoStop(
	contract: MercContract,
	logChannel: string,
): Promise<void> {
	if (!contract.autoStopPrice || contract.autoStopPrice <= 0) return;

	const summary = await getMercContractSummary(contract.id);
	if (summary.totalPayout < contract.autoStopPrice) return;

	logger.info(
		`Mercenary contract ${contract.id} (${contract.factionName}) reached auto-stop price ($${contract.autoStopPrice.toLocaleString()} - total payout: $${summary.totalPayout.toLocaleString()}). Concluding contract.`,
	);

	await db
		.update(mercContracts)
		.set({ status: "completed", endTime: new Date(), updatedAt: new Date() })
		.where(eq(mercContracts.id, contract.id));

	const channelConfig = await getMercChannelConfig(contract.guildId);

	void notifyBotAction("post_merc_contract_end_summary", {
		guildId: contract.guildId,
		channelName: channelConfig.mercLog || logChannel,
		contract: {
			...contract,
			status: "completed",
			endTime: new Date().toISOString(),
		},
		summary,
	});

	void notifyBotAction("delete_merc_upcoming_announcement", {
		guildId: contract.guildId,
		channelName: logChannel,
		contractId: contract.id,
		factionId: contract.factionId,
		messageId: contract.upcomingMessageId ?? undefined,
	});

	mercTargetManager.cleanContractTargets(contract.id);
}

/**
 * Credits a single attack against every contract whose target faction matches.
 * This is the entire business rule set for merc hit validation: timeframe and
 * pause gating, excluded members, disqualifying results and per-contract dedupe.
 */
async function creditAttackAgainstContracts(
	attack: FactionAttackEvent,
	contracts: MercContract[],
	logChannels: Map<string, string>,
): Promise<void> {
	if (DISQUALIFYING_RESULTS.has(attack.result ?? "")) return;
	if (attack.defenderFactionId === null) return;

	for (const contract of contracts) {
		if (contract.factionId !== attack.defenderFactionId) continue;

		if (
			contract.excludedMembers &&
			contract.excludedMembers.length > 0 &&
			contract.excludedMembers.includes(attack.defenderId)
		) {
			continue;
		}

		const contractStartSec = Math.floor(
			new Date(contract.startTime).getTime() / 1000,
		);
		const contractEndSec = contract.endTime
			? Math.floor(new Date(contract.endTime).getTime() / 1000)
			: null;

		const attackEnded = attack.endedAt ?? attack.startedAt ?? 0;

		if (attackEnded > 0) {
			if (attackEnded < contractStartSec) continue;
			if (contractEndSec && attackEnded > contractEndSec) continue;
		}

		if (isWithinPausedWindow(contract.pausedWindows, attackEnded)) {
			logger.info(
				`Skipped merc attack ${attack.attackId}: occurred during a paused window for contract ${contract.id}.`,
			);
			continue;
		}

		if (await isAttackProcessed(attack.attackId, contract.id)) continue;

		const isHospitalized =
			(attack.result ?? "").toLowerCase() === "hospitalized";
		const payoutValue = isHospitalized
			? attack.isStricken && contract.strickenHitPrice
				? contract.strickenHitPrice
				: (contract.hitPrice ?? 0)
			: 0;

		const hitTimestampMs =
			attackEnded > 0
				? attackEnded < 1e11
					? attackEnded * 1000
					: attackEnded
				: Date.now();
		const hitDate = new Date(hitTimestampMs);

		await recordMercContractHit({
			contractId: contract.id,
			guildId: contract.guildId,
			attackId: attack.attackId,
			attackerId: attack.attackerId ?? 0,
			attackerName: attack.attackerName ?? "Unknown Mercenary",
			attackerFactionId: attack.attackerFactionId,
			attackerFactionName: attack.attackerFactionName,
			defenderId: attack.defenderId,
			defenderName: attack.defenderName ?? `Player ${attack.defenderId}`,
			result: attack.result ?? "",
			isStricken: attack.isStricken,
			payoutValue,
			timestamp: hitDate,
		});

		logger.info(
			`Validated merc hit: ${attack.attackerName} [${attack.attackerId}] ${attack.result} ${attack.defenderName} [${attack.defenderId}] ($${payoutValue.toLocaleString()}${attack.isStricken ? " STRICKEN" : ""}${!isHospitalized ? " [NO PAYOUT - NOT HOSP]" : ""})`,
		);

		const logChannel = logChannels.get(contract.guildId) ?? "merc-logs";
		void notifyBotAction("post_merc_hit_log", {
			guildId: contract.guildId,
			channelName: logChannel,
			hitData: {
				attackerName: attack.attackerName ?? "Unknown Mercenary",
				attackerId: attack.attackerId ?? 0,
				defenderName: attack.defenderName ?? `Player ${attack.defenderId}`,
				defenderId: attack.defenderId,
				result: attack.result ?? "",
				isStricken: attack.isStricken,
				payoutValue,
				attackId: attack.attackId,
				attackCode: attack.attackCode ?? undefined,
				timestamp: hitDate,
			},
		});

		mercTargetManager.downTarget(contract.id, attack.defenderId);

		await enforceAutoStop(contract, logChannel);
	}
}

/**
 * Subscribes to the shared faction attack feed. The feed is the only reader of
 * `/v2/faction/attacks`; this worker reacts to what it has already persisted.
 */
export async function handleIngestedAttacks(
	attacks: FactionAttackEvent[],
): Promise<void> {
	// Only outgoing attacks can represent mercenary work on a contract target,
	// and only an attack with a resolvable attacker can be credited.
	const outgoing = attacks.filter(
		(attack) => attack.direction === "outgoing" && attack.attackerId !== null,
	);

	if (outgoing.length === 0) return;

	const contracts = await getValidatableContracts();
	if (contracts.length === 0) return;

	const logChannels = new Map<string, string>();
	for (const guildId of new Set(contracts.map((c) => c.guildId))) {
		const channelConfig = await getMercChannelConfig(guildId);
		logChannels.set(guildId, channelConfig.mercLog || "merc-logs");
	}

	for (const attack of outgoing) {
		try {
			await creditAttackAgainstContracts(attack, contracts, logChannels);
		} catch (err) {
			logger.warn(
				`Error crediting merc attack ${attack.attackId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

let isSubscriptionActive = false;

/**
 * Starts the Mercenary Attack Validator Worker.
 *
 * Validation is now event-driven off the shared faction attack feed rather than
 * polling the Torn API directly, so this worker no longer runs a timed cycle of
 * its own — it only reacts to newly ingested attacks.
 */
export const startMercAttackValidatorWorker: WorkerStarter = () => {
	if (isSubscriptionActive) return;
	isSubscriptionActive = true;

	schedulerEvents.on(
		"faction_attacks_ingested",
		(attacks: FactionAttackEvent[]) => {
			void handleIngestedAttacks(attacks).catch((err: unknown) => {
				logger.warn(
					`Merc attack validation failed for an ingested batch: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		},
	);

	logger.info("Merc attack validator subscribed to faction attack feed.");
};
