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

export type SubversiveFamilyFaction =
	(typeof SUBVERSIVE_FAMILY_FACTIONS)[number];
