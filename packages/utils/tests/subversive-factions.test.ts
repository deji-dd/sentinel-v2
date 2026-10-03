import { describe, expect, it } from "bun:test";
import {
	describeSubversiveFamilyFactions,
	getSubversiveFactionName,
	isPrimarySubversiveFaction,
	isSubversiveFamilyFaction,
	PRIMARY_SUBVERSIVE_FACTION_ID,
	resolveSubversiveFactionId,
	SUCCESSION_SUBVERSIVE_FACTION_ID,
} from "../src/subversive-factions";

describe("subversive faction family helpers", () => {
	it("treats 2013 and 27312 as family factions", () => {
		expect(isSubversiveFamilyFaction(PRIMARY_SUBVERSIVE_FACTION_ID)).toBe(true);
		expect(isSubversiveFamilyFaction(SUCCESSION_SUBVERSIVE_FACTION_ID)).toBe(
			true,
		);
		expect(isSubversiveFamilyFaction(9999)).toBe(false);
		expect(isSubversiveFamilyFaction(null)).toBe(false);
		expect(isSubversiveFamilyFaction(undefined)).toBe(false);
	});

	it("identifies the primary faction only", () => {
		expect(isPrimarySubversiveFaction(PRIMARY_SUBVERSIVE_FACTION_ID)).toBe(
			true,
		);
		expect(isPrimarySubversiveFaction(SUCCESSION_SUBVERSIVE_FACTION_ID)).toBe(
			false,
		);
	});

	it("falls back to the primary faction for unknown ids", () => {
		expect(resolveSubversiveFactionId(SUCCESSION_SUBVERSIVE_FACTION_ID)).toBe(
			SUCCESSION_SUBVERSIVE_FACTION_ID,
		);
		expect(resolveSubversiveFactionId(9999)).toBe(
			PRIMARY_SUBVERSIVE_FACTION_ID,
		);
		expect(resolveSubversiveFactionId(null)).toBe(
			PRIMARY_SUBVERSIVE_FACTION_ID,
		);
	});

	it("resolves display names", () => {
		expect(getSubversiveFactionName(PRIMARY_SUBVERSIVE_FACTION_ID)).toBe(
			"Subversive Alliance",
		);
		expect(getSubversiveFactionName(SUCCESSION_SUBVERSIVE_FACTION_ID)).toBe(
			"SA Succession",
		);
		expect(getSubversiveFactionName(null)).toBe("Subversive Alliance");
	});

	it("describes the family for access-denied messages", () => {
		expect(describeSubversiveFamilyFactions()).toBe(
			"2013 (Subversive Alliance) or 27312 (SA Succession)",
		);
	});
});
