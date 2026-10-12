/**
 * Family factions that can run the Subversive tooling with their own settings.
 *
 * Mirrors `SUBVERSIVE_FAMILY_FACTION_IDS` on the API. Kept in one place so a new
 * page cannot drift from the others on names or ids.
 */
export const SUBVERSIVE_FAMILY_FACTIONS = [
	{ id: 2013, name: "Subversive Alliance" },
	{ id: 27312, name: "SA Succession" },
] as const;

/** Mirrors `PRIMARY_SUBVERSIVE_FACTION_ID` on the API: the default faction. */
export const PRIMARY_SUBVERSIVE_FACTION_ID = 2013;

export type SubversiveFamilyFaction =
	(typeof SUBVERSIVE_FAMILY_FACTIONS)[number];

/** Display name for a family faction id, falling back to the raw id. */
export function getSubversiveFactionName(factionId?: number | null): string {
	if (!factionId) return "Subversive family";
	const match = SUBVERSIVE_FAMILY_FACTIONS.find((f) => f.id === factionId);
	return match?.name ?? `Faction ${factionId}`;
}
