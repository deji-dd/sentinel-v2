/**
 * Mercenary contract hit policy: the single definition of which attack results
 * earn a mercenary money, for each contract mode.
 *
 * This lives here, not in the scheduler worker, because the payout rule was
 * previously written out twice — once in the validator that credits live hits
 * (`merc-attack-validator-worker`) and once in the backfill script that
 * recovers missed ones — alongside a third hand-copied list of disqualifying
 * results. Three copies of the same business rule is how a backfill silently
 * pays a different rate than the live path.
 *
 * ## Modes
 *
 * - `hospitalize` (the original, and the default for every pre-existing
 *   contract): the mercenary lands the finishing hit. Only `Hospitalized`
 *   pays; every other landed result is still recorded, at $0.
 * - `assist`: the mercenary chips the target's life down and the client lands
 *   the finishing hit, so the mercenary's own attack is logged by Torn as
 *   `Assist`. `Assist` pays the standard hit price. A `Hospitalized` result
 *   means the mercenary finished the target themselves, which is not what was
 *   bought: it is recorded for the client's visibility but pays nothing.
 *
 * Assists are priced at the contract's standard `hitPrice` deliberately — an
 * assist is the standard unit of work in that mode, so it needs no separate
 * rate, and a `stricken` bonus can never apply to one (stricken is a
 * finishing-hit effect, and the mercenary is by definition not the finisher).
 *
 * ## What the live attack feed actually shows
 *
 * Verified against `/v2/faction/attacks` for the mercenary faction (a window of
 * 1,189 attacks, 18 of them assists — roughly 1.5%), so the assumptions above
 * rest on observed rows rather than on the API's enum alone:
 *
 *   - `Assist` is a real `result` value in the feed, and frequent enough to
 *     price as a primary outcome rather than an edge case.
 *   - Every one of those 18 assists carried `finishing_hit_effects: []`, so a
 *     stricken bonus genuinely cannot attach to an assist. The payout ignores
 *     `isStricken` for assists because the input is always empty.
 *   - Every one had `respect_gain: 0`. In the same window the only results that
 *     deal damage and earn no respect are assists: `Hospitalized` was 92/92
 *     respect-positive, `Attacked` 47/47, `Mugged` 184/186, `Special` 3/3.
 *   - The defender was factionless in 9 of the 18, so assists are ordinary;
 *     the other 9 were against factioned players, which is the shape a
 *     contract's target-faction match requires.
 *
 * ## Why eligibility keys on the mercenary's own result and nothing else
 *
 * A result string is mutually exclusive by construction, which the respect data
 * above confirms from an independent angle: `Assist` means the mercenary did not
 * land the finishing hit, and `Hospitalized` means they did. A mercenary who
 * finished the target is *never* reported as an assist — they are reported as
 * `Hospitalized`, with the respect to prove it — so there is no overlap to
 * disambiguate and no need to identify who actually landed the blow.
 *
 * That matters because the finisher is usually invisible to us anyway: the feed
 * covers the mercenary faction's own attacks, and the client's members (or any
 * other player who finishes the target) belong to a different faction, so their
 * finishing hit appears in some other faction's feed. In the sampled window not
 * one of the 18 assists had a matching `Hospitalized` on the same defender by
 * another member of the mercenary faction. A design that tried to verify "the
 * client finished it" would therefore be checking something unobtainable.
 *
 * One contract is also exactly one mode: `mode` is a single per-contract column
 * with no war-start override, and it is locked once the contract has started.
 * So the mode plus the mercenary's own result fully determine the payout, and
 * no cross-attack correlation is involved.
 */

/** How a mercenary earns on a contract. */
export type MercContractMode = "hospitalize" | "assist";

/** Every valid mode, for validation and UI enumeration. */
export const MERC_CONTRACT_MODES: readonly MercContractMode[] = [
	"hospitalize",
	"assist",
];

export const DEFAULT_MERC_CONTRACT_MODE: MercContractMode = "hospitalize";

/**
 * Narrows an arbitrary stored value to a known mode.
 *
 * Rows written before the `mode` column existed, and any row whose column is
 * somehow null, must read back as the original hospitalize behaviour rather
 * than as "unknown" — an unrecognised mode must never widen what gets paid.
 */
export function normalizeMercContractMode(
	value: string | null | undefined,
): MercContractMode {
	return value === "assist" ? "assist" : DEFAULT_MERC_CONTRACT_MODE;
}

/**
 * Attack results that represent no damage dealt at all, for the shared
 * "did this attack land?" question.
 *
 * `Assist` is listed here because an assist is not a finishing hit — this set
 * answers a different question from {@link isMercResultCreditable}, and it is
 * shared with the ranked-war hit counter, which must keep excluding assists.
 * Assist-mode contracts therefore opt in to the result explicitly rather than
 * by mutating this set.
 */
export const DISQUALIFYING_RESULTS: ReadonlySet<string> = new Set([
	"Lost",
	"Stalemate",
	"Escape",
	"Assist",
	"Interrupted",
	"Timeout",
]);

/**
 * Whether an attack result counts as damage actually dealt. A missing result
 * is not a landed hit: an attack we could not classify must never inflate a
 * member's tally.
 */
export function isLandedHit(result: string | null | undefined): boolean {
	if (!result) return false;
	return !DISQUALIFYING_RESULTS.has(result);
}

/**
 * Whether a hit should be *recorded* against a contract.
 *
 * A hospitalize-mode contract keeps the historical behaviour exactly: results
 * Torn does not classify as landed (including `Assist`) are not written at all,
 * while landed-but-unpaid results such as `Attacked` are written at $0 so the
 * client's receipt shows the attempt.
 *
 * An assist-mode contract additionally records `Assist`, which is the result it
 * exists to pay for.
 */
export function isMercResultCreditable(
	mode: MercContractMode,
	result: string | null | undefined,
): boolean {
	if (!result) return false;
	if (mode === "assist" && isAssistResult(result)) return true;
	return isLandedHit(result);
}

/** Case-insensitive match on Torn's `Assist` attack result. */
export function isAssistResult(result: string | null | undefined): boolean {
	return (result ?? "").toLowerCase() === "assist";
}

/** Case-insensitive match on Torn's `Hospitalized` attack result. */
export function isHospitalizedResult(
	result: string | null | undefined,
): boolean {
	return (result ?? "").toLowerCase() === "hospitalized";
}

export interface MercHitPayoutInput {
	mode: MercContractMode;
	result: string | null | undefined;
	/** The finishing hit carried the Stricken weapon bonus. */
	isStricken: boolean;
	/** Contract's standard per-hit rate. */
	hitPrice: number | null | undefined;
	/** Contract's premium rate for stricken finishing hits, if offered. */
	strickenHitPrice: number | null | undefined;
}

/**
 * The payout for a single hit, in dollars. Returns 0 for any hit the contract
 * does not pay for, which is a recordable outcome rather than an error.
 */
export function resolveMercHitPayout(input: MercHitPayoutInput): number {
	const { mode, result, isStricken, hitPrice, strickenHitPrice } = input;

	const standardPrice = hitPrice ?? 0;

	if (mode === "assist") {
		// The assist is the paid unit; a mercenary finishing the kill themselves
		// is not, but is still recorded so the client can see it happened.
		return isAssistResult(result) ? standardPrice : 0;
	}

	if (!isHospitalizedResult(result)) return 0;
	return isStricken && strickenHitPrice ? strickenHitPrice : standardPrice;
}

/**
 * Human-readable label for why a recorded hit paid nothing, for the mercenary
 * hit log. Returns null when the hit was paid.
 */
export function describeUnpaidMercHit(
	mode: MercContractMode,
	result: string | null | undefined,
): string | null {
	if (mode === "assist") {
		if (isAssistResult(result)) return null;
		if (isHospitalizedResult(result)) {
			return "No payout - mercenary finished the target instead of assisting";
		}
		return "No payout - not an assist";
	}
	if (isHospitalizedResult(result)) return null;
	return "No payout - not a hospitalization";
}
