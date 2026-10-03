import {
	db,
	eq,
	type FactionAttackLogRow,
	factionAttackLogs,
	type NewFactionAttackLogRow,
	systemStates,
} from "@sentinel/database";
import { TornApiClient, TornError } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import {
	cadenceForActivity,
	DEFAULT_ATTACK_FEED_CADENCE_MS,
	resolveAttackFeedActivity,
} from "../../lib/attack-feed-cadence";
import { schedulerEvents } from "../../lib/events";
import {
	type FamilyMasterApiKey,
	familyMasterKeyStateId,
	getFamilyMasterApiKeys,
} from "../../lib/family-master-keys";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";

const logger = new Logger("Scheduler", "FactionAttackFeed");

export type FactionAttackDirection = "incoming" | "outgoing";

/** Normalised attack shape shared with the merc validator and retal tracker. */
export interface FactionAttackEvent {
	attackId: number;
	factionId: number;
	direction: FactionAttackDirection;
	attackerId: number | null;
	attackerName: string | null;
	attackerFactionId: number | null;
	attackerFactionName: string | null;
	defenderId: number;
	defenderName: string | null;
	defenderFactionId: number | null;
	defenderFactionName: string | null;
	result: string | null;
	attackCode: string | null;
	isRankedWar: boolean;
	/** Finishing hit carried the Stricken weapon bonus (merc premium price). */
	isStricken: boolean;
	/** Unix seconds. */
	startedAt: number | null;
	/** Unix seconds, null while the attack is still in progress. */
	endedAt: number | null;
}

interface RawAttackFaction {
	id?: number;
	name?: string;
	faction?: { id?: number; name?: string } | null;
	faction_id?: number | null;
}

interface RawAttack {
	id: number;
	code?: string;
	started?: number;
	ended?: number;
	timestamp_started?: number;
	timestamp_ended?: number;
	attacker?: RawAttackFaction | null;
	defender: RawAttackFaction;
	result?: string;
	is_ranked_war?: boolean;
	finishing_hit_effects?: { name?: string; value?: number }[];
}

interface TornFactionAttacksResponse {
	attacks?: RawAttack[];
	_metadata?: { links?: { next?: string | null; prev?: string | null } };
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
/** On a cold start we backfill this much history so late subscribers still see it. */
const BACKFILL_SECONDS = 24 * 60 * 60;
const BULK_INSERT_CHUNK = 100;

export interface AttackWatermark {
	lastAttackId: number;
	lastAttackTimestamp: number;
	updatedAt: string;
}

const inMemoryWatermarks = new Map<string, AttackWatermark>();

/**
 * Reads the backfill cursor for a faction. `sort=DESC` means Torn's
 * `links.next` is always null, so the feed derives the cursor from the highest
 * attack id it has already stored.
 */
export async function getAttackWatermark(
	factionId: number,
): Promise<AttackWatermark | null> {
	const stateId = familyMasterKeyStateId(factionId);

	const cached = inMemoryWatermarks.get(stateId);
	if (cached) return cached;

	try {
		const [row] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, stateId));

		if (row?.data && typeof row.data === "object") {
			const data = row.data as Partial<AttackWatermark>;
			if (typeof data.lastAttackId === "number") {
				const watermark: AttackWatermark = {
					lastAttackId: data.lastAttackId,
					lastAttackTimestamp: data.lastAttackTimestamp ?? 0,
					updatedAt: data.updatedAt ?? new Date().toISOString(),
				};
				inMemoryWatermarks.set(stateId, watermark);
				return watermark;
			}
		}
	} catch (err) {
		logger.warn(
			`Failed loading attack watermark for ${stateId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return null;
}

export async function saveAttackWatermark(
	factionId: number,
	lastAttackId: number,
	lastAttackTimestamp: number,
): Promise<void> {
	const stateId = familyMasterKeyStateId(factionId);

	const watermark: AttackWatermark = {
		lastAttackId,
		lastAttackTimestamp,
		updatedAt: new Date().toISOString(),
	};
	inMemoryWatermarks.set(stateId, watermark);

	try {
		await db
			.insert(systemStates)
			.values({
				id: stateId,
				init: true,
				data: watermark,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: { data: watermark, updatedAt: new Date() },
			});
	} catch (err) {
		logger.warn(
			`Failed saving attack watermark for ${stateId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Test seam: clears cached watermarks so the next read hits the database. */
export function clearAttackWatermarkCache(): void {
	inMemoryWatermarks.clear();
}

/**
 * Derives an attack's direction relative to the faction that surfaced it.
 *
 * `/faction/attacks` is queried without a `filters` param so both directions
 * arrive in a single call. Note that passing `filters=incoming,outgoing` is NOT
 * equivalent: Torn parses that as incoming-only and silently drops outgoing
 * attacks, so direction must be resolved per record instead.
 */
export function deriveDirection(
	attack: RawAttack,
	factionId: number,
): FactionAttackDirection | null {
	const defenderFactionId =
		attack.defender?.faction?.id ?? attack.defender?.faction_id ?? null;
	const attackerFactionId = attack.attacker?.faction?.id ?? null;

	if (defenderFactionId === factionId) return "incoming";
	if (attackerFactionId === factionId) return "outgoing";

	// Neither side is our faction: not ours to track.
	return null;
}

/**
 * Normalises a raw Torn attack into the shared event shape. Attacker and
 * defender faction ids are read from the nested `faction` object first and
 * fall back to the flat `faction_id` Torn emits for some records.
 */
export function normaliseAttack(
	attack: RawAttack,
	factionId: number,
): FactionAttackEvent | null {
	if (typeof attack?.id !== "number" || attack.id <= 0) return null;
	if (typeof attack.defender?.id !== "number") return null;

	const direction = deriveDirection(attack, factionId);
	if (direction === null) return null;

	return {
		attackId: attack.id,
		factionId,
		direction,
		attackerId: attack.attacker?.id ?? null,
		attackerName: attack.attacker?.name ?? null,
		attackerFactionId: attack.attacker?.faction?.id ?? null,
		attackerFactionName: attack.attacker?.faction?.name ?? null,
		defenderId: attack.defender.id,
		defenderName: attack.defender.name ?? null,
		defenderFactionId:
			attack.defender?.faction?.id ?? attack.defender?.faction_id ?? null,
		defenderFactionName: attack.defender?.faction?.name ?? null,
		result: attack.result ?? null,
		attackCode: attack.code ?? null,
		isRankedWar: attack.is_ranked_war === true,
		isStricken: Boolean(
			attack.finishing_hit_effects?.some(
				(effect) => effect.name?.toLowerCase() === "stricken",
			),
		),
		startedAt: attack.started ?? attack.timestamp_started ?? null,
		endedAt: attack.ended ?? attack.timestamp_ended ?? null,
	};
}

/**
 * Decides whether an attack is already covered by the stored watermark.
 * Torn attack ids are monotonically increasing, so this is the stop point
 * used to halt pagination.
 */
export function hasReachedWatermark(
	attackId: number,
	watermark: AttackWatermark | null,
): boolean {
	if (!watermark || watermark.lastAttackId <= 0) return false;
	return attackId <= watermark.lastAttackId;
}

/** Resolves the `to` cursor for the next page, or null when backfill is done. */
export function nextPageCursor(
	oldestAttackInPage: RawAttack | undefined,
): number | null {
	if (!oldestAttackInPage) return null;
	const oldest =
		oldestAttackInPage.ended ??
		oldestAttackInPage.started ??
		oldestAttackInPage.timestamp_ended ??
		oldestAttackInPage.timestamp_started;
	return typeof oldest === "number" && oldest > 0 ? oldest : null;
}

interface IngestResult {
	events: FactionAttackEvent[];
	/** False when the page cap was hit before the stop point. */
	complete: boolean;
}

async function ingestFaction(
	client: TornApiClient,
	key: FamilyMasterApiKey,
): Promise<IngestResult> {
	const watermark = await getAttackWatermark(key.factionId);
	const nowSec = Math.floor(Date.now() / 1000);

	// Cold start: backfill a bounded window so a freshly restarted scheduler
	// does not lose the recent retal/merc history.
	let cursor =
		watermark && watermark.lastAttackTimestamp > 0
			? watermark.lastAttackTimestamp
			: nowSec - BACKFILL_SECONDS;

	const events: FactionAttackEvent[] = [];
	const seenAttackIds = new Set<number>();
	let page = 0;
	let reachedStopPoint = false;

	while (page < MAX_PAGES && cursor !== null && !reachedStopPoint) {
		// No `filters` param: one call returns both directions.
		const response = (await client.get("/faction/attacks", {
			apiKey: key.apiKey,
			queryParams: {
				sort: "DESC",
				limit: PAGE_LIMIT,
				to: cursor,
			},
		})) as TornFactionAttacksResponse;

		const attacks = response.attacks ?? [];
		if (attacks.length === 0) break;

		for (const attack of attacks) {
			if (seenAttackIds.has(attack.id)) continue;
			seenAttackIds.add(attack.id);

			if (hasReachedWatermark(attack.id, watermark)) {
				reachedStopPoint = true;
				break;
			}

			const normalised = normaliseAttack(attack, key.factionId);
			if (normalised) events.push(normalised);
		}

		if (reachedStopPoint) break;
		if (attacks.length < PAGE_LIMIT) break;

		const nextCursor = nextPageCursor(attacks[attacks.length - 1]);
		// Guard against re-requesting the same cursor, which would loop forever.
		if (nextCursor === null || nextCursor >= cursor) break;
		cursor = nextCursor;
		page++;
	}

	// The watermark only advances on a clean run. If we bailed out on the page
	// cap we would otherwise skip every attack between here and the stop point.
	if (!reachedStopPoint && events.length > 0) {
		logger.warn(
			`Faction ${key.factionId} ingestion hit the ${MAX_PAGES}-page cap before its stop point; watermark held back so the next cycle re-reads the backlog.`,
		);
		return { events, complete: false };
	}

	if (events.length > 0) {
		let highestAttackId = 0;
		let highestTimestamp = 0;
		for (const event of events) {
			if (event.attackId > highestAttackId) {
				highestAttackId = event.attackId;
				highestTimestamp = event.endedAt ?? event.startedAt ?? 0;
			}
		}
		if (highestAttackId > (watermark?.lastAttackId ?? 0)) {
			await saveAttackWatermark(
				key.factionId,
				highestAttackId,
				highestTimestamp,
			);
		}
	}

	return { events, complete: true };
}

async function persistAttacks(
	events: FactionAttackEvent[],
	sourceKeyId: string,
): Promise<number> {
	const rows: NewFactionAttackLogRow[] = events.map((event) => ({
		attackId: event.attackId,
		factionId: event.factionId,
		direction: event.direction,
		attackerId: event.attackerId,
		attackerName: event.attackerName,
		attackerFactionId: event.attackerFactionId,
		attackerFactionName: event.attackerFactionName,
		defenderId: event.defenderId,
		defenderName: event.defenderName,
		defenderFactionId: event.defenderFactionId,
		defenderFactionName: event.defenderFactionName,
		result: event.result,
		attackCode: event.attackCode,
		isRankedWar: event.isRankedWar,
		isStricken: event.isStricken,
		startedAt: event.startedAt,
		endedAt: event.endedAt,
		sourceKeyId,
	}));

	let written = 0;
	for (let i = 0; i < rows.length; i += BULK_INSERT_CHUNK) {
		const chunk = rows.slice(i, i + BULK_INSERT_CHUNK);
		await db
			.insert(factionAttackLogs)
			.values(chunk)
			.onConflictDoNothing({
				target: [factionAttackLogs.factionId, factionAttackLogs.attackId],
			});
		written += chunk.length;
	}

	return written;
}

/**
 * Loads attacks from the durable store for consumers that boot after ingestion
 * has already run (e.g. a restarted retal tracker rebuilding its window).
 */
export async function loadRecentAttacks(
	factionId: number,
	sinceSec: number,
): Promise<FactionAttackLogRow[]> {
	const rows = await db
		.select()
		.from(factionAttackLogs)
		.where(eq(factionAttackLogs.factionId, factionId))
		.limit(2000);

	// `endedAt === null` means the attack is still in progress, so it counts.
	return rows.filter((row) => (row.endedAt ?? row.startedAt ?? 0) >= sinceSec);
}

function handleKeyError(err: unknown, apiKey: string, factionId: number): void {
	if (err instanceof TornError) {
		logger.warn(
			`Torn API error ${err.code} on faction attacks for ${factionId} (key ...${apiKey.slice(-4)}): ${err.message}`,
		);
		return;
	}
	logger.warn(
		`Failed ingesting faction attacks for ${factionId} (key ...${apiKey.slice(-4)}): ${err instanceof Error ? err.message : String(err)}`,
	);
}

/**
 * One ingestion cycle across every family master key. Persists first, then
 * emits — consumers never see an attack that is not already durable, which is
 * what makes a restart safe.
 */
export async function runFactionAttackFeedCycle(): Promise<number> {
	// Cadence is decided first so an idle deployment costs nothing beyond the
	// activity checks themselves.
	const activity = await resolveAttackFeedActivity();
	const cadenceMs = cadenceForActivity(activity);

	const keys = await getFamilyMasterApiKeys();

	if (keys.length === 0) {
		logger.debug(
			"No family master API keys available; skipping attack feed cycle.",
		);
		return Date.now() + cadenceMs;
	}

	const client = new TornApiClient();
	const collected: FactionAttackEvent[] = [];

	for (const key of keys) {
		try {
			const { events } = await ingestFaction(client, key);
			if (events.length === 0) continue;
			collected.push(...events);
			await persistAttacks(events, key.keyId);
		} catch (err) {
			handleKeyError(err, key.apiKey, key.factionId);
		}
	}

	if (collected.length > 0) {
		logger.info(
			`Ingested ${collected.length} faction attacks across ${keys.length} master key(s) (activity: ${activity}).`,
		);

		// Emit synchronously but never await subscribers: a slow consumer must
		// never stall ingestion.
		schedulerEvents.emit("faction_attacks_ingested", collected);
	}

	return Date.now() + cadenceMs;
}

export const startFactionAttackFeedWorker: WorkerStarter = (options) => {
	startEventDrivenRunner({
		worker: "subversive:faction_attack_feed",
		// Boot on the idle tier; the first cycle re-evaluates immediately.
		defaultCadenceSeconds: DEFAULT_ATTACK_FEED_CADENCE_MS / 1000,
		initialDelayMs: options?.initialDelayMs ?? 1500,
		handler: runFactionAttackFeedCycle,
	});
};
