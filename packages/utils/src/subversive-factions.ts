/**
 * Subversive family faction definitions.
 *
 * The Subversive toolchain (target-finder userscript, ranked war scheduler,
 * recruitment scanner, mercenary contracts) is available to every faction in
 * the family. Faction 2013 (Subversive Alliance) is the primary faction and is
 * used as the default/fallback whenever a faction id is unknown (for example
 * rows written before the `faction_id` column existed).
 */

export const PRIMARY_SUBVERSIVE_FACTION_ID = 2013;

export const SUBVERSIVE_FACTION_ID = PRIMARY_SUBVERSIVE_FACTION_ID;

/** Second family faction: SA Succession. */
export const SUCCESSION_SUBVERSIVE_FACTION_ID = 27312;

export const SUBVERSIVE_FAMILY_FACTION_IDS: readonly number[] = [
	PRIMARY_SUBVERSIVE_FACTION_ID,
	SUCCESSION_SUBVERSIVE_FACTION_ID,
];

export const SUBVERSIVE_FACTION_NAMES: Readonly<Record<number, string>> = {
	[PRIMARY_SUBVERSIVE_FACTION_ID]: "Subversive Alliance",
	[SUCCESSION_SUBVERSIVE_FACTION_ID]: "SA Succession",
};

export function isSubversiveFamilyFaction(
	factionId: number | null | undefined,
): boolean {
	if (!factionId) return false;
	return SUBVERSIVE_FAMILY_FACTION_IDS.includes(factionId);
}

export function isPrimarySubversiveFaction(
	factionId: number | null | undefined,
): boolean {
	return factionId === PRIMARY_SUBVERSIVE_FACTION_ID;
}

/**
 * Normalizes an optional/unknown faction id to a family faction.
 * Unknown values fall back to the primary faction (2013) so legacy rows and
 * sessions without faction data keep working.
 */
export function resolveSubversiveFactionId(
	factionId: number | null | undefined,
): number {
	return isSubversiveFamilyFaction(factionId)
		? (factionId as number)
		: PRIMARY_SUBVERSIVE_FACTION_ID;
}

export function getSubversiveFactionName(
	factionId: number | null | undefined,
): string {
	const resolved = resolveSubversiveFactionId(factionId);
	return SUBVERSIVE_FACTION_NAMES[resolved] ?? `Faction ${resolved}`;
}

/**
 * Human readable list used in auth/access-denied messages.
 * e.g. "2013 (Subversive Alliance) or 27312 (SA Succession)"
 */
export function describeSubversiveFamilyFactions(): string {
	return SUBVERSIVE_FAMILY_FACTION_IDS.map(
		(id) => `${id} (${SUBVERSIVE_FACTION_NAMES[id] ?? `Faction ${id}`})`,
	).join(" or ");
}
