import { Logger } from "./logger";
import {
	analyzeHiringPriorities,
	analyzeStockAndPricing,
	formatHistoryTable,
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
	const models = [
		"gemini-2.5-flash",
		"gemini-flash-latest",
		"gemini-3.5-flash",
	];
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

		return {
			profile: row.profile as unknown as CompanySnapshot["profile"],
			employees: row.employees as unknown as CompanySnapshot["employees"],
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
			.limit(days);

		if (rows && rows.length > 0) {
			return rows.reverse().map((r) => {
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

				return {
					timestamp: Math.floor(r.timestamp.getTime() / 1000),
					isoDate: r.timestamp.toISOString().slice(0, 10),
					stars: r.rating,
					dailyIncome: r.dailyRevenue,
					weeklyIncome: r.weeklyRevenue,
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
	let dailyProduced: number | undefined;
	if (history.length >= 2) {
		const latestHist = history[history.length - 1];
		const prevHist = history[history.length - 2];
		if (latestHist && prevHist && latestHist.stock.soldAmount > 0) {
			const delta = latestHist.stock.inStock - prevHist.stock.inStock;
			const estProduced = delta + latestHist.stock.soldAmount;
			if (estProduced >= 0) {
				dailyProduced = estProduced;
			}
		}
	}

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
	const hiringAnalysis = analyzeHiringPriorities(
		snap.profile.employees.hired,
		snap.profile.employees.capacity,
		rosterAnalysis.rosterByRole,
	);

	// Dynamically format active transfers
	let transfersFormatted = "";
	if (rosterAnalysis.activeTransfers.length > 0) {
		transfersFormatted = rosterAnalysis.activeTransfers
			.map(
				(t) =>
					`• **${t.name}** (${t.statsStr}): ${t.fromRole} ➔ **${t.toRole}**`,
			)
			.join("\n");
	} else {
		transfersFormatted =
			"**Roster is fully aligned with target blueprint** — all employees are locked in their designated positions.";
	}

	// Dynamically format target lineup
	const lineupFormatted = Object.entries(rosterAnalysis.rosterByRole)
		.map(
			([role, members]) =>
				`• **${role}** (${members.length}): ${members.join(", ")}`,
		)
		.join("\n");

	// Dynamically format rehab tiers
	const t1 = rosterAnalysis.rehabTiers.tier1;
	const t2 = rosterAnalysis.rehabTiers.tier2;
	const t3 = rosterAnalysis.rehabTiers.tier3;

	let rehabFormatted = "";
	if (t1.length === 0 && t2.length === 0 && t3.length === 0) {
		rehabFormatted =
			"• **Zero addiction penalties detected** across all staff.";
	} else {
		const lines: string[] = [];
		if (t1.length > 0) {
			lines.push(
				`• **Tier 1 (Send Today):** ${t1.map((e) => `**${e.name}** (${e.penalty} pts)`).join(", ")}.`,
			);
		}
		if (t2.length > 0) {
			lines.push(
				`• **Tier 2 (Send Next):** ${t2.map((e) => `**${e.name}** (${e.penalty} pts)`).join(", ")}.`,
			);
		}
		if (t3.length > 0) {
			lines.push(
				`• **Tier 3 (Monitor):** ${t3.map((e) => `**${e.name}** (${e.penalty} pts)`).join(", ")}.`,
			);
		}
		rehabFormatted = lines.join("\n");
	}

	const prompt = `
You are the Chief Operations Advisor for Succession Oil, a Torn City Oil Rig pushing for 10 stars.
You are conducting a thorough strategic evaluation. You are provided with:
1. Live Telemetry & Rig Profile
2. Employee Roster Matrix
3. Rolling 7–14 Day History Table
4. Competitor & Market Benchmark
5. Torn Oil Rig Economic Principles & Calculated Baselines

FORMATTING & STYLE RULES:
- Output MUST be concise, punchy, and formatted strictly as actionable bullet points. No long paragraphs, essays, or wordy explanations.
- Under "### Immediate Action Items", do NOT output any introductory text or explanation about efficiency or environment. Start IMMEDIATELY with "**Role Transfers:**".
- For Role Transfers: Output exactly ONE concise bullet per transfer: "• **Employee** (KeyStat): CurrentRole ➔ **TargetRole**". Do NOT include reasons, justifications, or text in brackets after the target role.
- For Target Lineup: Output a clean single-line summary for each role: "• **RoleName** (Count): Name1, Name2, ...".
- For Swiss Rehab: Output 3 concise tier bullets with employee names, debuffs, and a short 1-sentence risk note.
- For Stock & Pricing Verdict: Output exactly 3 concise one-line bullets (Storage Status, Pricing, Ad Budget). No rationale paragraph:
  • **Storage Status:** ${stockAnalysis.stateDescription}
  • **Pricing:** ${stockAnalysis.recommendedPrice.formatted}
  • **Ad Budget:** ${stockAnalysis.recommendedAdSpend.formatted}
- For 10★ Progression Roadmap: Output 1 crisp single-line bullet:
  • **Capacity Utilization (${hiringAnalysis.hired} ➔ ${hiringAnalysis.capacity} Seats):** Next priority hires: ${hiringAnalysis.shortSummary}
- Do NOT use any emojis anywhere in your output. Keep all text completely emoji-free.
- Do NOT output any memo header, greeting, or preamble (NO "TO:", "FROM:", "DATE:", "SUBJECT:", or "EXECUTIVE BRIEFING").
- Start directly with the first section header: "### Immediate Action Items".
- Use clean title-case headers ("### Immediate Action Items", "### Stock & Pricing Verdict", "### 10★ Progression Roadmap"). Never use all-caps headers.
- Total character count for each section MUST be under 1,500 characters so nothing ever truncates.

---
### DATA BLOCK 1: LIVE RIG TELEMETRY
• Rating: ${snap.profile.rating}★
• Daily Revenue: $${snap.profile.income.daily.toLocaleString()} | Weekly Revenue: $${snap.profile.income.weekly.toLocaleString()}
• Funds in Vault: $${snap.profile.funds.toLocaleString()}
• Stock in Storage: ${inStock.toLocaleString()} / ${storageCap.toLocaleString()} barrels (${fillPct}% full)
• Daily Sales: ${dailySold.toLocaleString()} barrels at $${currentPrice}/barrel
• Daily Ad Budget: $${snap.profile.advertisement_budget.toLocaleString()}/day (Daily customers: ${snap.profile.customers.daily})
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
• Role Transfer Solution:
${transfersFormatted}
• Finalized Target Lineup:
${lineupFormatted}
• Addiction Debuff Priorities:
${rehabFormatted}
• Inventory State & Recommendation: ${stockAnalysis.state.toUpperCase()} (${stockAnalysis.stateDescription})
• Pricing Engine Baseline: Action: ${stockAnalysis.recommendedPrice.action.toUpperCase()} | Range: $${stockAnalysis.recommendedPrice.min}–$${stockAnalysis.recommendedPrice.max} | Rationale: ${stockAnalysis.recommendedPrice.rationale}
• Ad Spend Baseline: Action: ${stockAnalysis.recommendedAdSpend.action.toUpperCase()} | Amount: $${stockAnalysis.recommendedAdSpend.amount.toLocaleString()}/day | Rationale: ${stockAnalysis.recommendedAdSpend.rationale}
• Capacity & Open Seats: ${hiringAnalysis.openSeats} open seats. Priority Next Hires: ${hiringAnalysis.shortSummary}

---
### YOUR ADVISORY MANDATE:
Output the briefing strictly following this compact, actionable bullet structure (start directly with ### Immediate Action Items, NO introductory sentence):

### Immediate Action Items

**Role Transfers:**
${transfersFormatted}

**Target Lineup:**
${lineupFormatted}

**Mandatory Swiss Rehab:**
${rehabFormatted}

### Stock & Pricing Verdict
• **Storage Status:** ${stockAnalysis.stateDescription}
• **Pricing:** ${stockAnalysis.recommendedPrice.formatted}
• **Ad Budget:** ${stockAnalysis.recommendedAdSpend.formatted}

### 10★ Progression Roadmap
• **Capacity Utilization (${hiringAnalysis.hired} ➔ ${hiringAnalysis.capacity} Seats):** Next priority hires: ${hiringAnalysis.shortSummary}
`;

	let advisorText = "";
	if (geminiApiKey) {
		const llmOutput = await callGemini(prompt, geminiApiKey);
		if (llmOutput) {
			advisorText = llmOutput;
			// Strip any accidental introductory paragraph before **Role Transfers:**
			advisorText = advisorText.replace(
				/### Immediate Action Items\s+[\s\S]*?(?=\*\*Role Transfers:\*\*)/,
				"### Immediate Action Items\n\n",
			);
			// Strip any bracketed rationale after the target role in Role Transfers
			advisorText = advisorText.replace(
				/(• \*\*.+?\*\* \([^\n)]+\): [^\n➔]+ ➔ \*\*[^\n*]+\*\*) \([^)\n]+\)/g,
				"$1",
			);
			// Strip 10★ Milestone bullet if generated
			advisorText = advisorText.replace(/\n• \*\*10★ Milestone:\*\*.*$/gm, "");
		}
	}

	// Comprehensive deterministic fallback if LLM is offline
	if (!advisorText) {
		advisorText = `### Immediate Action Items

**Role Transfers:**
${transfersFormatted}

**Target Lineup:**
${lineupFormatted}

**Mandatory Swiss Rehab:**
${rehabFormatted}

### Stock & Pricing Verdict
• **Storage Status:** ${stockAnalysis.stateDescription}
• **Pricing:** ${stockAnalysis.recommendedPrice.formatted}
• **Ad Budget:** ${stockAnalysis.recommendedAdSpend.formatted}

### 10★ Progression Roadmap
• **Capacity Utilization (${hiringAnalysis.hired} ➔ ${hiringAnalysis.capacity} Seats):** Next priority hires: ${hiringAnalysis.shortSummary}`;
	}

	logger.info("================ EXECUTIVE BRIEFING ================");
	console.log(advisorText);
	logger.info("====================================================");

	// Send Discord DMs as 2 separate messages to ensure rich detail never exceeds Discord caps
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

		const rawSections = advisorText
			.split(/(?=### )/)
			.map((s) => s.trim())
			.filter(Boolean);

		if (rawSections.length >= 2) {
			// Message 1: Immediate Action Items
			const actionSection = rawSections[0] ?? "";
			await sendDiscordDm(discordUserId, discordToken, {
				embeds: [
					{
						title: `Succession Oil (${snap.profile.rating}★) — Operations Briefing (Part 1/2)`,
						description: actionSection.slice(0, 4000),
						color: 0xf59e0b, // Amber Gold
						fields: [
							{
								name: "Efficiency",
								value: `${snap.profile.efficiency}%`,
								inline: true,
							},
							{
								name: "Environment",
								value: `${snap.profile.environment}%`,
								inline: true,
							},
							{
								name: "Addicted Staff",
								value: `${addictedEmployees.length} employees (-${totalAddictionPenalty} pts)`,
								inline: true,
							},
						],
					},
				],
			});

			// Message 2: Stock, Pricing & 10★ Roadmap
			const remainingSections = rawSections.slice(1).join("\n\n").trim();
			await sendDiscordDm(discordUserId, discordToken, {
				embeds: [
					{
						title: "Stock, Pricing & 10★ Roadmap (Part 2/2)",
						description: remainingSections.slice(0, 4000),
						color: 0x3b82f6, // Blue
						fields: [
							{
								name: "Financials",
								value: `Daily Rev: **$${snap.profile.income.daily.toLocaleString()}**\nWeekly Rev: **$${snap.profile.income.weekly.toLocaleString()}**\nFunds: **$${snap.profile.funds.toLocaleString()}**`,
								inline: true,
							},
							{
								name: "Stock & Pricing",
								value: `Price: **$${currentPrice}**/barrel\nStock: **${inStock.toLocaleString()}** (${fillPct}%)\nSold: **${dailySold.toLocaleString()}** barrels`,
								inline: true,
							},
						],
						footer: {
							text: "Sentinel • Succession Oil Operations",
						},
						timestamp: new Date().toISOString(),
					},
				],
			});
		} else {
			await sendDiscordDm(discordUserId, discordToken, {
				embeds: [
					{
						title: `Succession Oil (${snap.profile.rating}★) — Operations Briefing`,
						description: advisorText.slice(0, 4000),
						color: 0xf59e0b,
						fields: [
							{
								name: "Efficiency",
								value: `${snap.profile.efficiency}%`,
								inline: true,
							},
							{
								name: "Environment",
								value: `${snap.profile.environment}%`,
								inline: true,
							},
							{
								name: "Addicted Staff",
								value: `${addictedEmployees.length} employees (-${totalAddictionPenalty} pts)`,
								inline: true,
							},
						],
						footer: {
							text: "Sentinel • Succession Oil Operations",
						},
						timestamp: new Date().toISOString(),
					},
				],
			});
		}

		logger.info("Discord DMs successfully delivered!");
	} else {
		logger.warn("Discord credentials missing. Skipping DM.");
	}

	return advisorText;
}
