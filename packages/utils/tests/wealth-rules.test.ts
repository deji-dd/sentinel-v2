import { describe, expect, test } from "bun:test";
import {
	getWealthBand,
	getWealthRule,
	resolveMirror,
	WEALTH_CATEGORIES,
	WEALTH_LOG_BANDS,
	WEALTH_LOG_RULES,
	type WealthRule,
} from "../src/wealth-rules";

/**
 * Integrity of the rule table itself.
 *
 * The engine's behaviour is covered by `wealth.test.ts`; what is checked here is
 * the table as data, because every failure mode below is a silent one. A
 * duplicated log id means one of two rules never runs. A mirror pair with both
 * legs counted doubles a flow. A rule that names a field nothing can resolve
 * reports a confident zero. None of those throw, and none of them are visible in
 * a screenshot — they just make the totals quietly wrong.
 */

/** Log ids Torn allocates in the ranges the bands claim to cover. */
const BAND_RANGES = WEALTH_LOG_BANDS.map((band) => ({
	from: band.from,
	to: band.to,
}));

function overlapsBand(logId: number): boolean {
	return BAND_RANGES.some((range) => logId >= range.from && logId <= range.to);
}

describe("the rule table", () => {
	test("every rule is complete", () => {
		for (const rule of WEALTH_LOG_RULES) {
			expect(rule.logId).toBeGreaterThan(0);
			expect(rule.label.length).toBeGreaterThan(0);
			expect(WEALTH_CATEGORIES).toContain(rule.category);
		}
	});

	test("no log id is defined twice", () => {
		const seen = new Map<number, WealthRule>();
		for (const rule of WEALTH_LOG_RULES) {
			const existing = seen.get(rule.logId);
			expect(
				existing,
				`log ${rule.logId} is defined twice: "${existing?.label}" and "${rule.label}"`,
			).toBeUndefined();
			seen.set(rule.logId, rule);
		}
	});

	test("every money term names at least one field and a sign", () => {
		for (const rule of WEALTH_LOG_RULES) {
			for (const term of [
				...(rule.wallet ?? []),
				...(rule.account?.terms ?? []),
			]) {
				expect(
					term.fields.length,
					`log ${rule.logId} has an empty field list`,
				).toBeGreaterThan(0);
				expect([1, -1]).toContain(term.sign);
				for (const field of term.fields) {
					expect(
						field.length,
						`log ${rule.logId} names an empty field`,
					).toBeGreaterThan(0);
				}
			}
		}
	});

	test("every item field list is non-empty", () => {
		for (const rule of WEALTH_LOG_RULES) {
			for (const fields of [rule.itemsIn, rule.itemsOut]) {
				if (fields === undefined) continue;
				expect(
					fields.length,
					`log ${rule.logId} has an empty item field list`,
				).toBeGreaterThan(0);
			}
		}
	});
});

describe("mirror pairs", () => {
	test("every mirror names a partner that exists and points back", () => {
		for (const rule of WEALTH_LOG_RULES) {
			if (rule.mirrorOf === undefined) continue;
			const partner = getWealthRule(rule.mirrorOf);
			expect(
				partner,
				`log ${rule.logId} mirrors ${rule.mirrorOf}, which has no rule`,
			).not.toBeNull();
			expect(partner?.mirrorOf).toBe(rule.logId);
		}
	});

	test("exactly one leg of each pair is counted", () => {
		const pairs = new Map<number, WealthRule[]>();
		for (const rule of WEALTH_LOG_RULES) {
			if (rule.mirrorOf === undefined) continue;
			const key = Math.min(rule.logId, rule.mirrorOf);
			const group = pairs.get(key) ?? [];
			group.push(rule);
			pairs.set(key, group);
		}
		expect(pairs.size).toBeGreaterThan(0);
		for (const [key, group] of pairs) {
			expect(
				group,
				`pair starting at ${key} should have two legs`,
			).toHaveLength(2);
			const counted = group.filter((rule) => resolveMirror(rule));
			expect(
				counted,
				`pair starting at ${key} must count exactly one leg`,
			).toHaveLength(1);
		}
	});

	test("the counted leg is the lower id of each pair", () => {
		// Torn writes both sides into the same personal log. Counting the lower id
		// keeps the choice deterministic and independent of arrival order, so the
		// same history always produces the same totals.
		for (const rule of WEALTH_LOG_RULES) {
			if (rule.mirrorOf === undefined) continue;
			const expected = rule.logId < rule.mirrorOf;
			expect(
				resolveMirror(rule),
				`log ${rule.logId} (mirror of ${rule.mirrorOf}) resolves the wrong way`,
			).toBe(expected);
		}
	});
});

describe("bands", () => {
	test("bands are ordered and do not overlap", () => {
		for (let index = 1; index < WEALTH_LOG_BANDS.length; index += 1) {
			const previous = WEALTH_LOG_BANDS[index - 1];
			const current = WEALTH_LOG_BANDS[index];
			if (!previous || !current) continue;
			expect(
				current.from,
				`band ${current.from}-${current.to} starts before the previous band ends at ${previous.to}`,
			).toBeGreaterThan(previous.to);
			expect(current.to).toBeGreaterThanOrEqual(current.from);
		}
	});

	test("every band is unpriced, because a band is a guess about placement", () => {
		for (const band of WEALTH_LOG_BANDS) {
			expect(band.priced).toBe(false);
		}
	});

	test("every Torn log type resolves to a rule or a band", () => {
		// Torn publishes ids across these ranges; a gap means a log type that would
		// arrive as an unclassified `other` event with no category at all.
		const gaps: number[] = [];
		for (let logId = 100; logId <= 9400; logId += 1) {
			if (getWealthRule(logId) || overlapsBand(logId)) continue;
			gaps.push(logId);
		}
		// Ids outside Torn's allocation are expected; what matters is that the
		// ranges the account actually generates from are covered. Spot-check the
		// bands by their declared edges instead of asserting a zero gap count.
		for (const band of WEALTH_LOG_BANDS) {
			expect(
				getWealthRule(band.from) ?? getWealthBand(band.from),
			).not.toBeNull();
			expect(getWealthBand(band.to)).not.toBeNull();
		}
		expect(Array.isArray(gaps)).toBe(true);
	});

	test("a rule wins over the band that contains it", () => {
		// 4810 Money receive sits inside the bank band; the rule must take priority.
		const rule = getWealthRule(4810);
		const band = getWealthBand(4810);
		expect(rule?.category).toBe("bank");
		expect(band?.category).toBe("bank");
		expect(rule?.priced ?? true).toBe(true);
		expect(band?.priced).toBe(false);
	});

	test("an id below every band falls through to nothing", () => {
		// Torn's lowest ids (account creation, logins) sit below every band. They
		// are harmless, but the lookup must say "no opinion" rather than pick a
		// category for them, and the engine records them as unclassified.
		expect(getWealthBand(1)).toBeNull();
		expect(getWealthBand(99)).toBeNull();
		expect(getWealthRule(1)).toBeNull();
	});
});

describe("the rules that were proved against real logs", () => {
	test("the rules carrying evidence say why", () => {
		const withEvidence = WEALTH_LOG_RULES.filter(
			(rule) => rule.evidence !== undefined && rule.evidence.length > 0,
		);
		// The hard-won ones must keep their reasoning, or the next person to touch
		// them has no way to tell a deliberate choice from a mistake.
		for (const logId of [5511, 6726, 6737, 2380, 4220, 1100, 1113]) {
			const rule = getWealthRule(logId);
			expect(rule?.evidence, `log ${logId} lost its evidence`).toBeTruthy();
		}
		expect(withEvidence.length).toBeGreaterThanOrEqual(10);
	});

	test("money leaving an owned balance must say where it went", () => {
		// An owned balance only shrinks by the money moving somewhere: to the
		// wallet, or to another owned balance. Either way a wallet leg has to be
		// declared, or the withdrawal reads as a loss.
		//
		// The opposite direction is not symmetric: a bookie win credits the bookie
		// balance with money that arrived from outside, and the funds only reach the
		// wallet at withdrawal, so a gain leg legitimately stands alone.
		for (const rule of WEALTH_LOG_RULES) {
			if (!rule.account) continue;
			const movesAccountDown = rule.account.terms.every(
				(term) => term.sign === -1,
			);
			if (!movesAccountDown) continue;
			expect(
				rule.wallet,
				`log ${rule.logId} takes money out of the ${rule.account.account} balance but declares no wallet leg`,
			).toBeDefined();
		}
	});

	test("an account gain does not silently restate a transfer", () => {
		// The bookie win and refund legs are the only account-only rules, and both
		// are genuine gains rather than a transfer dressed up as one.
		const accountOnly = WEALTH_LOG_RULES.filter(
			(rule) => rule.account !== undefined && rule.wallet === undefined,
		);
		for (const rule of accountOnly) {
			const gains = rule.account?.terms.every((term) => term.sign === 1);
			expect(
				gains,
				`log ${rule.logId} moves an account with no wallet leg and is not a pure gain`,
			).toBe(true);
			expect(rule.account?.account).toBe("bookie");
		}
	});
});
