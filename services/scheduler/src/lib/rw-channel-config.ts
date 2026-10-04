import { db, inArray, subversiveRwChannelConfigs } from "@sentinel/database";
import { Logger } from "@sentinel/utils";

const logger = new Logger("Scheduler", "RwChannelConfig");

/**
 * How long a resolved channel selection is reused before re-reading it.
 *
 * The war cycle ticks every second during an active war, and this table has at
 * most one row per family faction, so re-reading it every tick would be pure
 * waste. Thirty seconds keeps the "admin just changed the channel" case
 * responsive without adding a second poll to the hot path.
 */
const CHANNEL_CONFIG_TTL_MS = 30_000;

/**
 * Both ranked-war channel selections for one faction.
 *
 * Read together in a single query so adding the secondary channel cost no extra
 * database round-trip: the primary and travel displays are always consulted on
 * the same cycle.
 */
export interface RwChannelSelection {
	primaryDisplaysChannelId: string | null;
	secondaryDisplaysChannelId: string | null;
}

type FactionSelections = Map<number, RwChannelSelection>;

let cachedSelections: FactionSelections | null = null;
let cachedAtMs = 0;

/**
 * Normalises a stored channel id.
 *
 * Empty strings are historically possible in these columns — the backfill
 * migration normalised them to NULL but the PUT handler does not validate, so
 * treat blank as unset rather than as a malformed snowflake the bot would try
 * to fetch.
 */
function normalise(value: string | null | undefined): string | null {
	return value?.trim() || null;
}

const EMPTY: RwChannelSelection = {
	primaryDisplaysChannelId: null,
	secondaryDisplaysChannelId: null,
};

/**
 * Reads both channel selections for every given faction.
 *
 * A faction with no row resolves to nulls (nothing selected), which is a normal
 * state rather than an error: the dashboard simply has not been configured for
 * it yet.
 *
 * A database failure resolves every faction to nulls and is deliberately **not**
 * cached, so the next cycle retries. Degrading to "no channel" is the safe
 * direction — the bot reads it as "tear down", which beats reposting into a
 * channel an admin may have just unselected.
 */
export async function resolveRwChannelSelections(
	factionIds: number[],
): Promise<FactionSelections> {
	if (factionIds.length === 0) return new Map();

	const now = Date.now();
	if (cachedSelections && now - cachedAtMs < CHANNEL_CONFIG_TTL_MS) {
		const out: FactionSelections = new Map();
		for (const factionId of factionIds) {
			out.set(factionId, cachedSelections.get(factionId) ?? EMPTY);
		}
		return out;
	}

	const selections: FactionSelections = new Map();
	try {
		const rows = await db
			.select({
				factionId: subversiveRwChannelConfigs.factionId,
				primaryDisplaysChannelId:
					subversiveRwChannelConfigs.primaryDisplaysChannelId,
				secondaryDisplaysChannelId:
					subversiveRwChannelConfigs.secondaryDisplaysChannelId,
			})
			.from(subversiveRwChannelConfigs)
			.where(inArray(subversiveRwChannelConfigs.factionId, factionIds));

		for (const row of rows) {
			selections.set(row.factionId, {
				primaryDisplaysChannelId: normalise(row.primaryDisplaysChannelId),
				secondaryDisplaysChannelId: normalise(row.secondaryDisplaysChannelId),
			});
		}

		cachedSelections = selections;
		cachedAtMs = now;
	} catch (err) {
		logger.warn("Failed to resolve ranked-war display channels:", err);
		return new Map(factionIds.map((id) => [id, EMPTY]));
	}

	return new Map(factionIds.map((id) => [id, selections.get(id) ?? EMPTY]));
}

/** Reads only the primary displays channel per faction. */
export async function resolvePrimaryDisplayChannels(
	factionIds: number[],
): Promise<Map<number, string | null>> {
	const selections = await resolveRwChannelSelections(factionIds);
	return new Map(
		factionIds.map((id) => [
			id,
			selections.get(id)?.primaryDisplaysChannelId ?? null,
		]),
	);
}

/** Reads only the secondary (travel) displays channel per faction. */
export async function resolveSecondaryDisplayChannels(
	factionIds: number[],
): Promise<Map<number, string | null>> {
	const selections = await resolveRwChannelSelections(factionIds);
	return new Map(
		factionIds.map((id) => [
			id,
			selections.get(id)?.secondaryDisplaysChannelId ?? null,
		]),
	);
}

/** Test seam: drops the memoised channel selection. */
export function resetRwChannelConfigCache(): void {
	cachedSelections = null;
	cachedAtMs = 0;
}
