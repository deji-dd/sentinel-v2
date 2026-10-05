import type { CompanyDirectives } from "../../schemas/src/company";
import {
	buildWeekToDateLogEntries,
	formatHistoryTable,
	type OilRigHistoryRecord,
} from "./oil-rig";
import type { OilRigAnalysis } from "./oil-rig-analysis";

/**
 * Rendering for the director briefing, kept separate from loading and delivery.
 *
 * The split matters for correctness, not tidiness: the deterministic advice, the
 * model's notes and the details block must all describe the SAME analysis object,
 * and the only way to guarantee that is to have one function that renders it and
 * no other path that can recompute it.
 *
 * Everything numerically actionable is rendered here from the engines. The model
 * is used only for analysis prose, and `validateAnalystNotes` fences even that.
 */

/**
 * Stable signature of the deterministic advice.
 *
 * Used for two things: telling the director "no change since <date>" instead of
 * re-issuing re-worded identical advice, and skipping the model call entirely
 * when nothing has changed - which is what stops the same advice arriving in
 * different words on every fetch.
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
	const produced = analysis.stock.production.dailyProduced;
	const sold = analysis.decision.dailySold;

	if (plan.extractionBound) {
		const flow =
			produced !== undefined
				? `extraction ${produced.toLocaleString()} vs sales ${sold.toLocaleString()} bbl/day`
				: `sales ${sold.toLocaleString()} bbl/day, with extraction unmeasured`;
		lines.push(
			`• **Cannot drain** — storage is ${d.stock.fillPct}% full, and ${flow}.`,
		);

		if (plan.discardedBarrelsPerDay > 0) {
			lines.push(
				`• **Losing ~${plan.discardedBarrelsPerDay.toLocaleString()} bbl/day** (~${formatMoneyShort(plan.discardedValuePerDay)}/day) to the cap.`,
			);
		} else if (plan.discardedCappedLowerBound > 0) {
			// Every recorded day was already at the cap, so the median surplus is
			// zero while the clamped measurement still proves discard is happening.
			// Reporting "cannot be sized" here would hide a figure we do have.
			lines.push(
				`• **Losing at least ~${plan.discardedCappedLowerBound.toLocaleString()} bbl/day** — a lower bound, because storage was at the cap on every recorded day and a full warehouse clamps the stock delta.`,
			);
		} else {
			lines.push(
				"• **Loss cannot be sized** while storage is pinned at the cap: a full warehouse clamps the stock delta to zero.",
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
		} else {
			const sales = analysis.roster.currentCounts["Sales Executive"] ?? 0;
			const target = analysis.roster.targetQuotas["Sales Executive"] ?? 0;
			lines.push(
				`• **Nothing to move** — the roster already carries the sell-through weight this needs (${sales}/${target} seats).`,
			);
			lines.push(`• **Holds until** ${plan.holdCondition}.`);
		}

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

/**
 * Renders the deterministic sections: what to do, and why.
 *
 * The model is deliberately NOT asked to reproduce any of this. Asking a model to
 * copy pre-computed facts is what previously needed regex passes to undo.
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

	if (nothingToDo) {
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

	return {
		advice: sections.join("\n\n"),
		signature,
		actionText: [...doThis, ...capacity].join("\n"),
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

/** The telemetry lines reused by the console output, the return value and the DM. */
export function renderCompanyDetails(
	analysis: OilRigAnalysis,
	profile?: BriefingProfile,
): string {
	const { decision, stock } = analysis;
	const sign = (value: number) => (value >= 0 ? "+" : "");
	const produced = stock.production.dailyProduced;

	const lines = [
		`• **Daily:** revenue ${formatMoney(decision.recordedDailyRevenue)} · wages ${formatMoney(decision.recordedDailyWages)} · ads ${formatMoney(decision.recordedAdBudget)} · profit ${sign(decision.recordedDailyProfit)}${formatMoney(decision.recordedDailyProfit)}`,
		`• **Stock:** ${decision.inStock.toLocaleString()}/${decision.storageCap.toLocaleString()} (${decision.fillPct}%) · sold ${decision.dailySold.toLocaleString()} bbl/day · produced ${produced !== undefined ? `${produced.toLocaleString()} bbl/day (${stock.production.confidence} confidence)` : "unmeasurable"}`,
		`• **Settings:** price $${decision.currentPrice}/barrel · ads ${formatMoney(decision.currentAdBudget)}/day`,
	];
	if (profile) {
		lines.push(
			`• **Rig:** efficiency ${profile.efficiency}% · environment ${profile.environment}% · popularity ${profile.popularity}% · staff ${profile.employees.hired}/${profile.employees.capacity}`,
		);
	}
	return lines.join("\n");
}

/**
 * The basis and caveats block, so "why does this say something different?" is
 * answerable without reading the code.
 *
 * The per-field provenance map is deliberately NOT printed: eight field
 * explanations ran to 850 characters to convey one rule. The rule is stated, and
 * the exact per-field map stays in the API payload and the stored brief for audit.
 */
export function renderProvenance(analysis: OilRigAnalysis): string {
	const lines: string[] = [];
	const tick = analysis.provenance.tickIsoDate
		? `recorded tick ${analysis.provenance.tickIsoDate}${
				analysis.provenance.tickAgeMinutes !== undefined
					? ` (${Math.round(analysis.provenance.tickAgeMinutes / 60)}h old)`
					: ""
			}`
		: "no tick recorded yet";
	lines.push(
		`• **Basis:** settings (stock, price, ads, roster) ← live snapshot · rates (sales, revenue, wages) ← ${tick}`,
	);
	if (analysis.warnings.length > 0) {
		lines.push(
			`• **Read with care:**\n${analysis.warnings.map((w) => `   – ${w}`).join("\n")}`,
		);
	}
	return lines.join("\n");
}

export interface AnalystPromptArgs {
	analysis: OilRigAnalysis;
	history: OilRigHistoryRecord[];
	actionText: string;
}

export interface AnalystPrompt {
	prompt: string;
	/** Every number the model is permitted to cite, normalised. */
	allowedNumbers: Set<string>;
}

/**
 * Builds the analysis-only prompt and the numeric allowlist that fences it.
 *
 * The allowlist is derived from the prompt itself, so it cannot drift from what
 * the model was actually shown: if a figure is not in the prompt, the model had
 * no basis for it and the bullet citing it is dropped.
 */
export function buildAnalystPrompt(args: AnalystPromptArgs): AnalystPrompt {
	const { analysis } = args;
	const d = analysis.directives;
	const { decision, stock } = analysis;

	const historyTable = formatHistoryTable(args.history);
	const wtd = buildWeekToDateLogEntries({ history: args.history });

	// The tick date matters: "daily" is the day the last snapshot recorded, and a
	// model told only "Daily Profit" will assume it means today.
	const tickLabel = analysis.provenance.tickIsoDate
		? ` (${analysis.provenance.tickIsoDate}${
				analysis.provenance.tickAgeMinutes !== undefined
					? `, recorded ${Math.round(analysis.provenance.tickAgeMinutes / 60)}h ago`
					: ""
			})`
		: " (none recorded yet)";
	const wtdWindow = `${wtd.mondayIso} to ${wtd.sundayIso}`;
	/**
	 * An empty week must read as missing data. Rendering it as "$0" is what made
	 * the model report a "reset or specific accounting period" and speculate about
	 * the rig's finances instead of the thing the brief is for.
	 */
	const wtdBlock =
		wtd.entries.length === 0
			? `• NO DAYS RECORDED IN THIS WINDOW YET. Week-to-date profit is unknown, not zero. Do not draw any conclusion from its absence, and do not describe it as a reset.`
			: `• ${wtd.entries.length} recorded day(s) · revenue ${formatMoney(wtd.totalRevenue)} · wages ${formatMoney(wtd.totalWages)} · advertising ${formatMoney(wtd.totalAd)} · profit ${formatMoney(wtd.totalProfit)} · barrels sold ${wtd.totalSold.toLocaleString()}`;
	// The RECORDED barrel price, which can differ from the live setting. Quoting the
	// live price beside a recorded volume implied the day sold at a price it did not.
	const tickPrice =
		args.history[args.history.length - 1]?.stock.barrelPrice ??
		analysis.decision.currentPrice;

	const employeeRows = analysis.roster.lockedEmployees.length;
	const employeeTableNote = `${decision.staffCount} staff, ${employeeRows} already in their target role, roster matrix omitted to keep this analysis-only.`;

	const prompt = `
You are the Chief Operations Advisor for Succession Oil, a Torn City Oil Rig.
All figures below are computed from this rig's own recorded daily snapshots.
Your job is ANALYSIS: explain what the numbers mean and what to watch next.

HARD RULES:
- Use ONLY the figures supplied. Never invent a benchmark, competitor statistic, price range or target.
- If the data cannot support a conclusion, say so plainly rather than guessing.
- Output 3 to 4 bullets, each starting with "• ", 700 characters maximum in total.
- Be brief. The director reads this on a phone; a long answer will be cut.
- Do NOT repeat or reformat the action list; the director already has it verbatim.
- Do NOT recommend a change the action list did not ask for. If you think a lever
  should move and the actions do not move it, say instead what you would watch to
  decide, and why the current evidence is insufficient.
- No emojis, no headers, no preamble, no tables, no sign-off.

---
### ACCOUNTING RULES (read before interpreting any figure)
• "Daily" means the most recent RECORDED day${tickLabel}, a complete day. It is NOT today, and it does not change until the next snapshot is recorded.
• "WTD" (week to date) covers Monday ${wtdWindow} and is the sum of the days recorded inside that window. At the start of a week it is EMPTY, not zero: an empty week is missing data, not a day of no trading.
• A day's profit is that day's revenue minus that day's wages and advertising. WTD profit is the sum of those daily profits for the recorded days in the window.
• Settings (barrel price, advertising budget, roster, storage) are LIVE and may differ from the values in the most recent recorded day. Where they differ, both are shown.

### TELEMETRY — LAST RECORDED DAY${tickLabel}
• Revenue ${formatMoney(decision.recordedDailyRevenue)} · wages ${formatMoney(decision.recordedDailyWages)} · advertising ${formatMoney(decision.recordedAdBudget)} · profit ${formatMoney(decision.recordedDailyProfit)}
• Barrels sold ${decision.dailySold.toLocaleString()} at $${tickPrice}/barrel · extraction ${stock.production.dailyProduced !== undefined ? `${stock.production.dailyProduced.toLocaleString()} bbl/day (${stock.production.confidence} confidence, ${stock.production.samples} measured day(s))` : "unmeasured"}${stock.production.capped ? " · storage was at the cap, so true extraction is at least this high" : ""}
• The game's own weekly revenue figure at that point: ${formatMoney(decision.recordedWeeklyRevenue)}

### TELEMETRY — WEEK TO DATE (Mon ${wtdWindow})
${wtdBlock}

### TELEMETRY — LIVE SETTINGS AND STATE
• Stock on hand ${decision.inStock.toLocaleString()} / ${decision.storageCap.toLocaleString()} bbl (${decision.fillPct}% full) · barrel price $${decision.currentPrice} · advertising ${formatMoney(decision.currentAdBudget)}/day
• ${decision.staffCount} staff, ${decision.openSeats} open seat(s) · ${analysis.directives.sellThrough.samples} recorded price sample(s)
• Advertising rank step worth about ${formatMoney(d.adSpend.rankStepValuePerDay)}/day · barrel price advice basis: ${d.pricing.basis} (confidence ${d.pricing.confidence})
• Inventory state: ${stock.state.toUpperCase()}${stock.stateHeld ? " (held from the previous brief)" : ""} — ${stock.stateDescription}
• Capacity regime: ${analysis.regime.regime}${analysis.regime.held ? " (held)" : ""} — ${analysis.regime.reason}

---
### COMPUTED ANALYSIS (authoritative — do not contradict)
• Price response: ${analysis.sellThrough.summary}
• Capacity: ${analysis.discarded.summary}
• Demand curve: ${stock.demand.reason}
• Advertising: ${stock.adResponse.summary}
• Advertising model: ${stock.adRankModel.rationale}
${stock.structuralAdvice ? `• Structural constraint: ${stock.structuralAdvice}` : "• Structural constraint: none detected."}
${analysis.warnings.length > 0 ? `• Caveats that must temper any conclusion:\n${analysis.warnings.map((w) => `  – ${w}`).join("\n")}` : ""}

---
### ROSTER
${employeeTableNote}
• Quotas: ${Object.entries(analysis.roster.targetQuotas)
		.map(([role, count]) => `${role} ${count}`)
		.join(", ")}

---
### RECORDED HISTORY
${historyTable}

---
### ACTIONS ALREADY ISSUED (do not repeat these, and do not contradict them)
${args.actionText}

---
Write the analysis bullets now.`;

	return { prompt, allowedNumbers: expandWithDerived(collectNumbers(prompt)) };
}

/**
 * Adds the differences of the supplied magnitudes to the allowlist.
 *
 * "Extraction is 310,655 against sales of 283,942, so the shortfall is about
 * 26,700" is arithmetic on figures the model was given, not an invented
 * statistic. Without this the validator drops honest derivations, which is the
 * same failure as accepting invented ones: a brief that says less than it knows.
 *
 * Only differences between figures of 1,000 or more are derived. Sums are
 * deliberately excluded, because they collide with large external reference
 * numbers and a difference is the derivation this advice actually needs.
 */
function expandWithDerived(values: Set<string>): Set<string> {
	const magnitudes = [...values]
		.map(Number)
		.filter((value) => Number.isFinite(value) && Math.abs(value) >= 1000);
	const expanded = new Set(values);
	for (const a of magnitudes) {
		for (const b of magnitudes) {
			if (a === b) continue;
			expanded.add(normaliseNumber(String(Math.abs(a - b))));
		}
	}
	return expanded;
}

/** Every numeric token in a body of text, normalised for comparison. */
function collectNumbers(text: string): Set<string> {
	const tokens = text.match(/\$?\d[\d,]*(?:\.\d+)?[kKmMbB]?%?/g) ?? [];
	const set = new Set<string>();
	for (const token of tokens) set.add(normaliseNumber(token));
	return set;
}

/**
 * Parses a numeric token, including the k/M/B shorthand models like to use.
 *
 * "$3.46M" is how a model writes $3,459,292. Without suffix support the validator
 * saw the literal 3.46, failed to match it against the supplied figures, and threw
 * away a correct bullet.
 */
function parseMagnitude(token: string): number | undefined {
	const match = token.match(/^\$?([\d,]+(?:\.\d+)?)([kKmMbB])?(%?)$/);
	if (!match) return undefined;
	const base = Number((match[1] ?? "").replace(/,/g, ""));
	if (!Number.isFinite(base)) return undefined;
	const suffix = (match[2] ?? "").toLowerCase();
	const multiplier =
		suffix === "k"
			? 1_000
			: suffix === "m"
				? 1_000_000
				: suffix === "b"
					? 1_000_000_000
					: 1;
	return base * multiplier;
}

function normaliseNumber(token: string): string {
	const value = parseMagnitude(token);
	if (value === undefined) return token;
	// Amounts are rounded to the nearest thousand: the model paraphrases
	// magnitudes, and a literal match is too brittle to be useful.
	if (Math.abs(value) >= 1000) return String(Math.round(value / 1000) * 1000);
	return String(Number(value.toFixed(2)));
}

export interface NotesValidationResult {
	accepted: string[];
	rejected: Array<{ bullet: string; reason: string }>;
}

/** Rules that make a claim which the deterministic advice did not authorise. */
const CONTRADICTION_RULES: Array<{
	pattern: RegExp;
	authorised: (d: CompanyDirectives) => boolean;
	reason: string;
}> = [
	{
		pattern:
			/(rais|increas|lower|reduc|cut|cutting|decreas|drop)\w*[^.]{0,40}(price|barrel)/i,
		authorised: (d) => d.pricing.isChanged,
		reason: "proposes a barrel price change the pricing engine did not ask for",
	},
	{
		pattern:
			/(price|barrel)[^.]{0,40}(rais|increas|lower|reduc|cut|decreas|drop)\w*/i,
		authorised: (d) => d.pricing.isChanged,
		reason: "proposes a barrel price change the pricing engine did not ask for",
	},
	{
		pattern:
			/(rais|increas|scal|bump|top up)\w*[^.]{0,40}\b(ad|ads|advertis\w*)\b/i,
		authorised: (d) => d.adSpend.isChanged && d.adSpend.action === "increase",
		reason: "proposes an advertising increase the ad engine did not authorise",
	},
	{
		pattern:
			/(cut|reduc|lower|paus|freez)\w*[^.]{0,40}\b(ad|ads|advertis\w*)\b/i,
		authorised: (d) =>
			d.adSpend.isChanged &&
			(d.adSpend.action === "decrease" || d.adSpend.action === "freeze"),
		reason: "proposes an advertising reduction the ad engine did not authorise",
	},
	{
		pattern:
			/\b(mov|transfer|reassign|switch|rotat|reshuffl)\w*\b[^.]{0,60}\b(Driller|Roughneck|Derrick Hand|Secretary|Inspector|Sales Executive|Motor Hand)\b/i,
		authorised: (d) => d.roleTransfers.length > 0,
		reason: "proposes a role move the roster solver did not issue",
	},
	{
		pattern: /\b(hir(e|es|ing)|recruit\w*)\b/i,
		authorised: (d) => d.capacityRebalance.hires > 0,
		reason: "proposes hiring that the capacity plan did not authorise",
	},
	{
		pattern: /\b(rebalanc|restructur)\w*\b/i,
		authorised: (d) => d.capacityRebalance.state === "action_required",
		reason:
			"proposes a roster rebalance the capacity plan is not asking for (it is holding or balanced)",
	},
];

/**
 * Validates the model's analysis bullets before they are shown.
 *
 * Two checks, both cheap and both aimed at the failure the director actually
 * sees: the model asserting something the briefing's own engines contradict, or
 * citing a figure that appears nowhere in the data it was given. Rejected bullets
 * are dropped and logged rather than rendered - a shorter honest brief beats a
 * longer one that argues with itself.
 */
export function validateAnalystNotes(args: {
	notes: string;
	allowedNumbers: Set<string>;
	directives: CompanyDirectives;
}): NotesValidationResult {
	const accepted: string[] = [];
	const rejected: Array<{ bullet: string; reason: string }> = [];

	const bullets = args.notes
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.flatMap((line) => {
			// Keep bullet structure but split a wall of prose into sentences so one
			// bad claim does not discard the model's whole answer.
			if (/^[•\-*]\s/.test(line)) return [line];
			return line
				.split(/(?<=[.!?])\s+/)
				.filter((sentence) => sentence.trim().length > 0)
				.map((sentence) => `• ${sentence.trim()}`);
		});

	for (const bullet of bullets) {
		const contradiction = CONTRADICTION_RULES.find(
			(rule) => rule.pattern.test(bullet) && !rule.authorised(args.directives),
		);
		if (contradiction) {
			rejected.push({ bullet, reason: contradiction.reason });
			continue;
		}

		const unsupported = findUnsupportedNumbers(bullet, args.allowedNumbers);
		if (unsupported.length > 0) {
			rejected.push({
				bullet,
				reason: `cites ${unsupported.join(", ")}, which does not appear in the data it was given`,
			});
			continue;
		}

		accepted.push(bullet);
	}

	return { accepted, rejected };
}

/**
 * Numbers in a bullet that the model could not have derived from its prompt.
 *
 * Small integers are allowed through: "3 days", "2 seats" and similar counts are
 * legitimate reasoning, not invented statistics. A currency figure or a percentage
 * is a factual claim, and must match something the model was actually shown.
 */
function findUnsupportedNumbers(
	bullet: string,
	allowed: Set<string>,
): string[] {
	const tokens = bullet.match(/\$?\d[\d,]*(?:\.\d+)?[kKmMbB]?%?/g) ?? [];
	const unsupported: string[] = [];
	for (const token of tokens) {
		const value = parseMagnitude(token);
		if (value === undefined) continue;
		const isClaim =
			token.includes("$") || token.includes("%") || Math.abs(value) >= 1000;
		if (!isClaim) continue;
		const normalised = normaliseNumber(token);
		if (allowed.has(normalised)) continue;
		// Allow a near-match: models round and paraphrase magnitudes.
		const near = [...allowed].some((candidate) => {
			const candidateValue = Number(candidate);
			if (!Number.isFinite(candidateValue) || candidateValue === 0)
				return false;
			return Math.abs(candidateValue - value) / Math.abs(candidateValue) < 0.02;
		});
		if (near) continue;
		unsupported.push(token);
	}
	return [...new Set(unsupported)];
}
