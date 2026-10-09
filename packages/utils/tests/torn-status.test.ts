import { describe, expect, it } from "bun:test";
import {
	isAttackableInTorn,
	isHospitalStatus,
	isInTornHospital,
	TORN_STATE_ABROAD,
	TORN_STATE_HOSPITAL,
	TORN_STATE_OKAY,
	TORN_STATE_TRAVELING,
	tornStateSlug,
} from "../src/torn-status";

/** Builds the minimum status shape the classifier reads. */
function status(state: string, description: string) {
	return { state, description };
}

describe("isInTornHospital", () => {
	it("accepts a hospital stay in Torn", () => {
		expect(
			isInTornHospital(
				status(TORN_STATE_HOSPITAL, "In hospital for 3 hrs 12 mins"),
			),
		).toBe(true);
		expect(isInTornHospital(status(TORN_STATE_HOSPITAL, "In hospital"))).toBe(
			true,
		);
	});

	it("matches Torn's state casing loosely", () => {
		expect(isInTornHospital(status("hospital", "In hospital for 2 mins"))).toBe(
			true,
		);
		expect(isInTornHospital(status("HOSPITAL", "In hospital for 2 mins"))).toBe(
			true,
		);
	});

	it("rejects a hospital stay overseas", () => {
		// Torn keeps `state: "Hospital"` for these and names the foreign hospital
		// in the description; every sample below was observed on a live roster.
		const overseas = [
			"In a Japanese hospital for 24 mins",
			"In a Hawaiian hospital for 32 mins",
			"In an Emirati hospital for 34 mins",
			"In an Argentinian hospital for 11 mins",
			"In a Swiss hospital for 41 mins",
			"In a Chinese hospital for 23 mins",
			"In a Canadian hospital for 7 mins",
		];

		for (const description of overseas) {
			expect(isInTornHospital(status(TORN_STATE_HOSPITAL, description))).toBe(
				false,
			);
		}
	});

	it("rejects players who are not in a hospital at all", () => {
		expect(
			isInTornHospital(
				status(TORN_STATE_TRAVELING, "Traveling from Torn to China"),
			),
		).toBe(false);
		expect(
			isInTornHospital(
				status(TORN_STATE_TRAVELING, "Traveling from Japan to Torn"),
			),
		).toBe(false);
		expect(isInTornHospital(status(TORN_STATE_ABROAD, "In Japan"))).toBe(false);
		expect(isInTornHospital(status("Okay", "Okay"))).toBe(false);
		expect(isInTornHospital(status("Fallen", "Fallen"))).toBe(false);
	});

	it("rejects an airborne player even if a description mentions a hospital", () => {
		// `plane_image_type` is populated for Traveling players only, and a
		// traveler is never a hospital target however the text reads.
		expect(
			isInTornHospital(status(TORN_STATE_TRAVELING, "In hospital for 5 mins")),
		).toBe(false);
		expect(
			isInTornHospital(status(TORN_STATE_ABROAD, "In hospital for 5 mins")),
		).toBe(false);
	});

	it("keeps a hospital whose wording Torn changes", () => {
		// The overseas pattern is a deny-list: anything Torn words differently is
		// still treated as reachable, so a reworded domestic status cannot empty
		// the dibs board.
		expect(
			isInTornHospital(
				status(TORN_STATE_HOSPITAL, "In the hospital for 4 mins"),
			),
		).toBe(true);
		expect(
			isInTornHospital(status(TORN_STATE_HOSPITAL, "Recovering for 4 mins")),
		).toBe(true);
	});

	it("handles missing status objects", () => {
		expect(isInTornHospital(undefined)).toBe(false);
		expect(isInTornHospital(null)).toBe(false);
	});
});

describe("isAttackableInTorn", () => {
	it("accepts only a player standing free in Torn", () => {
		expect(isAttackableInTorn(status(TORN_STATE_OKAY, "Okay"))).toBe(true);
		expect(isAttackableInTorn(status("okay", "Okay"))).toBe(true);
	});

	it("rejects every state a member cannot reach from Torn", () => {
		// Including a hospital stay inside Torn: the ready pool asks whether the
		// target can be attacked right now, not whether a timer is running.
		const unreachable = [
			status(TORN_STATE_HOSPITAL, "In hospital for 6 mins"),
			status(TORN_STATE_HOSPITAL, "In a Japanese hospital for 24 mins"),
			status(TORN_STATE_TRAVELING, "Traveling from Torn to China"),
			status(TORN_STATE_ABROAD, "In Japan"),
			status("Jail", "In jail"),
			status("Federal", "Federal"),
			status("Fallen", "Fallen"),
		];

		for (const value of unreachable) {
			expect(isAttackableInTorn(value)).toBe(false);
		}
	});

	it("handles missing status objects", () => {
		expect(isAttackableInTorn(undefined)).toBe(false);
		expect(isAttackableInTorn(null)).toBe(false);
		expect(isAttackableInTorn({ state: null })).toBe(false);
	});
});

describe("isHospitalStatus", () => {
	it("reports a hospital stay wherever the hospital is", () => {
		expect(isHospitalStatus(status(TORN_STATE_HOSPITAL, "In hospital"))).toBe(
			true,
		);
		expect(
			isHospitalStatus(
				status(TORN_STATE_HOSPITAL, "In an Emirati hospital for 34 mins"),
			),
		).toBe(true);
		expect(isHospitalStatus(status("hospital", "In hospital"))).toBe(true);
	});

	it("reports every other state as not hospitalised", () => {
		expect(isHospitalStatus(status(TORN_STATE_OKAY, "Okay"))).toBe(false);
		expect(
			isHospitalStatus(
				status(TORN_STATE_TRAVELING, "Traveling from Torn to Japan"),
			),
		).toBe(false);
		expect(isHospitalStatus(status(TORN_STATE_ABROAD, "In Japan"))).toBe(false);
		expect(isHospitalStatus(undefined)).toBe(false);
		expect(isHospitalStatus({ state: null })).toBe(false);
	});
});

describe("tornStateSlug", () => {
	it("lowercases the state Torn reported", () => {
		expect(tornStateSlug(status(TORN_STATE_OKAY, "Okay"))).toBe("okay");
		expect(tornStateSlug(status(TORN_STATE_HOSPITAL, "In hospital"))).toBe(
			"hospital",
		);
		expect(
			tornStateSlug(
				status(TORN_STATE_TRAVELING, "Traveling from Torn to China"),
			),
		).toBe("traveling");
		expect(tornStateSlug(status(TORN_STATE_ABROAD, "In Japan"))).toBe("abroad");
		expect(tornStateSlug(status("Jail", "In jail"))).toBe("jail");
	});

	it("falls back to other when Torn reported nothing usable", () => {
		expect(tornStateSlug(undefined)).toBe("other");
		expect(tornStateSlug(null)).toBe("other");
		expect(tornStateSlug({ state: "   " })).toBe("other");
		expect(tornStateSlug({ state: null })).toBe("other");
	});
});
