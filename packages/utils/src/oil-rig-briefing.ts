import { Logger } from "./logger";
import {
	analyzeStockAndPricing,
	buildWeekToDateLogEntries,
	formatHistoryTable,
	formatWeekToDateSummary,
	formatWeekToDateTable,
	getCompetitorBenchmarkContext,
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
					generationConfig: { temperature: 0.2, maxOutputTokens: 3500 },
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
				if (prev && r.barrelsSold >= 0) {
					const delta = r.barrelsInStock - prev.barrelsInStock;
					const est = delta + r.barrelsSold;
					if (est >= 0) {
						dailyProduced = est;
					}
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
	const competitorBenchmark = getCompetitorBenchmarkContext();

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
	const dailyAdBudget =
		latestDbRecord?.adBudget ?? snap.profile.advertisement_budget;
	const dailyProfit =
		latestDbRecord?.dailyProfit ?? dailyRevenue - dailyWages - dailyAdBudget;

	let dailyProduced: number | undefined = latestDbRecord?.dailyProduced;
	if (dailyProduced === undefined && history.length >= 2) {
		const prev = history[history.length - 2];
		if (latestDbRecord && prev && latestDbRecord.stock.soldAmount >= 0) {
			const delta = latestDbRecord.stock.inStock - prev.stock.inStock;
			const est = delta + latestDbRecord.stock.soldAmount;
			if (est >= 0) {
				dailyProduced = est;
			}
		}
	}
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

	// Run dynamic domain engines
	const rosterAnalysis = solveOptimalRoster(snap.employees);
	const stockAnalysis = analyzeStockAndPricing({
		inStock,
		storageCap,
		dailySold,
		dailyProduced,
		currentPrice,
		adBudget: snap.profile.advertisement_budget,
		dailyIncome: snap.profile.income.daily,
	});

	const hasRoleTransfers = rosterAnalysis.activeTransfers.length > 0;
	const hasPriceSuggestion =
		stockAnalysis.recommendedPrice.action !== "maintain" &&
		stockAnalysis.recommendedPrice.exact !== currentPrice;
	const hasAdSuggestion =
		stockAnalysis.recommendedAdSpend.action !== "maintain" &&
		stockAnalysis.recommendedAdSpend.amount !== dailyAdBudget;

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

	// Action item rules for LLM
	const actionItemRules: string[] = [];
	if (hasRoleTransfers) {
		actionItemRules.push(
			`- Under "### Immediate Action Items", start directly with "**Role Transfers:**" (one concise bullet per transfer: "• **Employee** (KeyStat): CurrentRole ➔ **TargetRole**").`,
			`- Follow with "**Target Lineup:**" (one line summary per role: "• **RoleName** (Count): Name1, Name2, ...").`,
		);
	} else {
		actionItemRules.push(
			`- IMPORTANT: All employees are currently locked in their optimal target positions. STRICTLY DO NOT output any "**Role Transfers:**" or "**Target Lineup:**" sections.`,
		);
	}
	actionItemRules.push(
		`- For Swiss Rehab: Output concise tier bullets with employee names and penalties (or state zero debuffs).`,
	);

	if (hasPriceSuggestion) {
		actionItemRules.push(
			`- For Pricing: Output "• **Pricing:** ${stockAnalysis.recommendedPrice.formatted}"`,
		);
	} else {
		actionItemRules.push(
			`- IMPORTANT: Pricing is already optimal. STRICTLY DO NOT output any Pricing bullet.`,
		);
	}

	if (hasAdSuggestion) {
		actionItemRules.push(
			`- For Ad Budget: Output "• **Ad Budget:** ${stockAnalysis.recommendedAdSpend.formatted}"`,
		);
	} else {
		actionItemRules.push(
			`- IMPORTANT: Ad budget is already optimal. STRICTLY DO NOT output any Ad Budget bullet.`,
		);
	}
	actionItemRules.push(
		`- IMPORTANT: STRICTLY DO NOT output any "10★ Progression Roadmap" section.`,
	);

	const prompt = `
You are the Chief Operations Advisor for Succession Oil, a Torn City Oil Rig.
Conduct a concise strategic operational evaluation. You are provided with:
1. Live Telemetry & Rig Profile
2. Employee Roster Matrix
3. Rolling 7–14 Day History Table
4. Competitor & Market Benchmark
5. Torn Oil Rig Economic Principles & Calculated Baselines

FORMATTING & STYLE RULES:
- Output MUST be concise, punchy, and formatted strictly as actionable bullet points. No long paragraphs, essays, or wordy explanations.
${actionItemRules.join("\n")}
- Do NOT use any emojis anywhere in your output. Keep all text completely emoji-free.
- Do NOT output any memo header, greeting, or preamble (NO "TO:", "FROM:", "DATE:", "SUBJECT:", or "EXECUTIVE BRIEFING").
- Start directly with the first section header: "### Immediate Action Items".
- Use clean title-case headers ("### Immediate Action Items", "### Stock & Pricing Verdict"). Never use all-caps headers.
- Total character count MUST be under 1,500 characters so nothing ever truncates.

---
### DATA BLOCK 1: LIVE RIG TELEMETRY
• Rating: ${snap.profile.rating}★
• Daily Revenue: $${dailyRevenue.toLocaleString()} | Weekly Revenue: $${snap.profile.income.weekly.toLocaleString()}
• Daily Profit: ${dailyProfit >= 0 ? "+" : ""}$${dailyProfit.toLocaleString()} | WTD Profit: ${wtdProfit >= 0 ? "+" : ""}$${wtdProfit.toLocaleString()}
• Stock in Storage: ${inStock.toLocaleString()} / ${storageCap.toLocaleString()} barrels (${fillPct}% full)
• Daily Sales: ${dailySold.toLocaleString()} barrels at $${currentPrice}/barrel
• Daily Ad Budget: $${dailyAdBudget.toLocaleString()}/day (Daily customers: ${snap.profile.customers.daily})
• Current Staff: ${snap.profile.employees.hired}/${snap.profile.employees.capacity}
• Overall Efficiency: ${snap.profile.efficiency}% | Environment: ${snap.profile.environment}%

---
### DATA BLOCK 2: EMPLOYEE ROSTER MATRIX
${employeeTable}

---
### DATA BLOCK 3: ROLLING 7–14 DAY HISTORY
${historyTable}

---
### DATA BLOCK 4: COMPETITOR & MARKET BENCHMARK
${competitorBenchmark}

---
### DATA BLOCK 5: ECONOMIC RULES & SOLVER BASELINES
${hasRoleTransfers ? `• Role Transfer Solution:\n${transfersFormatted}\n• Finalized Target Lineup:\n${lineupFormatted}` : "• Roster: 100% optimal. All employees in target roles. 0 transfers needed."}
• Addiction Debuff Priorities:
${rehabFormatted}
• Inventory State & Recommendation: ${stockAnalysis.state.toUpperCase()} (${stockAnalysis.stateDescription})
• Pricing Engine Baseline: Action: ${stockAnalysis.recommendedPrice.action.toUpperCase()} | Exact: $${stockAnalysis.recommendedPrice.exact} | Suggested: ${hasPriceSuggestion ? "YES" : "NO"}
• Ad Spend Baseline: Action: ${stockAnalysis.recommendedAdSpend.action.toUpperCase()} | Amount: $${stockAnalysis.recommendedAdSpend.amount.toLocaleString()}/day | Suggested: ${hasAdSuggestion ? "YES" : "NO"}

---
### YOUR ADVISORY MANDATE:
Output the briefing strictly following this compact, actionable bullet structure (start directly with ### Immediate Action Items, NO introductory sentence):

### Immediate Action Items
${hasRoleTransfers ? `\n**Role Transfers:**\n${transfersFormatted}\n\n**Target Lineup:**\n${lineupFormatted}\n` : ""}
**Mandatory Swiss Rehab:**
${rehabFormatted}
${stockVerdictBullets.length > 0 ? `\n### Stock & Pricing Verdict\n${stockVerdictBullets.join("\n")}` : ""}
`;

	let advisorText = "";
	if (geminiApiKey) {
		const llmOutput = await callGemini(prompt, geminiApiKey);
		if (llmOutput) {
			advisorText = llmOutput;
			// Strip 10★ Progression Roadmap completely if generated
			advisorText = advisorText.replace(
				/###\s*10[★*]\s*Progression Roadmap[\s\S]*?(?=###|$)/gi,
				"",
			);
			advisorText = advisorText.replace(
				/\n• \*\*10[★*] Milestone:\*\*.*$/gm,
				"",
			);

			// If no role transfers, enforce stripping Role Transfers and Target Lineup
			if (!hasRoleTransfers) {
				advisorText = advisorText.replace(
					/\*\*Role Transfers:\*\*[\s\S]*?(?=\*\*(?:Target Lineup|Mandatory Swiss Rehab|Staff Health):\*\*|###|$)/gi,
					"",
				);
				advisorText = advisorText.replace(
					/\*\*Target Lineup:\*\*[\s\S]*?(?=\*\*(?:Mandatory Swiss Rehab|Staff Health):\*\*|###|$)/gi,
					"",
				);
			}

			// If no price suggestion, strip pricing bullet
			if (!hasPriceSuggestion) {
				advisorText = advisorText.replace(
					/[•\-*]\s*\*\*Pricing:\*\*.*$/gim,
					"",
				);
			}

			// If no ad suggestion, strip ad budget bullet
			if (!hasAdSuggestion) {
				advisorText = advisorText.replace(
					/[•\-*]\s*\*\*Ad Budget:\*\*.*$/gim,
					"",
				);
			}

			// If stock verdict is empty or has no bullets, strip the header
			advisorText = advisorText.replace(
				/###\s*Stock & Pricing Verdict\s*(?=(?:###|$))/gi,
				"",
			);

			// Strip bracketed rationale after target role
			advisorText = advisorText.replace(
				/(• \*\*.+?\*\* \([^\n)]+\): [^\n➔]+ ➔ \*\*[^\n*]+\*\*) \([^)\n]+\)/g,
				"$1",
			);

			advisorText = advisorText.trim();
		}
	}

	// Comprehensive deterministic fallback if LLM is offline or output was empty
	if (!advisorText) {
		const actionParts: string[] = [];
		if (hasRoleTransfers) {
			actionParts.push(`**Role Transfers:**\n${transfersFormatted}`);
			actionParts.push(`**Target Lineup:**\n${lineupFormatted}`);
		}
		actionParts.push(`**Mandatory Swiss Rehab:**\n${rehabFormatted}`);

		if (!hasRoleTransfers && !hasAddiction) {
			actionParts.push(
				"• **All operations optimal** — Roster is fully aligned with target blueprint and all staff are clean.",
			);
		}

		const sections: string[] = [
			`### Immediate Action Items\n\n${actionParts.join("\n\n")}`,
		];

		if (stockVerdictBullets.length > 0) {
			sections.push(
				`### Stock & Pricing Verdict\n${stockVerdictBullets.join("\n")}`,
			);
		}

		advisorText = sections.join("\n\n");
	}

	logger.info("================ EXECUTIVE BRIEFING ================");
	console.log(advisorText);
	console.log("\n================ COMPANY DETAILS ================");
	console.log(
		`Daily Rev: $${dailyRevenue.toLocaleString()} | Daily Wages: $${dailyWages.toLocaleString()} | Daily Ad: $${dailyAdBudget.toLocaleString()} | Daily Profit: ${dailyProfit >= 0 ? "+" : ""}$${dailyProfit.toLocaleString()} | WTD Profit: ${wtdProfit >= 0 ? "+" : ""}$${wtdProfit.toLocaleString()}`,
	);
	console.log(
		`Stock: ${inStock.toLocaleString()}/${storageCap.toLocaleString()} (${fillPct}%) | Sold: ${dailySold.toLocaleString()} bbl | Produced: ${dailyProduced?.toLocaleString() ?? "N/A"} bbl`,
	);
	console.log(
		"\n================ WEEK-TO-DATE LOGS (MON–SUN) ================",
	);
	console.log(wtdTable);
	console.log(wtdSummaryText);
	logger.info("====================================================");

	// Send Discord DMs as 3 distinct messages (Advice, Company Details, WTD Logs)
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

		const signDaily = dailyProfit >= 0 ? "+" : "";
		const signWtd = wtdProfit >= 0 ? "+" : "";
		const prodText =
			dailyProduced !== undefined
				? `${dailyProduced.toLocaleString()} bbl`
				: "N/A";
		const prodValText =
			producedValue !== undefined
				? `$${producedValue.toLocaleString()}`
				: "N/A";

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

	return `${advisorText}\n\n${wtdTable}\n\n${wtdSummaryText}`;
}
