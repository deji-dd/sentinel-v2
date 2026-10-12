import { eq } from "drizzle-orm";
import { db } from "../../index";
import {
	PERSONAL_LIVE_STATE_ID,
	type PersonalLiveBarId,
	personalLiveBars,
	personalLiveStates,
} from "../schema/ledger";

/**
 * Persistence for the synced account's live state: bars, cooldowns, battle
 * stats and the raw money payload.
 *
 * Replaces the `personal:live_state` `system_states` blob. The four bars are
 * rows (they share one shape); everything else is a typed column on a singleton,
 * because the worker overwrites the whole snapshot every cycle.
 */

export interface PersonalLiveBar {
	current: number;
	maximum: number;
	increment: number;
	interval: number;
	fullTime: number;
}

export interface PersonalLiveStateData {
	bars: Record<PersonalLiveBarId, PersonalLiveBar>;
	cooldowns: { drug: number; medical: number; booster: number };
	/** Raw Torn money selection, kept verbatim. */
	money: Record<string, unknown>;
	battlestats: {
		strength: number;
		defense: number;
		speed: number;
		dexterity: number;
		total?: number;
	};
	lastSyncDurationMs: number | null;
}

const EMPTY_BAR: PersonalLiveBar = {
	current: 0,
	maximum: 0,
	increment: 0,
	interval: 0,
	fullTime: 0,
};

/** Reads the snapshot, or null when the worker has never synced. */
export async function loadPersonalLiveState(): Promise<PersonalLiveStateData | null> {
	const [rows, stateRow] = await Promise.all([
		db.select().from(personalLiveBars),
		db
			.select()
			.from(personalLiveStates)
			.where(eq(personalLiveStates.id, PERSONAL_LIVE_STATE_ID)),
	]);

	const state = stateRow[0];
	if (!state && rows.length === 0) return null;

	const bars = {
		energy: { ...EMPTY_BAR },
		nerve: { ...EMPTY_BAR },
		happy: { ...EMPTY_BAR },
		life: { ...EMPTY_BAR },
	} satisfies Record<PersonalLiveBarId, PersonalLiveBar>;

	for (const row of rows) {
		if (row.bar in bars) {
			bars[row.bar as PersonalLiveBarId] = {
				current: row.current,
				maximum: row.maximum,
				increment: row.increment,
				interval: row.interval,
				fullTime: row.fullTime,
			};
		}
	}

	return {
		bars,
		cooldowns: {
			drug: state?.drugCooldown ?? 0,
			medical: state?.medicalCooldown ?? 0,
			booster: state?.boosterCooldown ?? 0,
		},
		money: (state?.money ?? {}) as Record<string, unknown>,
		battlestats: {
			strength: state?.strength ?? 0,
			defense: state?.defense ?? 0,
			speed: state?.speed ?? 0,
			dexterity: state?.dexterity ?? 0,
			...(state?.totalStats !== null && state?.totalStats !== undefined
				? { total: state.totalStats }
				: {}),
		},
		lastSyncDurationMs: state?.lastSyncDurationMs ?? null,
	};
}

/**
 * Writes the snapshot.
 *
 * The whole snapshot is a per-cycle overwrite, so every column is written. Bars
 * are upserted individually rather than replaced, so a bar missing from the
 * payload keeps its previous values instead of silently resetting to zero.
 */
export async function savePersonalLiveState(
	data: PersonalLiveStateData,
): Promise<void> {
	const now = new Date();

	await db.transaction(async (tx) => {
		for (const [bar, values] of Object.entries(data.bars)) {
			await tx
				.insert(personalLiveBars)
				.values({ bar, ...values, createdAt: now, updatedAt: now })
				.onConflictDoUpdate({
					target: personalLiveBars.bar,
					set: { ...values, updatedAt: now },
				});
		}

		const shared = {
			drugCooldown: data.cooldowns.drug,
			medicalCooldown: data.cooldowns.medical,
			boosterCooldown: data.cooldowns.booster,
			strength: data.battlestats.strength,
			defense: data.battlestats.defense,
			speed: data.battlestats.speed,
			dexterity: data.battlestats.dexterity,
			totalStats: data.battlestats.total ?? null,
			lastSyncDurationMs: data.lastSyncDurationMs,
			money: data.money,
		};

		await tx
			.insert(personalLiveStates)
			.values({
				id: PERSONAL_LIVE_STATE_ID,
				...shared,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: personalLiveStates.id,
				set: { ...shared, updatedAt: now },
			});
	});
}
