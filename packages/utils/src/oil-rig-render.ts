import type {
	CompanyDirectives,
	CompanyUpgradeAdvice,
	CompanyUpgradeCategory,
} from "../../schemas/src/company";
import type { OilRigAnalysis } from "./oil-rig-analysis";
import { OIL_RIG_POLICY } from "./oil-rig-policy";

/**
 * Rendering for the director briefing, kept separate from loading and delivery.
 *
 * Everything the brief says is rendered here from the engines. There is no model
 * in the loop: the advice, the capacity plan and the week-to-date figures all
 * come from the same `OilRigAnalysis`, so two surfaces cannot contradict each
 * other.
 */

/**
 * Stable signature of the deterministic advice.
 *
 * Used to tell the director "no change since <date>" instead of re-issuing
 * identical advice as if it were a fresh demand.
 */
export function adviceSignature(directives: CompanyDirectives): string {
	const canonical = JSON.stringify({
		transfers: directives.roleTransfers
			.map((t) => `${t.name}>${t.toRole}`)
			.sort(),
		capacity: [
			directives.capacityRebalance.state,
			directives.capacityRebalance.regime.regime,
			directives.capacityRebalance.hires,
			directives.capacityRebalance.discardedBarrelsPerDay,
		],
		pricing: [directives.pricing.action, directives.pricing.exact],
		advertising: [directives.adSpend.action, directives.adSpend.amount],
		rehab: [
			...directives.rehabTiers.tier1,
			...directives.rehabTiers.tier2,
			...directives.rehabTiers.tier3,
		]
			.map((t) => `${t.name}:${t.penalty}`)
			.sort(),
		inventory: directives.stock.state,
		upgrades: directives.upgrades.recommendations
			.map(
				(recommendation) =>
					`${recommendation.category}:${recommendation.nextTier}>${recommendation.targetTier}:${recommendation.nextCost}:${recommendation.priority}`,
			)
			.sort(),
	});
	return fnv1a(canonical);
}

/** FNV-1a, so the signature is stable across runtimes and dependency-free. */
function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

export interface DeterministicBriefing {
	/** The authoritative advice markdown. */
	advice: string;
	signature: string;
	actionText: string;
	stockBullets: string[];
	/** True when the advice differs from the previously issued brief. */
	changed: boolean;
}

/**
 * Discord's hard content limit is 2000 characters. Chunks are kept below it with
 * headroom so a stray character can never push a message over and truncate it.
 */
export const DISCORD_MESSAGE_LIMIT = 2000;
export const DISCORD_SAFE_LIMIT = 1900;

function formatMoney(value: number): string {
	return `$${Math.round(value).toLocaleString()}`;
}

/** Short money for inline prose: $16.4M, $250k, $940. */
function formatMoneyShort(value: number): string {
	const abs = Math.abs(value);
	const sign = value < 0 ? "-" : "";
	if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
	if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`;
	return `${sign}$${Math.round(abs)}`;
}

/**
 * Splits rendered markdown into Discord messages without ever truncating.
 *
 * The previous delivery sliced the advice at 4,000 characters for an embed
 * description, which silently cut the brief mid-sentence and dropped the rest of
 * the analysis. Plain messages have a 2,000-character limit but can be sent in
 * as many parts as needed, so nothing is lost.
 *
 * Splitting happens on line boundaries, and a chunk boundary inside a code block
 * closes the fence and reopens it in the next message so the week-to-date table
 * cannot be corrupted.
 */
export function splitDiscordMessages(
	text: string,
	limit = DISCORD_SAFE_LIMIT,
): string[] {
	const messages: string[] = [];
	let inFence = false;
	let current: string[] = [];
	let currentLength = 0;

	const flush = () => {
		if (current.length === 0) return;
		const body = current.join("\n");
		messages.push(inFence ? `${body}\n\`\`\`` : body);
		// Reopen the fence so the continuation still renders as code.
		current = inFence ? ["```"] : [];
		currentLength = inFence ? 3 : 0;
	};

	const push = (line: string) => {
		const added = current.length === 0 ? line.length : line.length + 1;
		if (currentLength + added > limit && current.length > 0) flush();
		current.push(line);
		currentLength += current.length === 1 ? line.length : line.length + 1;
	};

	for (const rawLine of text.split("\n")) {
		// A single line longer than the limit cannot be placed at all, so it is
		// hard-split rather than allowed to overflow.
		if (rawLine.length > limit) {
			for (let i = 0; i < rawLine.length; i += limit) {
				push(rawLine.slice(i, i + limit));
				flush();
			}
			continue;
		}
		push(rawLine);
		if (rawLine.trim().startsWith("```")) inFence = !inFence;
	}

	if (current.length > 0) {
		const body = current.join("\n");
		const final = inFence ? `${body}\n\`\`\`` : body;
		// A chunk that is nothing but a reopened fence carries no content.
		if (final.trim() !== "```") messages.push(final);
	}

	return messages.map((m) => m.trim()).filter((m) => m.length > 0);
}

/** `Name (-8), Other (-6)` — compact, and no repeated unit on every entry. */
function rehabList(entries: Array<{ name: string; penalty: number }>): string {
	return entries.map((e) => `${e.name} (${e.penalty})`).join(", ");
}

/**
 * Target lineup, with the singleton roles collapsed onto one line.
 *
 * Six one-entry lines said nothing that four lines do not, and the brief is read
 * on a phone.
 */
function renderLineup(rosterByRole: Record<string, string[]>): string {
	const roles = Object.keys(rosterByRole).sort();
	const majors = roles.filter((role) => (rosterByRole[role]?.length ?? 0) > 1);
	const minors = roles.filter(
		(role) => (rosterByRole[role]?.length ?? 0) === 1,
	);

	const lines = majors.map(
		(role) =>
			`• **${role}** (${rosterByRole[role]?.length ?? 0}): ${(rosterByRole[role] ?? []).join(" · ")}`,
	);
	if (minors.length > 0) {
		const names = minors.flatMap((role) => rosterByRole[role] ?? []);
		lines.push(`• **${minors.join(" · ")}**: ${names.join(" · ")}`);
	}
	return lines.join("\n");
}

/**
 * The capacity story, told once.
 *
 * The previous rendering stated the same fact up to four times: the discarded
 * volume appeared under "Discarded Output" and again inside the holding summary,
 * the storage level appeared under both "Storage Status" and the structural
 * constraint, and the regime line restated the storage level a third time. Each
 * line below now carries one fact.
 */
function renderCapacity(analysis: OilRigAnalysis): string[] {
	const d = analysis.directives;
	const plan = d.capacityRebalance;
	const lines: string[] = [];
	// The flow sentence below describes the direction storage is moving NOW, and it
	// sits beside a net figure the drain model took from the newest measured day.
	// Quoting the multi-day median here put two different days in one sentence:
	// "sales 332,886 vs extraction 321,560 bbl/day, so storage is falling" was
	// printed beside a net that had been measured as storage RISING 62,138 bbl.
	const production = analysis.stock.production;
	const produced = production.latestMeasured ?? production.dailyProduced;
	const sold = analysis.decision.dailySold;
	const draining = analysis.stock.netDrainPerDay !== undefined;

	if (plan.extractionBound) {
		if (draining) {
			// The regime can be held while the constraint has already eased, so the
			// state must be described from the CURRENT flow, not from the regime flag.
			// Saying "cannot drain" beside sales outstripping extraction by 63% was
			// simply false.
			lines.push(
				`• **Draining** — sales ${sold.toLocaleString()} vs extraction ${
					produced !== undefined ? produced.toLocaleString() : "unmeasured"
				} bbl/day, so storage is falling about ${analysis.stock.netDrainPerDay?.toLocaleString()} bbl/day (now ${d.stock.fillPct}% full).`,
			);
		} else {
			const flow =
				produced !== undefined
					? `extraction ${produced.toLocaleString()} vs sales ${sold.toLocaleString()} bbl/day`
					: `sales ${sold.toLocaleString()} bbl/day, with extraction unmeasured`;
			lines.push(
				`• **Cannot drain** — storage is ${d.stock.fillPct}% full, and ${flow}.`,
			);
		}

		// A loss is only reported while one is actually happening, and only where one
		// can happen at all.
		//
		// The first branch is genuinely present-tense: the plan zeroes
		// `discardedBarrelsPerDay` unless the warehouse is at its cap AND filling.
		// The two branches after it keyed off HISTORICAL cap evidence alone, so on a
		// held extraction-bound regime at 65% fill they asserted a present loss and
		// said storage was "pinned at the cap" when it was nowhere near it. A rig
		// with room left is storing its excess, not throwing it away; the loss begins
		// when storage reaches the cap. Old evidence about past capped days still
		// supports a number, but only once the cap is binding again.
		const atCap = d.stock.warehouseCritical;

		if (plan.discardedBarrelsPerDay > 0) {
			lines.push(
				`• **Losing ~${plan.discardedBarrelsPerDay.toLocaleString()} bbl/day** (~${formatMoneyShort(plan.discardedValuePerDay)}/day) to the cap.`,
			);
		} else if (atCap && !draining && plan.discardedCappedLowerBound > 0) {
			lines.push(
				`• **Losing at least ~${plan.discardedCappedLowerBound.toLocaleString()} bbl/day** — a lower bound, because on days storage sat at the cap the stock delta was clamped, so the excess above the sales rate could not be measured.`,
			);
		} else if (atCap && !draining) {
			lines.push(
				"• **Loss cannot be sized** while storage is pinned at the cap: a full warehouse clamps the stock delta to zero.",
			);
		} else if (!draining) {
			// Filling, with room left. Reporting a sized loss here would be inventing
			// one; reporting nothing would leave the capacity section silent about
			// cost, which is the question it exists to answer. The fill level is NOT
			// restated, because the flow line directly above already states it.
			lines.push(
				`• **Nothing lost yet** — the excess above the sales rate is being stored. Barrels begin to be discarded at ${OIL_RIG_POLICY.inventory.criticalEnterPct}% full.`,
			);
		}

		if (plan.state === "action_required") {
			for (const item of plan.actions) {
				const label =
					item.kind === "rebalance"
						? "Rebalance"
						: item.kind === "hire"
							? `Hire ${plan.hires}× Sales Executive`
							: "Storage is not the fix";
				lines.push(`• **${label}:** ${item.reason}`);
			}
		} else if (plan.deferred) {
			// A one-seat step is in flight. Saying "nothing to move" here would
			// read as an all-clear while the second seat is still under evaluation.
			lines.push(`• **Holding** — ${plan.summary}`);
		} else {
			const sales = analysis.roster.currentCounts["Sales Executive"] ?? 0;
			const target = analysis.roster.targetQuotas["Sales Executive"] ?? 0;
			lines.push(
				`• **Nothing to move** — the roster already carries the sell-through weight this needs (${sales}/${target} seats).`,
			);
		}

		// What the hold is actually waiting for, rather than the whole rule again.
		const policy = OIL_RIG_POLICY.capacity;
		const outstanding: string[] = [];
		if (d.stock.fillPct > policy.exitMaxFillPct) {
			outstanding.push(
				`storage falls to ${policy.exitMaxFillPct}% (now ${d.stock.fillPct}%)`,
			);
		}
		const drainDaysNeeded =
			policy.exitConsecutiveDrainDays - analysis.regime.drainingDays;
		if (drainDaysNeeded > 0) {
			outstanding.push(
				`${drainDaysNeeded} more draining day${drainDaysNeeded === 1 ? "" : "s"}`,
			);
		}
		lines.push(
			outstanding.length > 0
				? `• **Releases when** ${outstanding.join(" and ")}. The roster is left alone until then, so the correction is not undone and reapplied.`
				: `• **Releases when** ${plan.holdCondition}.`,
		);

		if (d.stock.structuralAdvice) {
			lines.push(`• ${d.stock.structuralAdvice}`);
		}
	} else {
		// The regime is only news when it is not already obvious from the storage
		// line above, so it is reported when it has genuinely been released.
		if (plan.regime.transition === "released") {
			lines.push(`• **Constraint released** — ${plan.regime.shortReason}.`);
		}
		if (d.stock.state !== "equilibrium" || d.stock.structuralAdvice) {
			lines.push(`• **Storage:** ${d.stock.stateDescription}`);
		}
		if (d.stock.structuralAdvice) {
			lines.push(`• ${d.stock.structuralAdvice}`);
		}
	}

	return lines;
}

const UPGRADE_LABELS: Record<CompanyUpgradeCategory, string> = {
	company_size: "Company size",
	staff_room: "Staff room",
	warehouse: "Warehouse",
};

/**
 * One line per due upgrade.
 *
 * The price is rendered here rather than baked into `reason`, so the engine can
 * be tested on the decision without the prose drifting from the catalog. A
 * multi-step recommendation prints the whole chain and its total: "two sizes
 * short" is one decision but two purchases, and hiding the second cost would
 * make the first line look complete.
 */
export function renderUpgradeRecommendations(
	upgrades: CompanyUpgradeAdvice,
): string[] {
	return upgrades.recommendations.map((recommendation) => {
		const chain = recommendation.steps
			.map((step) => `${step.tier} ${formatMoney(step.cost)}`)
			.join(" then ");
		const purchase =
			recommendation.steps.length > 1
				? `${chain} _(${formatMoney(recommendation.totalCostToTarget)} total)_`
				: `${recommendation.nextTier} ${formatMoney(recommendation.nextCost)}`;
		return `• **${UPGRADE_LABELS[recommendation.category]} (${recommendation.priority}):** ${recommendation.reason} **Buy:** ${purchase}.`;
	});
}

/**
 * Renders the deterministic sections: what to do, and why.
 */
export function renderDeterministicBriefing(
	analysis: OilRigAnalysis,
	options?: { previousSignature?: string; previousAsOfIso?: string },
): DeterministicBriefing {
	const d = analysis.directives;
	const signature = adviceSignature(d);
	const changed =
		options?.previousSignature === undefined ||
		options.previousSignature !== signature;

	// ---- Do this -------------------------------------------------------------
	const doThis: string[] = [];

	for (const transfer of d.roleTransfers) {
		doThis.push(
			`• **Roster:** ${transfer.name} (${transfer.statsStr}) ${transfer.fromRole} ➔ **${transfer.toRole}**`,
		);
	}

	const t1 = d.rehabTiers.tier1;
	const t2 = d.rehabTiers.tier2;
	const t3 = d.rehabTiers.tier3;
	if (t1.length > 0) doThis.push(`• **Rehab now:** ${rehabList(t1)}`);
	if (t2.length > 0) doThis.push(`• **Rehab next:** ${rehabList(t2)}`);
	if (t3.length > 0) doThis.push(`• **Rehab watch:** ${rehabList(t3)}`);

	if (d.pricing.isChanged) {
		doThis.push(
			`• **Price:** ${d.pricing.formatted} _(${d.pricing.basis.replace(/_/g, " ")}, ${d.pricing.confidence} confidence)_`,
		);
	}
	if (d.adSpend.isChanged) {
		doThis.push(
			`• **Ad budget:** ${d.adSpend.formatted} _(${d.adSpend.basis.replace(/_/g, " ")})_`,
		);
	}

	const nothingToDo =
		d.roleTransfers.length === 0 &&
		t1.length + t2.length + t3.length === 0 &&
		d.pricing.isChanged === false &&
		d.adSpend.isChanged === false;

	const upgradeLines = renderUpgradeRecommendations(d.upgrades);

	if (nothingToDo && upgradeLines.length > 0) {
		doThis.push(
			"• **No operational changes** — roster, price, advertising and staff health are at target; the upgrades below are the outstanding work.",
		);
	} else if (nothingToDo) {
		doThis.push(
			"• **Nothing outstanding** — roster, price, advertising and staff health are all where the engines want them.",
		);
	}

	const sections: string[] = [];
	const noChangeLine =
		changed === false && options?.previousAsOfIso
			? `_No change since ${options.previousAsOfIso} — these are the standing instructions, not a fresh demand._\n\n`
			: "";
	sections.push(`### Do This\n\n${noChangeLine}${doThis.join("\n")}`);

	// ---- Target lineup -------------------------------------------------------
	if (d.roleTransfers.length > 0) {
		sections.push(
			`### Target Lineup\n${renderLineup(analysis.roster.rosterByRole)}`,
		);
	}

	// ---- Capacity ------------------------------------------------------------
	const capacity = renderCapacity(analysis);
	if (capacity.length > 0) {
		sections.push(`### Capacity\n${capacity.join("\n")}`);
	}

	// ---- Upgrades ------------------------------------------------------------
	// Last, because an upgrade is a consequence of the operating picture above:
	// the seat plan says whether more staff are usable, and the environment is the
	// evidence that the staff room is out of step with the headcount.
	if (upgradeLines.length > 0) {
		sections.push(`### Upgrades\n${upgradeLines.join("\n")}`);
	}

	return {
		advice: sections.join("\n\n"),
		signature,
		actionText: [...doThis, ...capacity, ...upgradeLines].join("\n"),
		stockBullets: capacity,
		changed,
	};
}

/** Company profile figures the analysis does not carry, for the details block. */
export interface BriefingProfile {
	efficiency: number;
	environment: number;
	popularity: number;
	employees: { hired: number; capacity: number };
}

/**
 * The parts of an extraction estimate, worded so a median cannot pass for a day.
 *
 * The headline extraction figure is a median over the last few measured days, so
 * on its own it reads as "this is what the rig produced today". A reader who
 * checked it against the stock level saw a contradiction that was not in the
 * arithmetic but in the label: the brief printed "sold 332,886 · produced
 * 321,560" beside a stock figure that had risen 62,138 bbl, which is impossible
 * for a single day. Naming the window and stating the newest day separately is
 * what lets the two numbers be reconciled.
 */
function extractionWording(production: OilRigAnalysis["stock"]["production"]): {
	median?: number;
	latest?: number;
	/** e.g. "3-day median", or "the only measured day" when the window is one. */
	label: string;
	confidence: string;
	/** True when the headline is a median of more than the newest day. */
	smoothed: boolean;
} {
	const median = production.dailyProduced;
	const latest = production.latestMeasured;
	return {
		median,
		latest,
		label:
			production.samples > 1
				? `${production.samples}-day median`
				: "the only measured day",
		confidence: production.confidence,
		smoothed:
			production.samples > 1 && latest !== undefined && latest !== median,
	};
}

/** The telemetry summary of extraction, for the details block. */
function describeExtraction(
	production: OilRigAnalysis["stock"]["production"],
): string {
	const { median, latest, label, confidence, smoothed } =
		extractionWording(production);
	if (median === undefined) return "unmeasurable";
	const fromLatest = smoothed
		? ` · latest day ${latest?.toLocaleString()}`
		: "";
	return `${median.toLocaleString()} bbl/day (${label}, ${confidence} confidence${fromLatest})`;
}

/** One labelled telemetry field: a bold label, then its single value. */
interface TelemetryField {
	label: string;
	value: string;
}

/**
 * The telemetry, one field per metric.
 *
 * These were four dense lines whose metrics were separated by "·", so a single
 * line carried four unrelated numbers and one had to be found by counting
 * separators - "Daily: revenue A · wages B · ads C · profit D". Each metric is now
 * its own labelled field, which is what makes a figure addressable: a field can be
 * named, compared against the same field on the previous brief, and read on a
 * phone without parsing position.
 *
 * The labels are deliberately distinct where the SOURCE is distinct. "Daily ads"
 * is the advertising spend recorded in the last whole day; "Ad budget" is the live
 * setting. They are equal unless a change is in flight, and naming them the same
 * thing would hide exactly the case where they differ.
 */
export function renderCompanyDetails(
	analysis: OilRigAnalysis,
	profile?: BriefingProfile,
): string {
	const { decision, stock } = analysis;
	const sign = (value: number) => (value >= 0 ? "+" : "");

	const fields: TelemetryField[] = [
		{
			label: "Daily revenue",
			value: formatMoney(decision.recordedDailyRevenue),
		},
		{ label: "Daily wages", value: formatMoney(decision.recordedDailyWages) },
		{ label: "Daily ads", value: formatMoney(decision.recordedAdBudget) },
		{
			label: "Daily profit",
			value: `${sign(decision.recordedDailyProfit)}${formatMoney(decision.recordedDailyProfit)}`,
		},
		{
			label: "Stock",
			value: `${decision.inStock.toLocaleString()}/${decision.storageCap.toLocaleString()} (${decision.fillPct}%)`,
		},
		{
			label: "Barrels sold",
			value: `${decision.dailySold.toLocaleString()} bbl/day`,
		},
		{
			label: "Barrels produced",
			value: describeExtraction(stock.production),
		},
		{ label: "Barrel price", value: `$${decision.currentPrice}/barrel` },
		{
			label: "Ad budget",
			value: `${formatMoney(decision.currentAdBudget)}/day`,
		},
	];

	if (profile) {
		fields.push(
			{ label: "Efficiency", value: `${profile.efficiency}%` },
			{ label: "Environment", value: `${profile.environment}%` },
			{ label: "Popularity", value: `${profile.popularity}%` },
			{
				label: "Staff",
				value: `${profile.employees.hired}/${profile.employees.capacity}`,
			},
		);
	}

	return fields
		.map((field) => `• **${field.label}:** ${field.value}`)
		.join("\n");
}

/**
 * The caveats block, so "why does this say something different?" is answerable
 * without reading the code.
 *
 * TWO THINGS WERE DELIBERATELY DROPPED from this block:
 *
 *  - The per-field provenance map, which ran to 850 characters to convey one
 *    rule. The exact map stays in the API payload and the stored brief for audit.
 *  - The "**Data:**" bullet, which restated which figures are live and which come
 *    from the recorded tick. It was the longest line in the brief and the least
 *    actionable: the tick date is already in the header, and a reader does not
 *    need it to act on the advice.
 *
 * What remains is warnings only, so an empty return means the whole section must
 * be omitted rather than printed as a bare heading.
 */
export function renderProvenance(analysis: OilRigAnalysis): string {
	if (analysis.warnings.length === 0) return "";
	return `• **Read with care:**\n${analysis.warnings
		.map((w) => `   – ${w}`)
		.join("\n")}`;
}
