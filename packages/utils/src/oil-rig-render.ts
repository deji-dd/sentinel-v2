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

function formatMoney(value: number): string {
	return `$${Math.round(value).toLocaleString()}`;
}

/**
 * Renders the deterministic sections: what to do, and the stock verdict.
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

	const action: string[] = [];

	if (changed === false && options?.previousAsOfIso) {
		action.push(
			`• **No change since ${options.previousAsOfIso}.** Every setting this brief asks for is already in place and no new measurement changes the picture, so the instructions below are the standing ones rather than a fresh demand.`,
		);
	}

	// ---- Role transfers ------------------------------------------------------
	if (d.roleTransfers.length > 0) {
		const transfers = d.roleTransfers
			.map(
				(t) =>
					`• **${t.name}** (${t.statsStr}): ${t.fromRole} ➔ **${t.toRole}**`,
			)
			.join("\n");
		action.push(
			`**Role Transfers (${d.roleTransfers.length}):**\n${transfers}`,
		);

		const lineup = Object.keys(analysis.roster.rosterByRole)
			.sort()
			.map((role) => {
				const members = analysis.roster.rosterByRole[role] ?? [];
				return `• **${role}** (${members.length}): ${members.join(" • ")}`;
			})
			.join("\n");
		action.push(`**Target Lineup:**\n${lineup}`);
	} else {
		action.push(
			`• **Roster:** every seat is already in its target role for a ${analysis.decision.staffCount}-staff rig steered toward the ${analysis.roster.blueprintSource}.`,
		);
	}

	// ---- Rehab ---------------------------------------------------------------
	const rehabTiers = d.rehabTiers;
	const rehabLines: string[] = [];
	if (rehabTiers.tier1.length > 0) {
		rehabLines.push(
			`• **Tier 1 (Send Today):** ${rehabTiers.tier1.map((e) => `**${e.name}** (${e.penalty} pts)`).join(" • ")}.`,
		);
	}
	if (rehabTiers.tier2.length > 0) {
		rehabLines.push(
			`• **Tier 2 (Send Next):** ${rehabTiers.tier2.map((e) => `**${e.name}** (${e.penalty} pts)`).join(" • ")}.`,
		);
	}
	if (rehabTiers.tier3.length > 0) {
		rehabLines.push(
			`• **Tier 3 (Monitor):** ${rehabTiers.tier3.map((e) => `**${e.name}** (${e.penalty} pts)`).join(" • ")}.`,
		);
	}
	action.push(
		`**Mandatory Swiss Rehab:**\n${
			rehabLines.length > 0
				? rehabLines.join("\n")
				: "• **Staff Health:** zero addiction debuffs detected across all staff."
		}`,
	);

	// ---- Capacity ------------------------------------------------------------
	const capacityBullets: string[] = [];
	const plan = d.capacityRebalance;

	if (plan.extractionBound) {
		if (plan.discardedBarrelsPerDay > 0) {
			capacityBullets.push(
				`• **Discarded Output:** about ${plan.discardedBarrelsPerDay.toLocaleString()} bbl/day (~${formatMoney(plan.discardedValuePerDay)}/day) is produced beyond what the rig clears and is lost while storage is full.`,
			);
		} else if (plan.discardedEvidenceThin) {
			capacityBullets.push(
				`• **Discarded Output:** unmeasurable right now. Storage has been at or above the critical fill on every recorded day and a full warehouse clamps the stock delta to zero, so the excess cannot be sized. The constraint is measured; its cost is not.`,
			);
		}

		if (plan.state === "action_required") {
			for (const actionItem of plan.actions) {
				const label =
					actionItem.kind === "rebalance"
						? "Rebalance Roster"
						: actionItem.kind === "hire"
							? `Hire ${plan.hires} x Sales Executive`
							: "Storage Is Not The Fix";
				capacityBullets.push(`• **${label}:** ${actionItem.reason}`);
			}
		} else {
			capacityBullets.push(`• **Rebalance Holding:** ${plan.summary}`);
		}

		capacityBullets.push(
			`• **Regime:** ${plan.regime.reason}${plan.regime.held ? " The regime is being held rather than re-decided, so a single draining day does not revoke it." : ""}`,
		);
	}

	if (capacityBullets.length > 0) {
		action.push(`**Capacity Rebalance:**\n${capacityBullets.join("\n")}`);
	}

	if (
		d.roleTransfers.length === 0 &&
		rehabLines.length === 0 &&
		capacityBullets.length === 0 &&
		d.pricing.isChanged === false &&
		d.adSpend.isChanged === false
	) {
		action.push(
			"• **All operations optimal** — roster is aligned with the target blueprint, all staff are clean, stock is inside the healthy buffer, and no price or advertising change is measured to be worth making.",
		);
	}

	// ---- Stock and pricing ---------------------------------------------------
	const stockBullets: string[] = [];

	if (
		d.pricing.isChanged ||
		d.adSpend.isChanged ||
		d.stock.state !== "equilibrium"
	) {
		stockBullets.push(`• **Storage Status:** ${d.stock.stateDescription}`);
	}
	if (d.pricing.isChanged) {
		stockBullets.push(
			`• **Pricing:** ${d.pricing.formatted} _(${d.pricing.basis.replace(/_/g, " ")}, ${d.pricing.confidence} confidence)_`,
		);
	}
	if (d.adSpend.isChanged) {
		stockBullets.push(
			`• **Ad Budget:** ${d.adSpend.formatted} _(basis: ${d.adSpend.basis.replace(/_/g, " ")})_`,
		);
	}
	if (d.stock.structuralAdvice) {
		stockBullets.push(
			`• **Structural Constraint:** ${d.stock.structuralAdvice}`,
		);
	}

	const sections = [`### Immediate Action Items\n\n${action.join("\n\n")}`];
	if (stockBullets.length > 0) {
		sections.push(`### Stock & Pricing Verdict\n${stockBullets.join("\n")}`);
	}

	return {
		advice: sections.join("\n\n"),
		signature,
		actionText: [...action, ...stockBullets].join("\n"),
		stockBullets,
		changed,
	};
}

/** The telemetry lines reused by the console output, the return value and the DM. */
export function renderCompanyDetails(analysis: OilRigAnalysis): string {
	const { decision, stock } = analysis;
	const sign = (value: number) => (value >= 0 ? "+" : "");
	const produced = stock.production.dailyProduced;
	const detailsLine = `Daily Rev: ${formatMoney(decision.recordedDailyRevenue)} | Daily Wages: ${formatMoney(decision.recordedDailyWages)} | Daily Ad: ${formatMoney(decision.recordedAdBudget)} | Daily Profit: ${sign(decision.recordedDailyProfit)}${formatMoney(decision.recordedDailyProfit)} | WTD Profit: see logs`;
	const stockLine = `Stock: ${decision.inStock.toLocaleString()}/${decision.storageCap.toLocaleString()} (${decision.fillPct}%) | Sold: ${decision.dailySold.toLocaleString()} bbl | Produced: ${produced !== undefined ? `${produced.toLocaleString()} bbl (${stock.production.confidence} confidence)` : "N/A"}`;
	return `${detailsLine}\n${stockLine}`;
}

/** The provenance and warning block, so "why is this different?" is answerable. */
export function renderProvenance(analysis: OilRigAnalysis): string {
	const lines: string[] = [
		`• **Data basis:** ${analysis.provenance.dataBasis}${analysis.provenance.tickIsoDate ? ` | last recorded tick: ${analysis.provenance.tickIsoDate}` : " | no recorded tick yet"}${analysis.provenance.tickAgeMinutes !== undefined ? ` (${Math.round(analysis.provenance.tickAgeMinutes / 60)}h old)` : ""}`,
		`• **Basis per field:** ${Object.entries(analysis.provenance.basisByField)
			.map(([field, basis]) => `${field} ← ${basis}`)
			.join("; ")}`,
	];
	if (analysis.warnings.length > 0) {
		lines.push(
			`• **Confidence warnings:**\n${analysis.warnings.map((w) => `   – ${w}`).join("\n")}`,
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

	const employeeRows = analysis.roster.lockedEmployees.length;
	const employeeTableNote = `${decision.staffCount} staff, ${employeeRows} already in their target role, roster matrix omitted to keep this analysis-only.`;

	const prompt = `
You are the Chief Operations Advisor for Succession Oil, a Torn City Oil Rig.
All figures below are computed from this rig's own recorded daily snapshots.
Your job is ANALYSIS: explain what the numbers mean and what to watch next.

HARD RULES:
- Use ONLY the figures supplied. Never invent a benchmark, competitor statistic, price range or target.
- If the data cannot support a conclusion, say so plainly rather than guessing.
- Output 3 to 5 bullets, each starting with "• ", 900 characters maximum in total.
- Do NOT repeat or reformat the action list; the director already has it verbatim.
- Do NOT recommend a change the action list did not ask for. If you think a lever
  should move and the actions do not move it, say instead what you would watch to
  decide, and why the current evidence is insufficient.
- No emojis, no headers, no preamble, no tables, no sign-off.

---
### LIVE TELEMETRY
• Rating: ${analysis.directives.sellThrough.samples} recorded price samples | ${decision.staffCount} staff, ${decision.openSeats} open seat(s)
• Daily Revenue: ${formatMoney(decision.recordedDailyRevenue)} | Weekly Revenue: ${formatMoney(decision.recordedDailyRevenue * 7)}
• Daily Profit: ${formatMoney(decision.recordedDailyProfit)} | WTD Profit: ${formatMoney(wtd.totalProfit)}
• Stock: ${decision.inStock.toLocaleString()} / ${decision.storageCap.toLocaleString()} bbl (${decision.fillPct}% full)
• Daily Sales: ${decision.dailySold.toLocaleString()} bbl at $${decision.currentPrice}/bbl
• Ad Budget: ${formatMoney(decision.currentAdBudget)}/day | Advertising rank step worth about ${formatMoney(d.adSpend.rankStepValuePerDay)}/day
• Barrel price recommendation basis: ${d.pricing.basis}, confidence ${d.pricing.confidence}
• Extraction: ${stock.production.summary}
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

	return { prompt, allowedNumbers: collectNumbers(prompt) };
}

/** Every numeric token in a body of text, normalised for comparison. */
function collectNumbers(text: string): Set<string> {
	const tokens = text.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
	const set = new Set<string>();
	for (const token of tokens) set.add(normaliseNumber(token));
	return set;
}

function normaliseNumber(token: string): string {
	const cleaned = token.replace(/[$,%]/g, "");
	const value = Number(cleaned);
	if (!Number.isFinite(value)) return token;
	// Currency is rounded to the nearest thousand and percentages to one decimal,
	// because the model paraphrases magnitudes and a literal match is too brittle.
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
			/(raise|increase|lower|reduce|cut|decrease|drop)[^.]{0,40}(price|barrel)/i,
		authorised: (d) => d.pricing.isChanged,
		reason: "proposes a barrel price change the pricing engine did not ask for",
	},
	{
		pattern:
			/(price|barrel)[^.]{0,40}(raise|increase|lower|reduce|cut|decrease|drop)/i,
		authorised: (d) => d.pricing.isChanged,
		reason: "proposes a barrel price change the pricing engine did not ask for",
	},
	{
		pattern: /(raise|increase|scale up|bump|top up)[^.]{0,40}(ad|advertis)/i,
		authorised: (d) => d.adSpend.isChanged && d.adSpend.action === "increase",
		reason: "proposes an advertising increase the ad engine did not authorise",
	},
	{
		pattern: /(cut|reduce|lower|pause|freeze)[^.]{0,40}(ad|advertis)/i,
		authorised: (d) =>
			d.adSpend.isChanged &&
			(d.adSpend.action === "decrease" || d.adSpend.action === "freeze"),
		reason: "proposes an advertising reduction the ad engine did not authorise",
	},
	{
		pattern:
			/\b(move|transfer|reassign|switch|rotate)\b[^.]{0,60}\b(Driller|Roughneck|Derrick Hand|Secretary|Inspector|Sales Executive|Motor Hand)\b/i,
		authorised: (d) => d.roleTransfers.length > 0,
		reason: "proposes a role move the roster solver did not issue",
	},
	{
		pattern: /\b(hire|hiring|recruit)\b/i,
		authorised: (d) => d.capacityRebalance.hires > 0,
		reason: "proposes hiring that the capacity plan did not authorise",
	},
	{
		pattern: /\b(rebalance|restructure)\b/i,
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
	const tokens = bullet.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
	const unsupported: string[] = [];
	for (const token of tokens) {
		const value = Number(token.replace(/[$,%]/g, ""));
		if (!Number.isFinite(value)) continue;
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
