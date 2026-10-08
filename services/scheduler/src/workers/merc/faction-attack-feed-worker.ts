import {
	and,
	db,
	desc,
	eq,
	type FactionAttackLogRow,
	factionAttackLogs,
	gte,
	type NewFactionAttackLogRow,
	sql,
	systemStates,
} from "@sentinel/database";
import { TornApiClient, TornError, tornApi } from "@sentinel/torn-api";
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
import {
	type EngagedWarContext,
	getEngagedWarContext,
} from "../subversive/ranked-war-worker";

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
/**
 * Pages ingested per cycle while draining an in-progress war. Mirrors the
 * personal log manager's burst approach: a live war is thousands of attacks deep
 * and fetching it all in one cycle would guarantee a Torn rate-limit lockout.
 * The cursor persists, so each cycle resumes where the last stopped and the
 * backlog drains gradually instead of stalling ingestion.
 *
 * This is only used to reconcile a war that was already running when ingestion
 * first began (or after a long outage). Routine operation needs no backfill at
 * all: the watermark already tracks the newest edge, so every subsequent cycle
 * only reads the handful of attacks since the last one.
 */
const WAR_BACKFILL_PAGES_PER_CYCLE = 5;
/** Small pause between burst pages, as the log manager does, to stay polite. */
const BURST_PAGE_DELAY_MS = 150;
/** Guard against a runaway loop if a cursor somehow stops advancing. */
const MAX_PAGES_PER_CYCLE = 40;
/**
 * Backfill window when no ranked war is engaged. Retal only needs 5 minutes and
 * merc hits dedupe per contract, so a day is ample for reconciliation.
 */
const BACKFILL_SECONDS = 24 * 60 * 60;
/**
 * Backfill window while a ranked war is running. Wars routinely last several
 * days, so a 24h window would start the hit counter partway into the war and
 * understate every member's tally.
 */
const WAR_BACKFILL_SECONDS = 7 * 24 * 60 * 60;
const BULK_INSERT_CHUNK = 100;

export interface AttackWatermark {
	lastAttackId: number;
	lastAttackTimestamp: number;
	/** Backfill cursor walking back through history; null when caught up. */
	backfillCursor: number | null;
	/**
	 * War start timestamp whose history has already been walked. Records that the
	 * one-time per-war reconciliation is done, so a war that began before
	 * ingestion existed is only ever walked once.
	 */
	backfilledWarStart: number | null;
	updatedAt: string;
}

const inMemoryWatermarks = new Map<string, AttackWatermark>();

/**
 * Reads persisted ingest progress for a faction. `sort=DESC` means Torn's
 * `links.next` is always null, so the feed derives its own cursors.
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
					backfillCursor:
						typeof data.backfillCursor === "number"
							? data.backfillCursor
							: null,
					backfilledWarStart:
						typeof data.backfilledWarStart === "number"
							? data.backfilledWarStart
							: null,
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
	updates: Partial<
		Pick<
			AttackWatermark,
			| "lastAttackId"
			| "lastAttackTimestamp"
			| "backfillCursor"
			| "backfilledWarStart"
		>
	>,
): Promise<void> {
	const stateId = familyMasterKeyStateId(factionId);
	const current: AttackWatermark = inMemoryWatermarks.get(stateId) ?? {
		lastAttackId: 0,
		lastAttackTimestamp: 0,
		backfillCursor: null,
		backfilledWarStart: null,
		updatedAt: new Date().toISOString(),
	};

	const watermark: AttackWatermark = {
		lastAttackId: updates.lastAttackId ?? current.lastAttackId,
		lastAttackTimestamp:
			updates.lastAttackTimestamp ?? current.lastAttackTimestamp,
		backfillCursor:
			updates.backfillCursor === undefined
				? current.backfillCursor
				: updates.backfillCursor,
		backfilledWarStart:
			updates.backfilledWarStart === undefined
				? current.backfilledWarStart
				: updates.backfilledWarStart,
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
 * Cycles a faction must spend with an unprogressable cursor before it is reported.
 * A cursor is legitimately re-written mid-cycle while a drain is in flight, so a
 * single observation is not enough to call it stuck.
 */
const STUCK_BACKFILL_REPORT_CYCLES = 3;

/** Consecutive cycles each faction's persisted backfill cursor has been stuck. */
const stuckBackfillCycles = new Map<number, number>();
/** Factions already reported stuck, so one stalled drain logs one error. */
const reportedStuckBackfill = new Set<number>();

/** Test seam: drops cursor-stall tracking so cases start from a clean slate. */
export function clearStuckBackfillTracking(): void {
	stuckBackfillCycles.clear();
	reportedStuckBackfill.clear();
}

/**
 * Whether a persisted backfill cursor sits somewhere it can never make progress.
 *
 * A cursor must be strictly behind the newest ingested attack. Otherwise paging
 * `to=<cursor>` returns that already-ingested attack first, `hasReachedWatermark`
 * stops the loop on it, and the cycle ends with zero events — so the watermark never
 * advances, the cursor is re-written identically, and forward ingestion for that
 * faction is halted indefinitely. Healthy cursors walk strictly backwards (or are
 * cleared), so this predicate does not fire on a working drain.
 */
export function isBackfillCursorStuck(
	watermark: AttackWatermark | null | undefined,
): boolean {
	if (!watermark) return false;
	const cursor = watermark.backfillCursor;
	if (cursor === null) return false;
	return cursor >= watermark.lastAttackTimestamp;
}

/**
 * Counts consecutive stuck cycles for a faction and reports the two transitions
 * worth logging: the cursor becoming stuck, and the cursor clearing again.
 * Returns null while nothing changes.
 */
export function trackBackfillCursor(
	factionId: number,
	watermark: AttackWatermark | null,
): "stuck" | "recovered" | null {
	if (!isBackfillCursorStuck(watermark)) {
		stuckBackfillCycles.delete(factionId);
		return reportedStuckBackfill.delete(factionId) ? "recovered" : null;
	}

	const cycles = (stuckBackfillCycles.get(factionId) ?? 0) + 1;
	stuckBackfillCycles.set(factionId, cycles);

	if (
		cycles < STUCK_BACKFILL_REPORT_CYCLES ||
		reportedStuckBackfill.has(factionId)
	) {
		return null;
	}

	reportedStuckBackfill.add(factionId);
	return "stuck";
}

/**
 * Independent watchdog for the one state this worker can enter that silently halts
 * ingestion for a faction: a backfill cursor that cannot progress. This is a hard
 * invariant rather than a timing heuristic, so it stays quiet through ordinary
 * quiet periods and fires only when the persisted state is provably stuck.
 *
 * It exists because this failure is otherwise invisible — the feed keeps polling,
 * keeps persisting state, and keeps looking healthy from the outside, while every
 * attack by that faction is dropped. Guarding the code path that created the cursor
 * is the fix; this is what makes a future recurrence impossible to miss.
 */
export async function assertBackfillCursorIsProgressing(
	factionId: number,
): Promise<void> {
	// Reads the in-memory watermark the cycle just settled, so this reflects the
	// cursor this cycle persisted rather than a stale row.
	const settled = await getAttackWatermark(factionId);
	const transition = trackBackfillCursor(factionId, settled);

	if (transition === "stuck") {
		logger.error(
			`Faction ${factionId}: backfill cursor ${settled?.backfillCursor} is at or past the newest ingested attack (lastAttackId=${settled?.lastAttackId}, lastAttackTimestamp=${settled?.lastAttackTimestamp}). Paging to that cursor can only return attacks already ingested, so this faction's feed is ingesting NOTHING and its watermark cannot advance — merc hits, retal tracking and war tallies are all blind for it. Clear the stuck cursor and check what anchored the backfill.`,
		);
	} else if (transition === "recovered") {
		logger.info(
			`Faction ${factionId}: backfill cursor cleared; forward ingestion resumed.`,
		);
	}
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
	const attackerFactionId =
		attack.attacker?.faction?.id ?? attack.attacker?.faction_id ?? null;

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
		attackerFactionId:
			attack.attacker?.faction?.id ?? attack.attacker?.faction_id ?? null,
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

/**
 * Resolves the war start that may anchor a backfill walk, or null when no war has
 * actually begun.
 *
 * A ranked war shows up in the war cache while it is still `scheduled`, carrying a
 * *future* start. Treating that future timestamp as a war start made
 * `warNeedsBackfill` trivially true — the watermark is always older than a future
 * timestamp — so the feed pinned `backfillCursor` at the newest watermark value and
 * then issued `to=<that value>` on every cycle, stopping on the watermark
 * immediately: zero events, a watermark that could never advance, and the pin
 * re-applied forever. `historyFloor` was equally unreachable (it pointed into the
 * future), so the loop never terminated and forward ingestion for that faction
 * stayed dead until the war ended. Faction 2013 lost every merc hit it landed for
 * two days this way, including $57M of payable hits on a live contract.
 *
 * An unstarted war contributes nothing to backfill: there is no war history to walk
 * to yet, and the live feed will capture the war from its first second.
 */
export function resolveBackfillWarStart(
	warContext: EngagedWarContext | null,
	nowSec: number,
): number | null {
	const start = warContext?.start;
	if (start == null) return null;
	return start <= nowSec ? start : null;
}

interface IngestResult {
	events: FactionAttackEvent[];
	/** False when the burst page budget ran out with backlog remaining. */
	caughtUp: boolean;
}

/** Sleep helper so burst pages do not hammer the API back to back. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ingests one burst of pages for a faction.
 *
 * Two cursors move independently:
 *  - the newest edge (watermark attack id) only advances when the stop point is
 *    reached, so an interrupted run never skips attacks;
 *  - the backfill cursor walks toward history and persists between cycles, so a
 *    deep war drains gradually instead of needing one enormous cycle.
 */
async function ingestFaction(
	client: TornApiClient,
	key: FamilyMasterApiKey,
): Promise<IngestResult> {
	const watermark = await getAttackWatermark(key.factionId);
	const nowSec = Math.floor(Date.now() / 1000);

	// An upcoming war deliberately does not anchor backfill: see
	// `resolveBackfillWarStart` for why a future war start deadlocks this loop.
	const warStart = resolveBackfillWarStart(
		getEngagedWarContext(key.factionId),
		nowSec,
	);
	const backfillSeconds =
		warStart !== null ? WAR_BACKFILL_SECONDS : BACKFILL_SECONDS;

	// A war that began while ingestion was offline (e.g. initial setup) needs a
	// one-time walk back to its start. If the watermark has already reached or
	// passed warStart, the live feed is already capturing everything in real time.
	const warNeedsBackfill =
		warStart !== null &&
		watermark !== null &&
		watermark.backfilledWarStart !== warStart &&
		watermark.lastAttackTimestamp < warStart;

	// Walk to the war start, not past it: everything before the war opened is not
	// part of the tally and paging into it would waste the whole rate-limit budget.
	const historyFloor = warStart ?? nowSec - backfillSeconds;

	// A live backfill cursor means we are resuming a historical backfill.
	// Routine forward ingestion starts from null (no 'to' parameter), which
	// prompts Torn to return the most recent attacks down to the watermark.
	let cursor: number | null = watermark?.backfillCursor ?? null;

	const isBackfilling = watermark?.backfillCursor != null;
	const pageBudget = isBackfilling
		? WAR_BACKFILL_PAGES_PER_CYCLE
		: MAX_PAGES_PER_CYCLE;

	const events: FactionAttackEvent[] = [];
	const seenAttackIds = new Set<number>();
	let page = 0;
	let reachedStopPoint = false;
	let stoppedOnShortPage = false;
	/** Cursor could not advance; distinct from "caught up with history". */
	let cursorStalled = false;
	let reachedHistoryFloor = false;

	while (page < pageBudget && !reachedStopPoint) {
		const queryParams: Record<string, unknown> = {
			sort: "DESC",
			limit: PAGE_LIMIT,
		};
		if (typeof cursor === "number" && cursor > 0) {
			queryParams.to = cursor;
		}

		// No `filters` param: one call returns both directions.
		const response = (await client.get("/faction/attacks", {
			apiKey: key.apiKey,
			// Accounted against the owning user, not the raw key: the managed
			// client's limiter is keyed by user id, so this keeps every path in one
			// counter (and keeps API keys out of rate-limit warnings).
			rateLimitKey: key.tornId,
			queryParams,
		})) as TornFactionAttacksResponse;

		const attacks = response.attacks ?? [];
		if (attacks.length === 0) {
			stoppedOnShortPage = true;
			break;
		}

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
		if (attacks.length < PAGE_LIMIT) {
			stoppedOnShortPage = true;
			break;
		}

		const nextCursor = nextPageCursor(attacks[attacks.length - 1]);
		if (nextCursor === null) {
			cursorStalled = true;
			break;
		}

		if (nextCursor <= historyFloor) {
			// Everything back to the war start (or the window floor) is now read.
			reachedHistoryFloor = true;
			break;
		}

		// Many attacks resolve within the same second, so a full page can end on
		// the very timestamp we queried with. Re-requesting that cursor would
		// return the identical page forever, so step one second earlier to force
		// forward progress. Overlap is harmless: rows upsert on (faction, attack)
		// and repeat ids are skipped by seenAttackIds.
		if (cursor !== null && nextCursor >= cursor) {
			cursorStalled = true;
			cursor = cursor - 1;
		} else {
			cursor = nextCursor;
		}
		page++;

		if (page < pageBudget) await delay(BURST_PAGE_DELAY_MS);
	}

	// A stall is not progress. Reporting it as caught up would advance the
	// watermark past attacks we never read, which is exactly how merc hits and
	// war tally entries go missing.
	const caughtUp =
		reachedStopPoint || stoppedOnShortPage || reachedHistoryFloor;

	// The newest-edge watermark only advances on a clean catch-up or when new attacks were read.
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
			await saveAttackWatermark(key.factionId, {
				lastAttackId: highestAttackId,
				lastAttackTimestamp: highestTimestamp,
			});
		}
	}

	if (cursorStalled) {
		// The page ended on its own cursor (dense same-second traffic). We stepped
		// back one second to keep draining, and the watermark deliberately stays put
		// so nothing unread is ever skipped past.
		logger.warn(
			`Faction ${key.factionId}: attack feed cursor collided with a full page ending on the same second; stepped back to ${cursor} to keep draining.`,
		);
	}

	// Manage backfill and reconciliation cursors
	if (warNeedsBackfill && warStart !== null) {
		if (reachedHistoryFloor) {
			await saveAttackWatermark(key.factionId, {
				backfilledWarStart: warStart,
				backfillCursor: null,
			});
		} else if (!caughtUp && cursor !== null) {
			await saveAttackWatermark(key.factionId, { backfillCursor: cursor });
		} else if (caughtUp) {
			// Caught up with no cursor left to walk, so there is nothing below the
			// watermark left to reconcile: the drain above reads back from the newest
			// edge until it meets the watermark or runs out of history, which covers
			// every attack since the watermark — including the whole war, because this
			// branch is only reachable while the watermark predates the war start.
			// Converge the war marker instead of scheduling a walk.
			//
			// The previous code pinned `backfillCursor` at the watermark timestamp here,
			// and that cursor can never make progress: paging `to=<watermark timestamp>`
			// returns the watermark attack first, `hasReachedWatermark` stops the loop on
			// it, and the history-floor check is never reached. Every cycle then ingested
			// nothing, re-pinned the identical cursor, and the watermark froze — forward
			// ingestion for that faction was dead until the war ended. It cost faction
			// 2013 two days of merc hits ($57M payable) and would equally have been
			// triggered by an ordinary war starting while the faction was quiet.
			await saveAttackWatermark(key.factionId, {
				backfilledWarStart: warStart,
			});
		}
	} else if (!caughtUp && cursor !== null) {
		await saveAttackWatermark(key.factionId, { backfillCursor: cursor });
	} else if (watermark?.backfillCursor != null) {
		await saveAttackWatermark(key.factionId, { backfillCursor: null });
	} else if (
		warStart !== null &&
		watermark &&
		watermark.backfilledWarStart !== warStart &&
		watermark.lastAttackTimestamp >= warStart
	) {
		await saveAttackWatermark(key.factionId, { backfilledWarStart: warStart });
	}

	// Checked last so it judges the cursor this cycle actually persisted.
	await assertBackfillCursorIsProgressing(key.factionId);

	return { events, caughtUp };
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
 *
 * The time window is applied in SQL and the rows are ordered newest-first. The
 * previous form filtered in JS over an unordered `.limit(2000)`, which returned
 * an arbitrary slice of the faction's 7-day history rather than the most recent
 * attacks — so a restart could rebuild the window from the wrong rows.
 */
export async function loadRecentAttacks(
	factionId: number,
	sinceSec: number,
): Promise<FactionAttackLogRow[]> {
	// `endedAt` is null for an attack still in progress, which counts, so the
	// predicate coalesces to `startedAt` exactly as the old JS filter did.
	return await db
		.select()
		.from(factionAttackLogs)
		.where(
			and(
				eq(factionAttackLogs.factionId, factionId),
				gte(
					sql`coalesce(${factionAttackLogs.endedAt}, ${factionAttackLogs.startedAt})`,
					sinceSec,
				),
			),
		)
		.orderBy(desc(factionAttackLogs.endedAt))
		.limit(2000);
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

	// Shares the managed client's limiter so this worker's requests are counted
	// against the same per-key budget as every `tornApi.*` call. Built as a bare
	// client (it needs a specific family master key), which otherwise bypasses
	// local rate limiting entirely.
	const client = new TornApiClient({
		rateLimitTracker: tornApi.rateLimiter,
	});
	const collected: FactionAttackEvent[] = [];
	let anyCatchingUp = false;

	for (const key of keys) {
		try {
			const { events, caughtUp } = await ingestFaction(client, key);
			if (!caughtUp) anyCatchingUp = true;
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

	if (anyCatchingUp) {
		logger.debug(
			"Attack feed is still draining backlog; next cycle resumes from the persisted cursor.",
		);
	}

	// While draining a backlog we return immediately so the next burst starts
	// straight away instead of idling for a full cadence.
	if (anyCatchingUp) return Date.now() + BURST_PAGE_DELAY_MS * 2;

	return Date.now() + cadenceMs;
}

export const startFactionAttackFeedWorker: WorkerStarter = (options) => {
	startEventDrivenRunner({
		worker: "subversive:faction_attack_feed",
		// Boot on the idle tier; the first cycle re-evaluates activity.
		defaultCadenceSeconds: DEFAULT_ATTACK_FEED_CADENCE_MS / 1000,
		initialDelayMs: options?.initialDelayMs ?? 1500,
		handler: runFactionAttackFeedCycle,
	});
};
