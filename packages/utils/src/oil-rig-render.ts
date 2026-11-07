import type {
	CompanyDirectives,
	CompanyUpgradeAdvice,
	CompanyUpgradeCategory,
} from "../../schemas/src/company";
import {
	OIL_RIG_ROLE_ORDER,
	OIL_RIG_ROLES,
	type OilRigRoleName,
	roleFitScore,
	roleOfEmployee,
} from "./oil-rig";
import type { OilRigAnalysis } from "./oil-rig-analysis";
import { OIL_RIG_POLICY } from "./oil-rig-policy";
import type { CompanySnapshot } from "./oil-rig-snapshot";

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
		rehab: directives.rehabTiers.tier1
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

/** One employee, flattened for the positioning report. */
export interface EmployeePositionRow {
	id?: number;
	name: string;
	currentRole: string;
	recommendedRole: string;
	stats: {
		manualLabor: number;
		intelligence: number;
		endurance: number;
		total: number;
	};
	wage: number;
	workingStats: number;
	effectiveness: number;
	addiction: number;
	/** Fit in the role the employee currently holds, when it is a known role. */
	currentFit?: number;
	/** Fit in the role the solver would put them in. */
	recommendedFit?: number;
}

function isKnownRole(role: string): role is OilRigRoleName {
	return Object.prototype.hasOwnProperty.call(OIL_RIG_ROLES, role);
}

/**
 * Builds the report rows from the same analysis the brief uses.
 *
 * The list is ordered by raw stat total descending because the director asked
 * for it that way: it answers "who are my strongest employees" before role fit
 * enters the picture. Fit is still shown, so a high-stat employee in the wrong
 * seat is visible rather than buried.
 */
export function buildEmployeePositionRows(
	analysis: OilRigAnalysis,
	snapshot: CompanySnapshot,
): EmployeePositionRow[] {
	const transferByName = new Map(
		analysis.roster.activeTransfers.map((transfer) => [
			transfer.name,
			transfer,
		]),
	);

	return snapshot.employees
		.map((employee) => {
			const currentRole = roleOfEmployee(employee);
			const transfer = transferByName.get(employee.name);
			const recommendedRole = transfer?.toRole ?? currentRole;
			const manualLabor = employee.stats?.manual_labor ?? 0;
			const intelligence = employee.stats?.intelligence ?? 0;
			const endurance = employee.stats?.endurance ?? 0;
			const currentFit = isKnownRole(currentRole)
				? roleFitScore(employee, currentRole)
				: undefined;
			const recommendedFit = isKnownRole(recommendedRole)
				? roleFitScore(employee, recommendedRole)
				: currentFit;

			return {
				id: employee.id,
				name: employee.name,
				currentRole,
				recommendedRole,
				stats: {
					manualLabor,
					intelligence,
					endurance,
					total: manualLabor + intelligence + endurance,
				},
				wage: employee.wage ?? 0,
				workingStats: employee.effectiveness?.working_stats ?? 0,
				effectiveness: employee.effectiveness?.total ?? 0,
				addiction: employee.effectiveness?.addiction ?? 0,
				currentFit,
				recommendedFit,
			};
		})
		.sort(
			(a, b) => b.stats.total - a.stats.total || a.name.localeCompare(b.name),
		);
}

function formatStat(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatWage(value: number): string {
	return `$${Math.round(value).toLocaleString("en-US")}`;
}

function maxWidth(values: string[], minimum: number): number {
	return values.reduce(
		(width, value) => Math.max(width, value.length),
		minimum,
	);
}

function fitLabel(row: EmployeePositionRow): string {
	if (row.currentFit === undefined) return "—";
	if (
		row.recommendedRole !== row.currentRole &&
		row.recommendedFit !== undefined
	) {
		return `${row.currentFit}→${row.recommendedFit}`;
	}
	return String(row.currentFit);
}

function renderEmployeeTable(rows: EmployeePositionRow[]): string {
	const headers = [
		"#",
		"Employee",
		"MAN",
		"INT",
		"END",
		"Total",
		"WS",
		"Eff",
		"Current Role",
		"Pay/day",
		"Fit",
	];
	const cells = rows.map((row) => [
		row.name,
		formatStat(row.stats.manualLabor),
		formatStat(row.stats.intelligence),
		formatStat(row.stats.endurance),
		formatStat(row.stats.total),
		formatStat(row.workingStats),
		formatStat(row.effectiveness),
		row.currentRole,
		formatWage(row.wage),
		fitLabel(row),
	]);
	const widths = [
		Math.max(1, String(Math.max(1, rows.length)).length),
		...headers.slice(1).map((header, index) =>
			maxWidth(
				cells.map((row) => row[index] ?? ""),
				header.length,
			),
		),
	];
	const indexWidth = widths[0] ?? 1;

	const renderRow = (values: string[], index?: number) => {
		const indexCell = String(index ?? "").padStart(indexWidth);
		const rest = values.map((value, cellIndex) => {
			const width = widths[cellIndex + 1] ?? value.length;
			// User names and role labels read better left-aligned; numbers and
			// money read better right-aligned, where digits line up.
			return cellIndex === 0 || cellIndex === 7
				? value.padEnd(width)
				: value.padStart(width);
		});
		return [indexCell, ...rest].join("  ").trimEnd();
	};

	const header = [
		"#".padStart(indexWidth),
		...headers.slice(1).map((value, cellIndex) => {
			const width = widths[cellIndex + 1] ?? value.length;
			return cellIndex === 0 || cellIndex === 7
				? value.padEnd(width)
				: value.padStart(width);
		}),
	].join("  ");
	const separator = "-".repeat(header.length);
	const body = rows.map((row, index) =>
		renderRow(cells[index] ?? [], index + 1),
	);

	return ["```", header, separator, ...body, "```"].join("\n");
}

function renderRoleCoverage(analysis: OilRigAnalysis): string {
	const current = analysis.roster.currentCounts;
	const target = analysis.roster.targetQuotas;
	const roles = [
		...OIL_RIG_ROLE_ORDER,
		...Object.keys(current).filter(
			(role) => !(OIL_RIG_ROLE_ORDER as string[]).includes(role),
		),
		...Object.keys(target).filter(
			(role) =>
				!(OIL_RIG_ROLE_ORDER as string[]).includes(role) && !(role in current),
		),
	];

	return [...new Set(roles)]
		.filter((role) => (current[role] ?? 0) > 0 || (target[role] ?? 0) > 0)
		.map((role) => `${role} ${current[role] ?? 0}→${target[role] ?? 0}`)
		.join(" · ");
}

/**
 * Employee positioning report.
 *
 * Answers three questions in order: who should move, who works here and how
 * strong are they, and how does the roster look as a whole. The table is a code
 * block so columns line up on every client without relying on Discord's very
 * limited markdown table support.
 */
export function renderEmployeePositioning(
	analysis: OilRigAnalysis,
	snapshot: CompanySnapshot,
): string {
	const rows = buildEmployeePositionRows(analysis, snapshot);
	const rowByName = new Map(rows.map((row) => [row.name, row]));
	const sections: string[] = [];

	// ---- Recommended moves ---------------------------------------------------
	const moves = analysis.roster.activeTransfers;
	if (moves.length > 0) {
		const moveLines = moves.map((transfer) => {
			const row = rowByName.get(transfer.name);
			const fit =
				row && row.currentFit !== undefined && row.recommendedFit !== undefined
					? ` — fit ${row.currentFit} ➔ ${row.recommendedFit} (${row.recommendedFit - row.currentFit >= 0 ? "+" : ""}${row.recommendedFit - row.currentFit})`
					: "";
			return `• **${transfer.name}** (${transfer.statsStr}) ${transfer.fromRole} ➔ **${transfer.toRole}**${fit}${transfer.rationale ? ` _(${transfer.rationale})_` : ""}`;
		});
		const quotaDriven = moves.some((transfer) => {
			const row = rowByName.get(transfer.name);
			return (
				row?.currentFit !== undefined &&
				row.recommendedFit !== undefined &&
				row.recommendedFit < row.currentFit
			);
		});
		sections.push(
			`### Recommended Moves\n${moveLines.join("\n")}${quotaDriven ? "\n_Some moves optimise the whole lineup rather than that employee's individual fit._" : ""}`,
		);
	} else {
		sections.push(
			"### Recommended Moves\n• None — every employee is already in the seat the engine would choose.",
		);
	}

	// ---- Everyone, strongest first -------------------------------------------
	sections.push(
		`### Employees (by stat total, high to low)\n${renderEmployeeTable(rows)}\n_WS = working stats · Eff = total effectiveness · Fit = current role fit → recommended role fit_`,
	);

	// ---- Roster summary ------------------------------------------------------
	const headcount = rows.length;
	const payroll = rows.reduce((sum, row) => sum + row.wage, 0);
	const totalStats = rows.reduce((sum, row) => sum + row.stats.total, 0);
	const totalWorkingStats = rows.reduce(
		(sum, row) => sum + row.workingStats,
		0,
	);
	const totalEffectiveness = rows.reduce(
		(sum, row) => sum + row.effectiveness,
		0,
	);
	const highest = rows[0];
	const lowest = rows[rows.length - 1];
	const openSeats = Math.max(
		0,
		snapshot.profile.employees.capacity - snapshot.profile.employees.hired,
	);
	const roleCoverage = renderRoleCoverage(analysis);

	const summary = [
		`• **Payroll:** ${formatWage(payroll)}/day across ${headcount} employee${headcount === 1 ? "" : "s"}${headcount > 0 ? ` (average ${formatWage(payroll / headcount)}/day)` : ""}.`,
		headcount > 0
			? `• **Stats:** ${formatStat(totalStats)} total · ${formatStat(totalStats / headcount)} average · strongest ${highest?.name} (${formatStat(highest?.stats.total ?? 0)}) · weakest ${lowest?.name} (${formatStat(lowest?.stats.total ?? 0)}).`
			: "• **Stats:** no employees on the roster.",
		headcount > 0
			? `• **Effectiveness:** ${formatStat(totalWorkingStats / headcount)} average working stats · ${formatStat(totalEffectiveness / headcount)} average total effectiveness.`
			: "",
		`• **Seats:** ${snapshot.profile.employees.hired}/${snapshot.profile.employees.capacity} filled${openSeats > 0 ? ` (${openSeats} open)` : ""} · blueprint: ${analysis.roster.blueprintSource}.`,
		roleCoverage ? `• **Role coverage (now → target):** ${roleCoverage}.` : "",
	].filter((line) => line.length > 0);
	sections.push(`### Roster Summary\n${summary.join("\n")}`);

	// ---- Health flags --------------------------------------------------------
	const health: string[] = [];
	const { tier1 } = analysis.roster.rehabTiers;
	if (tier1.length > 0) health.push(`• **Rehab now:** ${rehabList(tier1)}`);

	const unsettled = snapshot.employees
		.filter((employee) => (employee.effectiveness?.settled_in ?? 0) < 10)
		.sort(
			(a, b) =>
				(a.effectiveness?.settled_in ?? 0) - (b.effectiveness?.settled_in ?? 0),
		);
	if (unsettled.length > 0) {
		health.push(
			`• **Unsettled:** ${unsettled
				.map(
					(employee) =>
						`${employee.name} (${employee.effectiveness?.settled_in ?? 0}/10 settled)`,
				)
				.join(", ")}`,
		);
	}

	const inactive = snapshot.employees.filter(
		(employee) => (employee.effectiveness?.inactivity ?? 0) < 0,
	);
	if (inactive.length > 0) {
		health.push(
			`• **Inactive:** ${inactive
				.map(
					(employee) =>
						`${employee.name} (${employee.effectiveness?.inactivity ?? 0})`,
				)
				.join(", ")}`,
		);
	}

	if (health.length > 0) {
		sections.push(`### Staff Health\n${health.join("\n")}`);
	}

	// ---- Caveats -------------------------------------------------------------
	const warnings = renderProvenance(analysis);
	if (warnings.length > 0) {
		const warningLines = warnings
			.replace("• **Read with care:**", "")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => line.replace(/^–\s*/, "• "));
		sections.push(`### Read With Care\n${warningLines.join("\n")}`);
	}

	return sections.join("\n\n");
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
			const netFill = analysis.stock.netFillPerDay;
			// The sign comes from the flow only: extraction above sales is a gain
			// (+), sales above extraction is a loss (-). The cap is a separate fact
			// - it decides whether a gain is stored or discarded, which the loss
			// line below states.
			const rate =
				netFill !== undefined
					? `rate of loss/gain is ${netFill > 0 ? "+" : ""}${netFill.toLocaleString()} bbl/day`
					: "the rate of loss/gain is unknown because extraction is unmeasured";
			lines.push(
				`• **Cannot drain** — storage is ${d.stock.fillPct}% full, and ${rate}.`,
			);
		}

		// A loss is only reported while one is actually happening, and only where one
		// can happen at all.
		//
		// The first branch is genuinely present-tense: the plan zeroes
		// `discardedBarrelsPerDay` unless the warehouse is physically full.
		//
		// `warehouseCritical` is a WARNING threshold (95%), not the cap. Treating it
		// as "at capacity" made the brief claim a present-tense loss with thousands
		// of barrels of free room left, which is both wrong and alarming. Only
		// `atCapacity` (100%) may assert a loss; the warning gets its own line
		// stating exactly how much room is left.
		const atCap = d.stock.atCapacity;
		const freeBarrels = Math.max(
			0,
			analysis.decision.storageCap - analysis.decision.inStock,
		);
		const netFill = d.stock.netFillPerDay ?? 0;
		const daysToCap =
			netFill > 0 ? Math.max(1, Math.ceil(freeBarrels / netFill)) : undefined;

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
		} else if (d.stock.warehouseCritical && !draining) {
			// Near the cap and still filling: nothing has been lost yet, but the
			// remaining room is the number that matters.
			lines.push(
				`• **Not losing yet** — ${d.stock.fillPct}% full leaves ${freeBarrels.toLocaleString()} bbl of room${daysToCap ? `, about ${daysToCap} day${daysToCap === 1 ? "" : "s"} of surplus at the measured ${netFill.toLocaleString()} bbl/day` : ""}. Barrels are only discarded once the warehouse is completely full (${OIL_RIG_POLICY.inventory.atCapPct}%).`,
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
		// Extraction outrunning sales is a fact worth stating even when it is not yet
		// a constraint. Without this the brief said "nothing outstanding" while stock
		// was visibly accumulating, because the regime correctly waits for storage
		// pressure and the renderer never mentioned the trend it was waiting on.
		if (d.stock.isFillingUp) {
			const netFill = d.stock.netFillPerDay ?? 0;
			const pressure = OIL_RIG_POLICY.capacity.enterMinFillPct;
			const fillFlow =
				produced !== undefined
					? `extraction ${produced.toLocaleString()} vs sales ${sold.toLocaleString()} bbl/day`
					: `sales ${sold.toLocaleString()} bbl/day, with extraction unmeasured`;
			const rate =
				netFill > 0
					? `so storage is filling about ${netFill.toLocaleString()} bbl/day`
					: "and extraction only matches sales, so storage is holding its level";
			const barrelsToPressure = Math.round(
				((pressure - d.stock.fillPct) / 100) * analysis.decision.storageCap,
			);
			const daysToPressure =
				netFill > 0
					? Math.max(1, Math.ceil(barrelsToPressure / netFill))
					: undefined;
			const trigger =
				d.stock.fillPct < pressure
					? `Sell-through advice starts at ${pressure}% full — about ${barrelsToPressure.toLocaleString()} bbl away${daysToPressure ? ` (~${daysToPressure} day${daysToPressure === 1 ? "" : "s"} at this rate)` : ""} — plus ${OIL_RIG_POLICY.capacity.enterConsecutiveFillDays} consecutive recorded fill days once there.`
					: `A sell-through rebalance needs ${OIL_RIG_POLICY.capacity.enterConsecutiveFillDays} consecutive recorded fill days at or above ${pressure}% full, which the records do not yet show.`;
			lines.push(
				`• **Accumulating, not yet a constraint** — ${fillFlow}, ${rate} (now ${d.stock.fillPct}%). ${trigger}`,
			);
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
	if (t1.length > 0) doThis.push(`• **Rehab now:** ${rehabList(t1)}`);

	if (d.pricing.isChanged) {
		doThis.push(
			`• **Price:** ${d.pricing.formatted} _(${d.pricing.basis.replace(/_/g, " ")}, ${d.pricing.confidence} confidence)_`,
		);
	}
	if (d.adSpend.isChanged) {
		doThis.push(
			`• **Ad budget:** ${d.adSpend.formatted} (${d.adSpend.basis.replace(/_/g, " ")})`,
		);
	}

	const nothingToDo =
		d.roleTransfers.length === 0 &&
		t1.length === 0 &&
		d.pricing.isChanged === false &&
		d.adSpend.isChanged === false;

	const upgradeLines = renderUpgradeRecommendations(d.upgrades);

	const accumulationNote = analysis.stock.isFillingUp
		? (analysis.stock.netFillPerDay ?? 0) > 0
			? ` Stock is accumulating ${(analysis.stock.netFillPerDay ?? 0).toLocaleString()} bbl/day at ${analysis.stock.fillPct}% full; the Capacity section states the trigger and the room left.`
			: ` Extraction matches sales, so storage is holding at ${analysis.stock.fillPct}% full; the Capacity section states the trigger and the room left.`
		: "";

	if (nothingToDo && upgradeLines.length > 0) {
		doThis.push(
			`• **No operational changes** — roster, price, advertising and staff health are at target; the upgrades below are the outstanding work.${accumulationNote}`,
		);
	} else if (nothingToDo) {
		doThis.push(
			`• **${accumulationNote ? "No action yet" : "Nothing outstanding"}** — roster, price, advertising and staff health are all where the engines want them.${accumulationNote}`,
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
