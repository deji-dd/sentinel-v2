import { describe, expect, it } from "bun:test";

import {
	describeUnpaidMercHit,
	DISQUALIFYING_RESULTS,
	isAssistResult,
	isHospitalizedResult,
	isLandedHit,
	isMercResultCreditable,
	MERC_CONTRACT_MODES,
	normalizeMercContractMode,
	resolveMercHitPayout,
} from "../index";

const PRICE = 3_000_000;
const STRICKEN_PRICE = 4_000_000;

const payout = (
	overrides: Partial<Parameters<typeof resolveMercHitPayout>[0]> = {},
) =>
	resolveMercHitPayout({
		mode: "hospitalize",
		result: "Hospitalized",
		isStricken: false,
		hitPrice: PRICE,
		strickenHitPrice: STRICKEN_PRICE,
		...overrides,
	});

describe("normalizeMercContractMode", () => {
	it("defaults anything unrecognised to hospitalize", () => {
		expect(normalizeMercContractMode(null)).toBe("hospitalize");
		expect(normalizeMercContractMode(undefined)).toBe("hospitalize");
		expect(normalizeMercContractMode("")).toBe("hospitalize");
		expect(normalizeMercContractMode("nonsense")).toBe("hospitalize");
	});

	it("recognises assist regardless of how it was stored", () => {
		expect(normalizeMercContractMode("assist")).toBe("assist");
	});

	it("an unknown mode can never widen what is paid", () => {
		// The safety property that matters: an unrecognised stored value must
		// behave exactly like the original hospitalize contract.
		for (const unknown of [null, "ASSIST", "assists", "assist "]) {
			expect(payout({ mode: normalizeMercContractMode(unknown) })).toBe(PRICE);
		}
	});

	it("exposes exactly the two supported modes", () => {
		expect(MERC_CONTRACT_MODES).toEqual(["hospitalize", "assist"]);
	});
});

describe("resolveMercHitPayout - hospitalize mode keeps the original rule", () => {
	it("pays a standard hospitalization", () => {
		expect(payout()).toBe(PRICE);
	});

	it("pays the stricken rate for a stricken hospitalization", () => {
		expect(payout({ isStricken: true })).toBe(STRICKEN_PRICE);
	});

	it("falls back to the standard rate when no stricken rate is offered", () => {
		expect(payout({ isStricken: true, strickenHitPrice: null })).toBe(PRICE);
	});

	it("pays nothing for landed-but-unpaid results", () => {
		for (const result of ["Attacked", "Mugged", "Arrested", "Looted"]) {
			expect(payout({ result })).toBe(0);
		}
	});

	it("pays nothing for an assist", () => {
		expect(payout({ result: "Assist" })).toBe(0);
	});

	it("ignores a stricken flag on a result that does not pay", () => {
		expect(payout({ result: "Attacked", isStricken: true })).toBe(0);
	});
});

describe("resolveMercHitPayout - assist mode", () => {
	it("pays the standard hit price for an assist", () => {
		expect(payout({ mode: "assist", result: "Assist" })).toBe(PRICE);
	});

	it("pays nothing when the mercenary finishes the target themselves", () => {
		// The client's explicit instruction: record it so they can see the
		// mercenary overstepped, but do not charge for it.
		expect(payout({ mode: "assist", result: "Hospitalized" })).toBe(0);
	});

	it("pays nothing for an unpaid finishing hit even if stricken", () => {
		expect(
			payout({ mode: "assist", result: "Hospitalized", isStricken: true }),
		).toBe(0);
	});

	it("never applies a stricken premium to an assist", () => {
		// Stricken is a finishing-hit effect and an assist is not the finishing
		// hit, so the assist rate is always the plain standard rate.
		expect(payout({ mode: "assist", result: "Assist", isStricken: true })).toBe(
			PRICE,
		);
	});

	it("pays nothing for a chip that did not resolve as an assist", () => {
		for (const result of ["Attacked", "Mugged", "Lost", "Stalemate"]) {
			expect(payout({ mode: "assist", result })).toBe(0);
		}
	});

	it("treats a missing result as unpaid rather than defaulting to a hit", () => {
		expect(payout({ mode: "assist", result: null })).toBe(0);
		expect(payout({ result: null })).toBe(0);
	});
});

describe("isMercResultCreditable", () => {
	it("records an assist only for assist-mode contracts", () => {
		expect(isMercResultCreditable("assist", "Assist")).toBe(true);
		expect(isMercResultCreditable("hospitalize", "Assist")).toBe(false);
	});

	it("records a hospitalization for both modes", () => {
		expect(isMercResultCreditable("hospitalize", "Hospitalized")).toBe(true);
		expect(isMercResultCreditable("assist", "Hospitalized")).toBe(true);
	});

	it("records landed results that do not pay, so the client can see the attempt", () => {
		expect(isMercResultCreditable("hospitalize", "Attacked")).toBe(true);
		expect(isMercResultCreditable("assist", "Attacked")).toBe(true);
	});

	it("drops non-landed results for both modes", () => {
		for (const result of [
			"Lost",
			"Stalemate",
			"Escape",
			"Interrupted",
			"Timeout",
		]) {
			expect(isMercResultCreditable("hospitalize", result)).toBe(false);
			expect(isMercResultCreditable("assist", result)).toBe(false);
		}
	});

	it("never records a missing result", () => {
		expect(isMercResultCreditable("assist", null)).toBe(false);
		expect(isMercResultCreditable("assist", "")).toBe(false);
		expect(isMercResultCreditable("hospitalize", null)).toBe(false);
	});
});

describe("ranked-war hit counting is untouched by the assist mode", () => {
	it("keeps Assist out of the shared landed-hit definition", () => {
		// This set is shared with the ranked war hit counter. Making assists
		// payable for mercenary contracts must not leak into war tallies.
		expect(DISQUALIFYING_RESULTS.has("Assist")).toBe(true);
		expect(isLandedHit("Assist")).toBe(false);
	});

	it("still counts ordinary landed hits", () => {
		expect(isLandedHit("Hospitalized")).toBe(true);
		expect(isLandedHit("Attacked")).toBe(true);
		expect(isLandedHit(null)).toBe(false);
	});
});

describe("result matchers", () => {
	it("matches Torn's result strings case-insensitively", () => {
		expect(isAssistResult("Assist")).toBe(true);
		expect(isAssistResult("assist")).toBe(true);
		expect(isAssistResult("Assisted")).toBe(false);
		expect(isAssistResult(null)).toBe(false);

		expect(isHospitalizedResult("Hospitalized")).toBe(true);
		expect(isHospitalizedResult("hospitalized")).toBe(true);
		expect(isHospitalizedResult("Assist")).toBe(false);
		expect(isHospitalizedResult(undefined)).toBe(false);
	});
});

describe("describeUnpaidMercHit", () => {
	it("is null for a paid hit in either mode", () => {
		expect(describeUnpaidMercHit("hospitalize", "Hospitalized")).toBeNull();
		expect(describeUnpaidMercHit("assist", "Assist")).toBeNull();
	});

	it("explains an unpaid hit in terms of the mode's paid result", () => {
		expect(describeUnpaidMercHit("hospitalize", "Attacked")).toBe(
			"No payout - not a hospitalization",
		);
		expect(describeUnpaidMercHit("assist", "Attacked")).toBe(
			"No payout - not an assist",
		);
	});

	it("says outright when the mercenary finished the target instead of assisting", () => {
		expect(describeUnpaidMercHit("assist", "Hospitalized")).toBe(
			"No payout - mercenary finished the target instead of assisting",
		);
	});
});
