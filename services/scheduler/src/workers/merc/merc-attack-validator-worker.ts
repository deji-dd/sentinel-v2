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
import { getFamilyMasterApiKeys } from "../../lib/family-master-keys";
import type { WorkerStarter } from "../registry";
import {
	type FactionAttackEvent,
	getAttackWatermark,
} from "./faction-attack-feed-worker";
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

	// Diagnostics: an attack that matches no contract target faction is the most
	// common silent drop, so surface the counts rather than losing them quietly.
	let matchedFaction = 0;
	let noContractForFaction = 0;

	for (const attack of outgoing) {
		try {
			if (contracts.some((c) => c.factionId === attack.defenderFactionId)) {
				matchedFaction++;
			} else {
				noContractForFaction++;
			}
			await creditAttackAgainstContracts(attack, contracts, logChannels);
		} catch (err) {
			logger.warn(
				`Error crediting merc attack ${attack.attackId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (outgoing.length > 0) {
		logger.info(
			`Merc batch: ${outgoing.length} outgoing attack(s); ${matchedFaction} matched a contract faction, ${noContractForFaction} did not (no open contract for that target).`,
		);
	}
}

/**
 * Liveness watchdog for the shared feed.
 *
 * The validator deliberately has no second API path: the feed is the only
 * reader of `/v2/faction/attacks`, so a direct poll here would double the call
 * rate against rate-limited master keys for no additional coverage. The risk
 * worth guarding instead is silence — if a faction's feed stalls while merc
 * contracts are open, its hits would stop crediting unnoticed.
 *
 * The guard is per faction, because the feed is per faction: one faction's
 * ingestion can die while a busy sibling keeps the feed looking healthy overall.
 * A feed-wide silence check used to live here and was removed, because it was
 * wrong in both directions: it announced "feed recovered" off a sibling's traffic
 * while the dead faction stayed dead, and it said nothing at all during the two
 * days a faction was genuinely blind, since it only spoke while a contract was
 * open. Its 90s threshold was also mis-calibrated against a stream whose ordinary
 * inter-attack gaps run from seconds to tens of minutes, so it fired on normal
 * peacetime pacing.
 *
 * Severity is deliberate. A quiet faction is evidence, not proof — with no second
 * API path, silence cannot be distinguished from a faction that simply is not
 * attacking, so this warns. The provable case, a backfill cursor that cannot
 * progress, is a hard error raised by the feed worker itself (see
 * `assertBackfillCursorIsProgressing`).
 */
/**
 * Per-faction threshold, deliberately far longer than any per-event cadence: a single
 * faction can legitimately be quiet for minutes, because a resolved Torn attack takes
 * minutes and only *completed* attacks reach the feed. Silence this long from a faction
 * whose members are being paid to hit a live contract target is worth looking at, and
 * is the failure a feed-wide check cannot attribute to anyone.
 */
const FACTION_STALEN_WARN_MS = 10 * 60_000;

/** Newest feed event seen per faction, so one faction's death is visible. */
const lastFeedEventAtMsByFaction = new Map<number, number>();
/** Factions already reported as stalled, so one outage logs one warning. */
const stalledFactionWarnings = new Set<number>();

/**
 * Records liveness for each faction in a batch, and notes a faction's recovery.
 *
 * Per faction rather than one shared clock: a shared clock let any faction's attack
 * clear the alarm for every faction, which is exactly how a completely blind faction
 * looked healthy for two days.
 */
function markFeedAlive(attacks: FactionAttackEvent[]): void {
	const nowMs = Date.now();

	for (const attack of attacks) {
		lastFeedEventAtMsByFaction.set(attack.factionId, nowMs);
		if (stalledFactionWarnings.delete(attack.factionId)) {
			logger.info(
				`Faction ${attack.factionId} attack feed recovered; its merc hits are being validated again.`,
			);
		}
	}
}

/**
 * Factions whose feeds have gone quiet long enough to be worth looking at.
 *
 * A feed-wide check cannot see this: one faction's ingestion can die while another
 * keeps emitting, which is exactly how faction 2013's merc hits went uncredited for
 * two days with nothing worse in the log than a flapping "feed recovered" message.
 * Factions we do not ingest are never considered, unobserved factions must be seeded
 * by the caller first, and each stalled faction is reported only once per outage.
 */
export function findStalledFactions(input: {
	factionIds: readonly number[];
	lastEventAtByFaction: ReadonlyMap<number, number>;
	nowMs: number;
	thresholdMs: number;
	alreadyWarned: ReadonlySet<number>;
}): { factionId: number; silentSeconds: number }[] {
	const {
		factionIds,
		lastEventAtByFaction,
		nowMs,
		thresholdMs,
		alreadyWarned,
	} = input;

	const stalled: { factionId: number; silentSeconds: number }[] = [];

	for (const factionId of factionIds) {
		if (alreadyWarned.has(factionId)) continue;

		const lastEventAtMs = lastEventAtByFaction.get(factionId);
		if (lastEventAtMs === undefined) continue;

		const silentMs = nowMs - lastEventAtMs;
		if (silentMs < thresholdMs) continue;

		stalled.push({
			factionId,
			silentSeconds: Math.round(silentMs / 1000),
		});
	}

	return stalled;
}

/**
 * Reports factions whose ingestion has stalled while merc contracts are open.
 *
 * This is the check that would have caught the pinned-backfill-cursor deadlock in
 * `faction-attack-feed-worker` immediately instead of two days later, so the stored
 * watermark is included: a non-null `backfillCursor` is the signature of that
 * specific stall and says outright that forward ingestion is halted.
 */
async function warnAboutStalledFactions(openContracts: number): Promise<void> {
	const keys = await getFamilyMasterApiKeys();
	if (keys.length === 0) return;

	const nowMs = Date.now();
	const factionIds = keys.map((key) => key.factionId);

	// Seed factions on first sight: a faction is measured from when we started
	// watching it, so a fresh boot is never reported as silent since epoch.
	for (const factionId of factionIds) {
		if (!lastFeedEventAtMsByFaction.has(factionId)) {
			lastFeedEventAtMsByFaction.set(factionId, nowMs);
		}
	}

	const stalled = findStalledFactions({
		factionIds,
		lastEventAtByFaction: lastFeedEventAtMsByFaction,
		nowMs,
		thresholdMs: FACTION_STALEN_WARN_MS,
		alreadyWarned: stalledFactionWarnings,
	});

	for (const faction of stalled) {
		stalledFactionWarnings.add(faction.factionId);

		const watermark = await getAttackWatermark(faction.factionId);
		const pinnedCursor = watermark?.backfillCursor ?? null;

		// Warned, not errored: silence alone cannot distinguish a broken feed from a
		// faction that simply is not attacking, and this alert only sees the former.
		// A pinned cursor is the one case where silence has a stated cause, and that
		// same condition is raised as a hard error by the feed worker itself.
		logger.warn(
			`No faction attack data for faction ${faction.factionId} in ${faction.silentSeconds}s while ${openContracts} merc contract(s) are open — hits by its members ${pinnedCursor !== null ? "are not being validated" : "may be going unvalidated if it is active"}. (watermark: lastAttackId=${watermark?.lastAttackId ?? "none"}, lastAttackTimestamp=${watermark?.lastAttackTimestamp ?? "none"}${pinnedCursor !== null ? `, backfillCursor=${pinnedCursor} PINNED — forward ingestion is halted until the cursor clears` : ""})`,
		);
	}
}

/**
 * Reports per-faction feed silence while merc contracts are creditable.
 *
 * An idle faction legitimately produces no completed attacks for minutes at a time, so
 * this only runs while something is being paid for, and only warns — see the severity
 * note in `warnAboutStalledFactions`.
 */
async function assertFeedIsAlive(): Promise<void> {
	const contracts = await getValidatableContracts();
	if (contracts.length === 0) return;

	await warnAboutStalledFactions(contracts.length);
}

let isSubscriptionActive = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the Mercenary Attack Validator Worker.
 *
 * Validation is driven entirely by the shared faction attack feed, which is the
 * sole reader of `/v2/faction/attacks`. Polling here as well would double the
 * call rate against rate-limited master keys without adding coverage, so instead
 * the worker runs a watchdog: while contracts are creditable, any faction whose feed
 * has gone quiet is warned about by name, rather than stalling payouts unnoticed.
 *
 * That is a heuristic on purpose. The state that provably halts ingestion — a
 * backfill cursor that cannot progress — is guarded where it is written, in
 * `faction-attack-feed-worker`, and raised there as an error.
 */
export const startMercAttackValidatorWorker: WorkerStarter = () => {
	if (isSubscriptionActive) return;
	isSubscriptionActive = true;

	schedulerEvents.on(
		"faction_attacks_ingested",
		(attacks: FactionAttackEvent[]) => {
			markFeedAlive(attacks);
			void handleIngestedAttacks(attacks).catch((err: unknown) => {
				logger.warn(
					`Merc attack validation failed for an ingested batch: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		},
	);

	watchdogTimer = setInterval(() => {
		void assertFeedIsAlive().catch((err: unknown) => {
			logger.warn(
				`Merc feed watchdog check failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}, 30_000);
	watchdogTimer.unref?.();

	logger.info(
		"Merc attack validator subscribed to faction attack feed with liveness watchdog.",
	);
};
