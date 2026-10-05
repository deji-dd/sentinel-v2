import { buildCompanyDirectives } from "./company-directives";
import { Logger } from "./logger";
import {
	analyzeStockAndPricing,
	buildWeekToDateLogEntries,
	estimateDailyProduced,
	formatHistoryTable,
	formatWeekToDateSummary,
	formatWeekToDateTable,
	latestMeasuredProduction,
	type OilRigHistoryRecord,
	solveOptimalRoster,
} from "./oil-rig";

const logger = new Logger("DirectorBriefing");

export interface EmployeeSnapshot {
	id: number;
	name: string;
	position?: { id?: number; name?: string } | null;
	days_in_company: number;
	wage: number;
	stats: {
		manual_labor: number;
		intelligence: number;
		endurance: number;
	};
	effectiveness: {
		working_stats: number;
		settled_in: number;
		director_education: number;
		addiction: number;
		inactivity: number;
		total: number;
	};
}

export interface CompanySnapshot {
	profile: {
		name: string;
		rating: number;
		funds: number;
		efficiency: number;
		environment: number;
		popularity: number;
		income: { daily: number; weekly: number };
		customers: { daily: number; weekly: number };
		employees: { hired: number; capacity: number };
		upgrades: { storage_capacity?: number };
		advertisement_budget: number;
	};
	stock: Array<{
		name: string;
		price: number;
		in_stock: number;
		sold_amount: number;
		sold_worth: number;
	}>;
	employees: EmployeeSnapshot[];
}

export interface DirectorBriefingOptions {
	useLiveData?: boolean;
	customSnapshot?: CompanySnapshot;
	fetchLiveData?: () => Promise<CompanySnapshot>;
	fetchHistory?: () => Promise<OilRigHistoryRecord[]>;
}

export async function sendDiscordDm(
	userId: string,
	token: string,
	content: { embeds: unknown[] },
): Promise<void> {
	// 1. Create DM channel
	const channelRes = await fetch(
		"https://discord.com/api/v10/users/@me/channels",
		{
			method: "POST",
			headers: {
				Authorization: `Bot ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ recipient_id: userId }),
		},
	);

	if (!channelRes.ok) {
		const text = await channelRes.text();
		throw new Error(`Failed to create DM channel: ${text}`);
	}

	const channelData = (await channelRes.json()) as { id: string };

	// 2. Send DM message
	const msgRes = await fetch(
		`https://discord.com/api/v10/channels/${channelData.id}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bot ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(content),
		},
	);

	if (!msgRes.ok) {
		const text = await msgRes.text();
		throw new Error(`Failed to send DM message: ${text}`);
	}
}

export async function callGemini(
	prompt: string,
	apiKey: string,
): Promise<string | null> {
	const models = ["gemini-flash-latest"];
	for (const model of models) {
		try {
			logger.info(`Requesting completion from Google AI (${model})...`);
			const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					// Analysis only: a few bullets, so a tight cap keeps latency and
					// cost down without risking truncation of the answer.
					generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
				}),
			});

			if (res.ok) {
				const json = (await res.json()) as {
					candidates?: Array<{
						content?: { parts?: Array<{ text?: string }> };
					}>;
				};
				const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
				if (text) return text.trim();
			} else {
				const errText = await res.text();
				logger.warn(`Google AI ${model} returned ${res.status}: ${errText}`);
			}
		} catch (err) {
			logger.warn(`Google AI ${model} call error: ${err}`);
		}
	}
	return null;
}

/**
 * Loads the latest company snapshot directly from the PostgreSQL database.
 */
export async function loadLatestSnapshotFromDb(): Promise<CompanySnapshot | null> {
	try {
		const { db, desc, oilRigSnapshots } = await import("../../database");
		const rows = await db
			.select()
			.from(oilRigSnapshots)
			.orderBy(desc(oilRigSnapshots.timestamp))
			.limit(1);
		const row = rows[0];
		if (!row) {
			logger.warn("No oil rig snapshots found in PostgreSQL database.");
			return null;
		}

		const stockArr = Array.isArray(row.stock)
			? (row.stock as CompanySnapshot["stock"])
			: [row.stock as CompanySnapshot["stock"][number]];

		const rawEmployees = (
			Array.isArray(row.employees) ? row.employees : []
		) as Array<Record<string, unknown>>;

		const employees: EmployeeSnapshot[] = rawEmployees.map((emp) => {
			const stats = (emp.stats ?? {}) as Record<string, unknown>;
			const eff = (emp.effectiveness ?? {}) as Record<string, unknown>;
			const pos = emp.position as { id?: number; name?: string } | undefined;

			return {
				id: Number(emp.id ?? 0),
				name: String(emp.name ?? ""),
				position: pos ?? {
					id: Number(emp.positionId ?? 0),
					name: String(emp.positionName ?? ""),
				},
				days_in_company: Number(emp.days_in_company ?? emp.daysInCompany ?? 0),
				wage: Number(emp.wage ?? 0),
				stats: {
					manual_labor: Number(stats.manual_labor ?? stats.manualLabor ?? 0),
					intelligence: Number(stats.intelligence ?? 0),
					endurance: Number(stats.endurance ?? 0),
				},
				effectiveness: {
					working_stats: Number(eff.working_stats ?? eff.workingStats ?? 0),
					settled_in: Number(eff.settled_in ?? eff.settledIn ?? 0),
					director_education: Number(
						eff.director_education ?? eff.directorEducation ?? 0,
					),
					addiction: Number(eff.addiction ?? 0),
					inactivity: Number(eff.inactivity ?? 0),
					total: Number(eff.total ?? 0),
				},
			};
		});

		return {
			profile: row.profile as unknown as CompanySnapshot["profile"],
			employees,
			stock: stockArr,
		};
	} catch (err) {
		logger.error(
			`Failed to load latest snapshot from database: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

/**
 * Loads up to `days` rolling snapshots directly from PostgreSQL database in chronological order.
 */
export async function loadRollingHistory(
	days = 14,
): Promise<OilRigHistoryRecord[]> {
	try {
		const { db, desc, oilRigSnapshots } = await import("../../database");
		const rows = await db
			.select()
			.from(oilRigSnapshots)
			.orderBy(desc(oilRigSnapshots.timestamp))
			.limit(days + 5);

		if (rows && rows.length > 0) {
			const chronological = rows.reverse();
			const mapped = chronological.map((r, idx) => {
				const metrics = r.metrics as {
					emptyEmployeeSlots?: number;
					employeesWithAddiction?: number;
					totalAddictionPenalty?: number;
					unsettledEmployees?: number;
				};
				const fillPct =
					r.storageCapacity > 0
						? Number(((r.barrelsInStock / r.storageCapacity) * 100).toFixed(1))
						: 0;

				const rawEmps = (
					Array.isArray(r.employees) ? r.employees : []
				) as Array<Record<string, unknown>>;
				const dailyWages = rawEmps.reduce(
					(sum, e) => sum + Number(e.wage ?? 0),
					0,
				);
				const dailyProfit = r.dailyRevenue - dailyWages - (r.adBudget ?? 0);

				let dailyProduced: number | undefined;
				const prev = idx > 0 ? chronological[idx - 1] : undefined;
				if (prev) {
					dailyProduced = estimateDailyProduced({
						current: {
							inStock: r.barrelsInStock,
							sold: r.barrelsSold,
							timestamp: Math.floor(r.timestamp.getTime() / 1000),
						},
						previous: {
							inStock: prev.barrelsInStock,
							timestamp: Math.floor(prev.timestamp.getTime() / 1000),
						},
					});
				}
				if (dailyProduced === undefined && r.barrelsSold > 0) {
					dailyProduced = r.barrelsSold;
				}

				return {
					timestamp: Math.floor(r.timestamp.getTime() / 1000),
					isoDate: r.timestamp.toISOString().slice(0, 10),
					stars: r.rating,
					dailyIncome: r.dailyRevenue,
					weeklyIncome: r.weeklyRevenue,
					dailyWages,
					dailyProfit,
					dailyProduced,
					efficiency: r.efficiency,
					environment: r.environment,
					popularity: r.popularity,
					adBudget: r.adBudget,
					stock: {
						barrelPrice: r.barrelPrice,
						inStock: r.barrelsInStock,
						soldAmount: r.barrelsSold,
						fillPct,
					},
					metrics: {
						emptyEmployeeSlots: metrics?.emptyEmployeeSlots ?? 0,
						employeesWithAddiction: metrics?.employeesWithAddiction ?? 0,
						totalAddictionPenalty: metrics?.totalAddictionPenalty ?? 0,
						unsettledEmployees: metrics?.unsettledEmployees ?? 0,
					},
				};
			});
			return mapped.slice(-days);
		}
	} catch (err) {
		logger.error(
			`Failed to load rolling history from database: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return [];
}

export async function generateAndSendDirectorBriefing(
	options?: DirectorBriefingOptions,
): Promise<string> {
	let snap: CompanySnapshot | null = null;

	if (options?.customSnapshot) {
		snap = options.customSnapshot;
	} else if (options?.useLiveData) {
		if (options?.fetchLiveData) {
			snap = await options.fetchLiveData();
		} else {
			try {
				const { tornApi } = await import("../../torn-api");
				const res = (await tornApi.getPersonal("/company", {
					queryParams: { selections: ["profile", "employees", "stock"] },
				})) as unknown as {
					profile: CompanySnapshot["profile"];
					employees: CompanySnapshot["employees"];
					stock: CompanySnapshot["stock"];
				};
				if (res?.profile) {
					snap = res;
				}
			} catch (apiErr) {
				logger.warn(
					`Failed to fetch live company data: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`,
				);
			}
		}
	}

	// If not live, or live fetch returned null, load latest recorded snapshot directly from DB
	if (!snap) {
		snap = await loadLatestSnapshotFromDb();
	}

	if (!snap) {
		throw new Error(
			"No oil rig snapshot available in database or via live API.",
		);
	}

	// Load rolling 7-14 day history strictly from DB (or custom fetcher if provided)
	let history: OilRigHistoryRecord[] = [];
	if (options?.fetchHistory) {
		try {
			history = await options.fetchHistory();
		} catch {
			history = [];
		}
	} else {
		history = await loadRollingHistory(14);
	}

	const historyTable = formatHistoryTable(history);

	const discordToken = process.env.DISCORD_TOKEN;
	const discordUserId = process.env.DISCORD_USER_ID;
	const geminiApiKey = process.env.GEMINI_API_KEY;

	const oilStock = snap.stock[0];
	const storageCap = snap.profile.upgrades.storage_capacity ?? 750000;
	const inStock = oilStock?.in_stock ?? 0;
	const fillPct = ((inStock / storageCap) * 100).toFixed(1);
	const dailySold = oilStock?.sold_amount ?? 0;
	const currentPrice = oilStock?.price ?? 181;

	// Profit calculations must NEVER be live; always pull from DB snapshots
	// because live wage or budget changes would distort historical/current tick accounting.
	const latestDbRecord =
		history.length > 0 ? history[history.length - 1] : undefined;

	const dailyRevenue = latestDbRecord?.dailyIncome ?? snap.profile.income.daily;
	const dailyWages =
		latestDbRecord?.dailyWages ??
		snap.employees.reduce((sum, e) => sum + (e.wage ?? 0), 0);

	// The ad budget is an operator *setting*, not an accounting fact. The
	// recommendation engine must compare its target against the setting that is
	// actually live right now, otherwise a target derived from the live value is
	// compared against a stale recorded one and can never be satisfied. The
	// recorded tick value is kept separately for profit accounting only.
	const recordedTickAdBudget = latestDbRecord?.adBudget;
	const liveAdBudget = Number(snap.profile.advertisement_budget ?? 0);
	const currentAdBudget =
		liveAdBudget > 0 ? liveAdBudget : (recordedTickAdBudget ?? 0);
	const dailyAdBudget = recordedTickAdBudget ?? currentAdBudget;
	const dailyProfit =
		latestDbRecord?.dailyProfit ?? dailyRevenue - dailyWages - dailyAdBudget;

	// State the setting the director actually controls, and only mention the
	// recorded tick value when the two have drifted apart.
	const adBudgetTelemetry =
		recordedTickAdBudget !== undefined &&
		recordedTickAdBudget !== currentAdBudget
			? `$${currentAdBudget.toLocaleString()}/day (current setting; the last recorded tick spent $${recordedTickAdBudget.toLocaleString()})`
			: `$${currentAdBudget.toLocaleString()}/day`;

	// Only a *measured* extraction rate may drive the drain model. The rolling
	// loader fills an unmeasurable first day with that day's sales for display,
	// and treating that estimate as measured would wrongly declare the warehouse
	// unable to drain and trigger a capacity rebalance.
	const dailyProduced = latestMeasuredProduction(history);
	const producedValue =
		dailyProduced !== undefined ? dailyProduced * currentPrice : undefined;

	// Build strictly Monday - Sunday week-to-date daily logs directly from DB snapshots
	const wtdSummary = buildWeekToDateLogEntries({
		history,
	});
	const wtdProfit = wtdSummary.totalProfit;
	const wtdTable = formatWeekToDateTable(wtdSummary);
	const wtdSummaryText = formatWeekToDateSummary(wtdSummary);

	// Build raw employee matrix table for LLM
	const employeeRows = snap.employees
		.map((e) => {
			const posName =
				e.position?.name && e.position.name.trim() !== ""
					? e.position.name
					: "Unassigned";
			const man = `${Math.round(e.stats.manual_labor / 1000)}k`;
			const int = `${Math.round(e.stats.intelligence / 1000)}k`;
			const end = `${Math.round(e.stats.endurance / 1000)}k`;
			const add =
				e.effectiveness.addiction < 0
					? `${e.effectiveness.addiction} pts`
					: "Clean";
			const curScore = e.effectiveness.working_stats;
			return `| ${e.name} | ${posName} | ${man} | ${int} | ${end} | +${e.effectiveness.settled_in} | ${add} | ${curScore} |`;
		})
		.join("\n");
	const employeeTable = `| Name | Current Role | MAN | INT | END | Settle | Addiction | Work Score |\n|---|---|---|---|---|---|---|---|\n${employeeRows}`;

	// Run dynamic domain engines. Order matters: the stock analysis identifies the
	// bottleneck, that bottleneck re-shapes the roster quotas, and one assignment
	// then solves the lineup - so the rebalance advice and the target lineup can
	// never contradict each other.
	const stockAnalysis = analyzeStockAndPricing({
		inStock,
		storageCap,
		dailySold,
		dailyProduced,
		currentPrice,
		adBudget: currentAdBudget,
		dailyIncome: snap.profile.income.daily,
	});

	// Smart re-arrangement. When the warehouse is full because extraction outruns
	// sell-through, the roster is in the wrong shape: moving capacity into sales
	// beats changing price or ads, because a discarded barrel earns nothing while
	// a cleared barrel earns its full sale price (wages are committed either way).
	// The stock analysis identifies the bottleneck, and that bottleneck re-shapes
	// the roster quotas, so one assignment solves the lineup.
	const rosterAnalysis = solveOptimalRoster(snap.employees, {
		bottleneck: {
			extractionBound:
				stockAnalysis.isFillingUp || stockAnalysis.warehouseCritical,
		},
	});

	// ---- Shared directive set ------------------------------------------------
	// The same builder feeds the Discord briefing and the v2 API dashboard, so
	// the two surfaces can never hand out different instructions.
	const directives = buildCompanyDirectives({
		roster: rosterAnalysis,
		stock: stockAnalysis,
		history,
		currentAdBudget,
		barrelPrice: currentPrice,
		openSeats: Math.max(
			0,
			snap.profile.employees.capacity - snap.profile.employees.hired,
		),
		staffCount: snap.employees.length,
	});

	const capacityPlan = directives.capacityRebalance;
	const sellThrough = directives.sellThrough;

	// The engine decides whether a change is actually required; re-deriving this
	// from action names or raw value comparisons is what let the briefing demand
	// the same change on every fetch.
	const hasRoleTransfers = directives.roleTransfers.length > 0;
	const hasPriceSuggestion = stockAnalysis.recommendedPrice.changeNeeded;
	const hasAdSuggestion = stockAnalysis.recommendedAdSpend.changeNeeded;

	const wageSharePct =
		dailyRevenue > 0 ? ((dailyWages / dailyRevenue) * 100).toFixed(1) : "0.0";

	const performanceDigest = [
		`• Price response: ${sellThrough.summary}`,
		`• Capacity: extraction ${dailyProduced !== undefined ? `${dailyProduced.toLocaleString()} bbl/day` : "unknown"} vs ${dailySold.toLocaleString()} bbl/day sold -> ${
			stockAnalysis.isFillingUp
				? `extraction matches or beats sales, so stock cannot drain${
						stockAnalysis.warehouseCritical
							? " and the measured rate is capped by full storage, so true extraction is higher"
							: ""
					}`
				: stockAnalysis.netDrainPerDay !== undefined
					? `draining ${stockAnalysis.netDrainPerDay.toLocaleString()} bbl/day`
					: "no drain detected"
		}`,
		`• Discarded output: median ${capacityPlan.discardedBarrelsPerDay.toLocaleString()} bbl/day, peak ${capacityPlan.discardedPeakPerDay.toLocaleString()} bbl/day, measured across ${capacityPlan.discardedSamples} day(s) where storage was not yet full`,
		`• Wage efficiency: $${dailyWages.toLocaleString()}/day = ${wageSharePct}% of revenue; net ${dailyProfit >= 0 ? "+" : ""}$${dailyProfit.toLocaleString()}/day ($${(dailyProfit / Math.max(1, dailySold)).toFixed(2)}/bbl)`,
		`• Sell-through per day: ${dailySold.toLocaleString()} bbl at $${currentPrice} = $${(dailySold * currentPrice).toLocaleString()}`,
	].join("\n");

	// Dynamically format active transfers and target lineup
	let transfersFormatted = "";
	let lineupFormatted = "";
	if (hasRoleTransfers) {
		transfersFormatted = rosterAnalysis.activeTransfers
			.map(
				(t) =>
					`• **${t.name}** (${t.statsStr}): ${t.fromRole} ➔ **${t.toRole}**`,
			)
			.join("\n");

		lineupFormatted = Object.entries(rosterAnalysis.rosterByRole)
			.map(
				([role, members]) =>
					`• **${role}** (${members.length}): ${members.join(" • ")}`,
			)
			.join("\n");
	}

	// Dynamically format rehab tiers
	const t1 = rosterAnalysis.rehabTiers.tier1;
	const t2 = rosterAnalysis.rehabTiers.tier2;
	const t3 = rosterAnalysis.rehabTiers.tier3;
	const hasAddiction = t1.length > 0 || t2.length > 0 || t3.length > 0;

	let rehabFormatted = "";
	if (!hasAddiction) {
		rehabFormatted =
			"• **Staff Health:** Zero addiction debuffs detected across all staff.";
	} else {
		const lines: string[] = [];
		if (t1.length > 0) {
			lines.push(
				`• **Tier 1 (Send Today):** ${t1.map((e) => `**${e.name}** (${e.penalty} pts)`).join(" • ")}.`,
			);
		}
		if (t2.length > 0) {
			lines.push(
				`• **Tier 2 (Send Next):** ${t2.map((e) => `**${e.name}** (${e.penalty} pts)`).join(" • ")}.`,
			);
		}
		if (t3.length > 0) {
			lines.push(
				`• **Tier 3 (Monitor):** ${t3.map((e) => `**${e.name}** (${e.penalty} pts)`).join(" • ")}.`,
			);
		}
		rehabFormatted = lines.join("\n");
	}

	// Stock & Pricing bullets conditionally formatted
	const stockVerdictBullets: string[] = [];
	if (
		hasPriceSuggestion ||
		hasAdSuggestion ||
		stockAnalysis.state !== "equilibrium"
	) {
		stockVerdictBullets.push(
			`• **Storage Status:** ${stockAnalysis.stateDescription}`,
		);
	}
	if (hasPriceSuggestion) {
		stockVerdictBullets.push(
			`• **Pricing:** ${stockAnalysis.recommendedPrice.formatted}`,
		);
	}
	if (hasAdSuggestion) {
		stockVerdictBullets.push(
			`• **Ad Budget:** ${stockAnalysis.recommendedAdSpend.formatted}`,
		);
	}
	// A full warehouse that extraction still outruns cannot be cleared by any
	// price or ad setting, so say what actually has to change.
	if (stockAnalysis.structuralAdvice) {
		stockVerdictBullets.push(
			`• **Structural Constraint:** ${stockAnalysis.structuralAdvice}`,
		);
	}

	// Capacity rebalance bullets: the re-arrangement alternative to price/ads.
	const capacityBullets: string[] = [];
	if (capacityPlan.extractionBound) {
		if (capacityPlan.discardedBarrelsPerDay > 0) {
			capacityBullets.push(
				`• **Discarded Output:** about ${capacityPlan.discardedBarrelsPerDay.toLocaleString()} bbl/day (~$${capacityPlan.discardedValuePerDay.toLocaleString()}/day) is produced beyond what the rig clears, and is lost while storage is full.`,
			);
		}
		for (const action of capacityPlan.actions) {
			const label =
				action.kind === "rebalance"
					? "Rebalance Roster"
					: action.kind === "hire"
						? `Hire ${capacityPlan.hires} x Sales Executive`
						: "Storage Is Not The Fix";
			const revert = action.temporary
				? " Revert once storage is back inside the 35%–75% buffer."
				: "";
			capacityBullets.push(`• **${label}:** ${action.reason}${revert}`);
		}
	}

	// The action list is rendered deterministically from the engines above. The
	// model is deliberately NOT asked to reproduce it: asking an LLM to copy
	// pre-computed facts is what previously needed six regex passes to undo.
	const actionParts: string[] = [];
	if (hasRoleTransfers) {
		actionParts.push(`**Role Transfers:**\n${transfersFormatted}`);
		actionParts.push(`**Target Lineup:**\n${lineupFormatted}`);
	}
	actionParts.push(`**Mandatory Swiss Rehab:**\n${rehabFormatted}`);
	if (capacityBullets.length > 0) {
		actionParts.push(`**Capacity Rebalance:**\n${capacityBullets.join("\n")}`);
	}
	if (!hasRoleTransfers && !hasAddiction && capacityBullets.length === 0) {
		actionParts.push(
			"• **All operations optimal** — roster is aligned with the target blueprint, all staff are clean, and stock is inside the healthy buffer.",
		);
	}

	const deterministicSections: string[] = [
		`### Immediate Action Items\n\n${actionParts.join("\n\n")}`,
	];
	if (stockVerdictBullets.length > 0) {
		deterministicSections.push(
			`### Stock & Pricing Verdict\n${stockVerdictBullets.join("\n")}`,
		);
	}
	const deterministicBriefing = deterministicSections.join("\n\n");

	// The model is used for what it is actually good at: reading the numbers and
	// explaining what they mean. Everything numerically actionable is computed
	// above, so the model can no longer corrupt it or need sanitising.
	const prompt = `
You are the Chief Operations Advisor for Succession Oil, a Torn City Oil Rig.
All figures below are computed from this rig's own recorded daily snapshots.
Your job is ANALYSIS: explain what the numbers mean and what to watch next.

HARD RULES:
- Use ONLY the figures supplied. Never invent a benchmark, competitor statistic, price range or target.
- If the data cannot support a conclusion, say so plainly rather than guessing.
- Output 3 to 5 bullets, each starting with "• ", 900 characters maximum in total.
- Do NOT repeat or reformat the action list; the director already has it verbatim.
- No emojis, no headers, no preamble, no tables, no sign-off.

---
### LIVE TELEMETRY
• Rating: ${snap.profile.rating}★
• Daily Revenue: $${dailyRevenue.toLocaleString()} | Weekly Revenue: $${snap.profile.income.weekly.toLocaleString()}
• Daily Profit: ${dailyProfit >= 0 ? "+" : ""}$${dailyProfit.toLocaleString()} | WTD Profit: ${wtdProfit >= 0 ? "+" : ""}$${wtdProfit.toLocaleString()}
• Stock: ${inStock.toLocaleString()} / ${storageCap.toLocaleString()} bbl (${fillPct}% full)
• Daily Sales: ${dailySold.toLocaleString()} bbl at $${currentPrice}/bbl
• Ad Budget: ${adBudgetTelemetry} | Daily customers reported: ${snap.profile.customers.daily}
• Staff: ${snap.profile.employees.hired}/${snap.profile.employees.capacity} | Efficiency: ${snap.profile.efficiency}% | Environment: ${snap.profile.environment}% | Popularity: ${snap.profile.popularity}%

---
### COMPUTED ANALYSIS (authoritative — do not contradict)
${performanceDigest}
• Inventory state: ${stockAnalysis.state.toUpperCase()} — ${stockAnalysis.stateDescription}
${stockAnalysis.structuralAdvice ? `• Structural constraint: ${stockAnalysis.structuralAdvice}` : "• Structural constraint: none detected."}

---
### ROSTER TARGETS
${hasRoleTransfers ? `• Transfers required:\n${transfersFormatted}` : "• Roster is already in its target roles."}
• Quotas for ${snap.employees.length} staff: ${Object.entries(
		rosterAnalysis.targetQuotas,
	)
		.map(([role, count]) => `${role} ${count}`)
		.join(", ")}

---
### ROSTER MATRIX
${employeeTable}

---
### RECORDED HISTORY
${historyTable}

---
### ACTIONS ALREADY ISSUED (do not repeat these)
${actionParts.join("\n")}
${stockVerdictBullets.join("\n")}

---
Write the analysis bullets now.`;

	// The deterministic section is always delivered as-is; the model only appends
	// analysis. There is nothing left to sanitise, and no fallback path to keep in
	// sync, because the model never produced the authoritative content.
	let advisorText = deterministicBriefing;
	if (geminiApiKey) {
		const llmOutput = await callGemini(prompt, geminiApiKey);
		if (llmOutput) {
			const notes = llmOutput
				.replace(/^#{1,6}.*$/gm, "") // drop any header the model adds anyway
				.replace(/^\*\*(Analyst Notes|Analysis):?\*\*$/gim, "")
				.trim()
				.slice(0, 1200);
			if (notes) {
				advisorText = `${deterministicBriefing}\n\n### Analyst Notes\n${notes}`;
			}
		} else {
			logger.warn(
				"No analyst notes returned; delivering the deterministic briefing only.",
			);
		}
	}

	const signDaily = dailyProfit >= 0 ? "+" : "";
	const signWtd = wtdProfit >= 0 ? "+" : "";
	const prodText =
		dailyProduced !== undefined
			? `${dailyProduced.toLocaleString()} bbl`
			: "N/A";
	const prodValText =
		producedValue !== undefined ? `$${producedValue.toLocaleString()}` : "N/A";

	// Single source for the telemetry summary, reused by the console output, the
	// Discord embed and the returned value so all three always agree.
	const detailsLine = `Daily Rev: $${dailyRevenue.toLocaleString()} | Daily Wages: $${dailyWages.toLocaleString()} | Daily Ad: $${dailyAdBudget.toLocaleString()} | Daily Profit: ${signDaily}$${dailyProfit.toLocaleString()} | WTD Profit: ${signWtd}$${wtdProfit.toLocaleString()}`;
	const stockLine = `Stock: ${inStock.toLocaleString()}/${storageCap.toLocaleString()} (${fillPct}%) | Sold: ${dailySold.toLocaleString()} bbl | Produced: ${dailyProduced?.toLocaleString() ?? "N/A"} bbl`;
	const companyDetailsText = `${detailsLine}\n${stockLine}`;

	logger.info("================ EXECUTIVE BRIEFING ================");
	console.log(advisorText);
	console.log("\n================ COMPANY DETAILS ================");
	console.log(detailsLine);
	console.log(stockLine);
	console.log(
		"\n================ WEEK-TO-DATE LOGS (MON–SUN) ================",
	);
	console.log(wtdTable);
	console.log(wtdSummaryText);
	logger.info("====================================================");

	// Send Discord DMs as 2 messages: advice, then details plus week-to-date logs.
	if (discordToken && discordUserId) {
		logger.info(`Sending Discord DMs to user ${discordUserId}...`);

		const addictedEmployees = snap.employees.filter(
			(e) => (e.effectiveness.addiction ?? 0) < 0,
		);
		const totalAddictionPenalty = Math.abs(
			addictedEmployees.reduce(
				(sum, e) => sum + (e.effectiveness.addiction ?? 0),
				0,
			),
		);

		// Message 1: All Advice in one embed
		await sendDiscordDm(discordUserId, discordToken, {
			embeds: [
				{
					title: `Succession Oil (${snap.profile.rating}★) — Operations Advice (Part 1/2)`,
					description: advisorText.slice(0, 4000),
					color: 0xf59e0b, // Amber Gold
					footer: {
						text: "Sentinel • Strategic Operational Advisory",
					},
					timestamp: new Date().toISOString(),
				},
			],
		});

		// Message 2: Company Details in second embed
		await sendDiscordDm(discordUserId, discordToken, {
			embeds: [
				{
					title: `Succession Oil (${snap.profile.rating}★) — Company Details (Part 2/2)`,
					description: `Current operational telemetry and daily financials for **${snap.profile.name}**.`,
					color: 0x3b82f6, // Blue
					fields: [
						{
							name: "Financials",
							value: `Daily Rev: **$${dailyRevenue.toLocaleString()}**\nDaily Wages: **$${dailyWages.toLocaleString()}**\nDaily Ad: **$${dailyAdBudget.toLocaleString()}**\nDaily Profit: **${signDaily}$${dailyProfit.toLocaleString()}**\nWTD Profit: **${signWtd}$${wtdProfit.toLocaleString()}**`,
							inline: true,
						},
						{
							name: "Stock & Production",
							value: `Price: **$${currentPrice}**/barrel\nStock: **${inStock.toLocaleString()}** (${fillPct}%)\nSold: **${dailySold.toLocaleString()}** bbl\nProduced: **${prodText}**\nProduced Value: **${prodValText}**`,
							inline: true,
						},
						{
							name: "Operational Health",
							value: `Efficiency: **${snap.profile.efficiency}%** | Environment: **${snap.profile.environment}%**\nPopularity: **${snap.profile.popularity}%** | Staff: **${snap.profile.employees.hired}/${snap.profile.employees.capacity}**\nAddicted Staff: **${addictedEmployees.length}** (-${totalAddictionPenalty} pts)`,
							inline: false,
						},
					],
					footer: {
						text: "Sentinel • Succession Oil Operations",
					},
					timestamp: new Date().toISOString(),
				},
			],
		});

		logger.info("Discord DMs successfully delivered (2 parts)!");
	} else {
		logger.warn("Discord credentials missing. Skipping DM.");
	}

	return [advisorText, companyDetailsText, wtdTable, wtdSummaryText].join(
		"\n\n",
	);
}
