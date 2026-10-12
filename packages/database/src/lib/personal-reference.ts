import { eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../../index";
import {
	PERSONAL_REFERENCE_SUMMARY_ID,
	personalGymUnlocks,
	personalPerks,
	personalReferenceSummaries,
} from "../schema/ledger";

/**
 * Persistence for the personal reference sync: the account's unlocked perks and
 * gyms.
 *
 * Both used to be single `system_states` JSON blobs. The perks blob was the
 * worse of the two — it stored every perk string twice, once in a flat
 * `allPerks` array and again inside `categorizedPerks` — so this module derives
 * `allPerks` from the rows instead, and both lists are now queryable rather than
 * loaded wholesale.
 *
 * The scalar rollups (travel modifiers, best gym per stat) live in one typed
 * singleton row because they come from the same worker and are derived rather
 * than raw.
 */

export interface PersonalTravelPerks {
	hasAirstrip: boolean;
	hasWltBenefit: boolean;
	hasBookPerk: boolean;
	factionTravelReduction: number;
	totalTravelReduction: number;
}

export interface PersonalPerksData {
	/** Every unlocked perk, flattened from `categorizedPerks`. */
	allPerks: string[];
	categorizedPerks: Record<string, string[]>;
	travelPerks: PersonalTravelPerks;
	/** Epoch SECONDS the perk list was fetched. */
	timestamp: number;
}

export interface PersonalGymUnlocksData {
	strengthGym: number;
	defenseGym: number;
	speedGym: number;
	dexterityGym: number;
	unlockedGymIds: number[];
	/** Epoch SECONDS the gym unlocks were fetched. */
	timestamp: number;
}

/** Reads the perk list plus the travel rollup, or null when never synced. */
export async function loadPersonalPerks(): Promise<PersonalPerksData | null> {
	const [rows, summary] = await Promise.all([
		db.select().from(personalPerks),
		getReferenceSummary(),
	]);

	if (rows.length === 0 && !summary?.perksFetchedAt) return null;

	const categorizedPerks: Record<string, string[]> = {};
	const allPerks: string[] = [];
	for (const row of rows) {
		allPerks.push(row.perk);
		const bucket = categorizedPerks[row.category];
		if (bucket) {
			bucket.push(row.perk);
		} else {
			categorizedPerks[row.category] = [row.perk];
		}
	}

	return {
		allPerks,
		categorizedPerks,
		travelPerks: {
			hasAirstrip: summary?.hasAirstrip ?? false,
			hasWltBenefit: summary?.hasWltBenefit ?? false,
			hasBookPerk: summary?.hasBookPerk ?? false,
			factionTravelReduction: summary?.factionTravelReduction ?? 0,
			totalTravelReduction: summary?.totalTravelReduction ?? 0,
		},
		timestamp: summary?.perksFetchedAt ?? 0,
	};
}

/**
 * Writes the perk list, touching only rows that changed.
 *
 * Perks are removed from Torn's list when a perk expires, so rows absent from
 * the new set are deleted rather than left behind.
 */
export async function savePersonalPerks(
	data: PersonalPerksData,
): Promise<void> {
	const entries = Object.entries(data.categorizedPerks).flatMap(
		([category, perks]) => perks.map((perk) => ({ perk, category })),
	);
	const keep = entries.map((entry) => entry.perk);
	const now = new Date();

	await db.transaction(async (tx) => {
		if (keep.length > 0) {
			await tx
				.delete(personalPerks)
				.where(notInArray(personalPerks.perk, keep));
		} else {
			await tx.delete(personalPerks);
		}

		for (const entry of entries) {
			await tx
				.insert(personalPerks)
				.values({ ...entry, createdAt: now, updatedAt: now })
				.onConflictDoUpdate({
					target: personalPerks.perk,
					set: { category: entry.category, updatedAt: now },
				});
		}
	});

	await upsertReferenceSummary({
		perksFetchedAt: data.timestamp,
		hasAirstrip: data.travelPerks.hasAirstrip,
		hasBookPerk: data.travelPerks.hasBookPerk,
		hasWltBenefit: data.travelPerks.hasWltBenefit,
		factionTravelReduction: data.travelPerks.factionTravelReduction,
		totalTravelReduction: data.travelPerks.totalTravelReduction,
	});
}

/** Reads the unlocked gym list plus the best-gym rollup, or null when never synced. */
export async function loadPersonalGymUnlocks(): Promise<PersonalGymUnlocksData | null> {
	const [rows, summary] = await Promise.all([
		db.select().from(personalGymUnlocks),
		getReferenceSummary(),
	]);

	if (rows.length === 0 && !summary?.gymsFetchedAt) return null;

	return {
		unlockedGymIds: rows.map((row) => row.gymId),
		strengthGym: summary?.strengthGym ?? 0,
		defenseGym: summary?.defenseGym ?? 0,
		speedGym: summary?.speedGym ?? 0,
		dexterityGym: summary?.dexterityGym ?? 0,
		timestamp: summary?.gymsFetchedAt ?? 0,
	};
}

/** Writes the unlocked gym list, touching only rows that changed. */
export async function savePersonalGymUnlocks(
	data: PersonalGymUnlocksData,
): Promise<void> {
	const keep = [...new Set(data.unlockedGymIds)].filter((id) =>
		Number.isFinite(id),
	);
	const now = new Date();

	await db.transaction(async (tx) => {
		if (keep.length > 0) {
			await tx
				.delete(personalGymUnlocks)
				.where(notInArray(personalGymUnlocks.gymId, keep));
		} else {
			await tx.delete(personalGymUnlocks);
		}

		if (keep.length > 0) {
			const existing = await tx
				.select({ gymId: personalGymUnlocks.gymId })
				.from(personalGymUnlocks)
				.where(inArray(personalGymUnlocks.gymId, keep));
			const known = new Set(existing.map((row) => row.gymId));
			const missing = keep.filter((id) => !known.has(id));
			if (missing.length > 0) {
				await tx
					.insert(personalGymUnlocks)
					.values(
						missing.map((gymId) => ({
							gymId,
							createdAt: now,
							updatedAt: now,
						})),
					)
					.onConflictDoNothing();
			}
		}
	});

	await upsertReferenceSummary({
		gymsFetchedAt: data.timestamp,
		strengthGym: data.strengthGym,
		defenseGym: data.defenseGym,
		speedGym: data.speedGym,
		dexterityGym: data.dexterityGym,
	});
}

async function getReferenceSummary() {
	const [row] = await db
		.select()
		.from(personalReferenceSummaries)
		.where(eq(personalReferenceSummaries.id, PERSONAL_REFERENCE_SUMMARY_ID));
	return row ?? null;
}

/**
 * Upserts the scalar rollup.
 *
 * Only the fields named by the caller are written, so the perks sync does not
 * clear the gym rollup and vice versa.
 */
async function upsertReferenceSummary(
	patch: Partial<typeof personalReferenceSummaries.$inferInsert>,
): Promise<void> {
	const now = new Date();
	await db
		.insert(personalReferenceSummaries)
		.values({
			id: PERSONAL_REFERENCE_SUMMARY_ID,
			...patch,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: personalReferenceSummaries.id,
			set: { ...patch, updatedAt: now },
		});
}
