import { Logger } from "./logger";
import {
	buildWeekToDateLogEntries,
	deriveRosterBaseline,
	estimateDailyProduced,
	formatWeekToDateSummary,
	formatWeekToDateTable,
	type OilRigHistoryRecord,
	type RosterBaseline,
} from "./oil-rig";
import { analyzeOilRig, type OilRigAnalysis } from "./oil-rig-analysis";
import {
	attributeBriefOutcome,
	type BriefOutcome,
	loadPreviousBriefState,
	loadRecentRosterBaselineRows,
	type PreviousBriefState,
	persistBrief,
	recordBriefOutcome,
} from "./oil-rig-brief-store";
import {
	buildAnalystPrompt,
	renderCompanyDetails,
	renderDeterministicBriefing,
	renderProvenance,
	splitDiscordMessages,
	validateAnalystNotes,
} from "./oil-rig-render";
import type { CompanySnapshot } from "./oil-rig-snapshot";

export type { CompanySnapshot, EmployeeSnapshot } from "./oil-rig-snapshot";

const logger = new Logger("DirectorBriefing");

/**
 * Company id used when the snapshot does not carry one. Succession Oil.
 */
const DEFAULT_COMPANY_ID = 90288;

/**
 * The analysis model, pinned deliberately.
 *
 * A `-latest` alias silently changes the model underneath the advice, so the same
 * data can produce different prose from one week to the next with no code change
 * and no way to reproduce a past brief. Pin a version and set `GEMINI_MODEL` to
 * override it when a deliberate upgrade is wanted.
 */
const DEFAULT_ANALYST_MODEL = "gemini-2.5-flash";

export interface DirectorBriefingOptions {
	useLiveData?: boolean;
	customSnapshot?: CompanySnapshot;
	fetchLiveData?: () => Promise<CompanySnapshot>;
	fetchHistory?: () => Promise<OilRigHistoryRecord[]>;
	/** Rolling window to load, in days. */
	historyDays?: number;
	/** Hysteresis state from the previous brief; loaded automatically if omitted. */
	previousBriefState?: PreviousBriefState;
	/** Measured roster baseline; loaded automatically if omitted. */
	baseline?: RosterBaseline;
	companyId?: number;
	asOfSeconds?: number;
	/**
	 * Read and write nothing in the brief or benchmark tables.
	 *
	 * Named for what it actually does, because it is not merely "do not persist":
	 * it also skips READING the hysteresis state and the measured roster baseline,
	 * which changes the analysis rather than only whether it is recorded. A caller
	 * who wanted "analyse but do not store" and used a flag called
	 * `skipPersistence` would silently lose personal hysteresis and steer toward
	 * the built-in blueprint instead of the measured one. Set it only to isolate a
	 * test from whatever happens to be in the database.
	 */
	isolateFromDatabase?: boolean;
	/** Skip the Discord DM. Used by tests and by the API. */
	skipDelivery?: boolean;
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

/**
 * Sends markdown bodies to a user's DMs, creating the DM channel once.
 *
 * The previous implementation created a fresh DM channel per embed, which is two
 * extra API round trips per message and a rate-limit risk at four messages.
 */
export async function sendDiscordContent(
	userId: string,
	token: string,
	messages: string[],
): Promise<void> {
	if (messages.length === 0) return;

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
		throw new Error(`Failed to create DM channel: ${await channelRes.text()}`);
	}
	const channel = (await channelRes.json()) as { id: string };

	for (const content of messages) {
		const res = await fetch(
			`https://discord.com/api/v10/channels/${channel.id}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ content }),
			},
		);
		if (!res.ok) {
			// Fail loudly: a dropped half of the brief is worse than a visible error,
			// because the advice would arrive incomplete with no indication.
			throw new Error(
				`Failed to send DM message (${content.length} chars): ${await res.text()}`,
			);
		}
	}
}

/**
 * Requests analysis prose from the configured model.
 *
 * Temperature 0 plus a fixed seed: the same data must produce the same prose, or
 * "the brief says something different this time" becomes unanswerable.
 */
export async function callGemini(
	prompt: string,
	apiKey: string,
): Promise<string | null> {
	const model = process.env.GEMINI_MODEL || DEFAULT_ANALYST_MODEL;
	if (model.endsWith("-latest")) {
		logger.warn(
			`Analyst model "${model}" is a moving alias; the same input may produce different analysis over time. Pin a version.`,
		);
	}
	try {
		logger.info(`Requesting analysis from ${model}...`);
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
				generationConfig: {
					temperature: 0,
					seed: 0,
					maxOutputTokens: 800,
				},
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
			logger.warn("Model returned no candidate text.");
			return null;
		}
		const errText = await res.text();
		logger.warn(`Model ${model} returned ${res.status}: ${errText}`);
		return null;
	} catch (err) {
		logger.warn(`Model ${model} call error: ${err}`);
		return null;
	}
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

		const employees: CompanySnapshot["employees"] = rawEmployees.map((emp) => {
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
 * Loads up to `days` rolling snapshots from PostgreSQL, oldest first.
 *
 * Production is derived from the change in stored barrels between two records, so
 * only records with a real predecessor are marked as measured. The unmeasurable
 * first record still carries a figure for display, flagged `producedMeasured:
 * false`, so nothing downstream can mistake it for a measurement.
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
				let producedMeasured = false;
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
					producedMeasured = dailyProduced !== undefined;
				}
				// Display-only fill for the first record in the window. Explicitly
				// flagged so the estimators cannot treat it as a measurement.
				if (dailyProduced === undefined && r.barrelsSold > 0) {
					dailyProduced = r.barrelsSold;
					producedMeasured = false;
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
					producedMeasured,
					// The only direct signal of advertising's effect on traffic.
					dailyCustomers: r.dailyCustomers ?? undefined,
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
				} satisfies OilRigHistoryRecord;
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

/** Fetches the live company snapshot from the Torn API. */
async function fetchLiveSnapshot(): Promise<CompanySnapshot | null> {
	try {
		const { tornApi } = await import("../../torn-api");
		const res = (await tornApi.getPersonal("/company", {
			queryParams: { selections: ["profile", "employees", "stock"] },
		})) as unknown as CompanySnapshot;
		return res?.profile ? res : null;
	} catch (apiErr) {
		logger.warn(
			`Failed to fetch live company data: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`,
		);
		return null;
	}
}

/** Minutes since the most recent recorded tick, for the provenance block. */
function tickAgeMinutes(
	history: OilRigHistoryRecord[],
	asOfSeconds: number,
): number | undefined {
	const last = history[history.length - 1];
	if (!last) return undefined;
	return Math.max(0, Math.round((asOfSeconds - last.timestamp) / 60));
}

export interface BriefingResult {
	/** Everything the caller might want to show or store. */
	analysis: OilRigAnalysis;
	/** The full text returned to callers: advice, details, week-to-date logs. */
	text: string;
	signature: string;
	changed: boolean;
	advisorText: string;
	companyDetails: string;
	outcome?: BriefOutcome;
	persistedId?: string;
	rejectedNotes: Array<{ bullet: string; reason: string }>;
	/** The exact Discord message bodies, so nothing is hidden behind delivery. */
	discordMessages: string[];
}

/**
 * Generates, delivers and records a director briefing.
 *
 * The body is deliberately a straight line: load, analyse, render, deliver,
 * record. Every decision comes from `analyzeOilRig`, so the brief, the dashboard
 * and the in-page badges cannot disagree, and the two pieces of state the advice
 * needs to be stable - the inventory state and the capacity regime - are read back
 * from the previous brief before the analysis runs rather than being recomputed
 * from a single day's numbers.
 */
export async function generateDirectorBriefing(
	options?: DirectorBriefingOptions,
): Promise<BriefingResult> {
	const asOfSeconds = options?.asOfSeconds ?? Math.floor(Date.now() / 1000);

	// ---- Load ---------------------------------------------------------------
	let snap: CompanySnapshot | null = options?.customSnapshot ?? null;
	let dataBasis: "live" | "recorded" = "recorded";

	if (!snap && options?.useLiveData) {
		snap = options?.fetchLiveData
			? await options.fetchLiveData()
			: await fetchLiveSnapshot();
		if (snap) dataBasis = "live";
	}
	if (!snap) snap = await loadLatestSnapshotFromDb();
	if (!snap) {
		throw new Error(
			"No oil rig snapshot available in database or via live API.",
		);
	}

	let history: OilRigHistoryRecord[] = [];
	if (options?.fetchHistory) {
		try {
			history = await options.fetchHistory();
		} catch {
			history = [];
		}
	} else {
		history = await loadRollingHistory(options?.historyDays ?? 14);
	}

	let previous: PreviousBriefState | undefined = options?.previousBriefState;
	let baseline: RosterBaseline | undefined = options?.baseline;
	const companyId = options?.companyId ?? snap.profile.id ?? DEFAULT_COMPANY_ID;

	if (!options?.isolateFromDatabase) {
		if (!previous) {
			previous = await loadPreviousBriefState(companyId);
		}
		if (!baseline) {
			// Several captures, not just the newest: a single capture reads only a
			// handful of rigs, and the blueprint must not wobble with the sample.
			baseline = deriveRosterBaseline(await loadRecentRosterBaselineRows(5), {
				asOfSeconds,
			});
		}
	}

	// ---- Analyse ------------------------------------------------------------
	const analysis = analyzeOilRig({
		snapshot: snap,
		history,
		dataBasis,
		tickAgeMinutes: tickAgeMinutes(history, asOfSeconds),
		asOfSeconds,
		previousState: previous?.inventoryState,
		previousCritical: previous?.warehouseCritical,
		previousRegime: previous?.regime,
		baseline,
	});

	// ---- Record what happened after the previous brief ----------------------
	let outcome: BriefOutcome | undefined;
	if (previous) {
		outcome = attributeBriefOutcome(previous, analysis);
		if (!options?.isolateFromDatabase) {
			await recordBriefOutcome(previous, outcome);
		}
	}

	// ---- Render -------------------------------------------------------------
	const deterministic = renderDeterministicBriefing(analysis, {
		previousSignature: previous?.adviceSignature,
		previousAsOfIso: previous?.asOf
			.toISOString()
			.slice(0, 16)
			.replace("T", " "),
	});

	const wtd = buildWeekToDateLogEntries({ history });
	const companyDetails = renderCompanyDetails(analysis, snap.profile);
	const provenanceText = renderProvenance(analysis);
	// With no recorded days in the current week the summary is a wall of zeroes
	// that reads like a failure; the table already says nothing is recorded.
	const wtdSummaryText =
		wtd.entries.length > 0 ? formatWeekToDateSummary(wtd) : "";
	const wtdTable = formatWeekToDateTable(wtd);

	// ---- Analyst notes ------------------------------------------------------
	// When nothing has changed the analysis is not regenerated at all. Re-asking a
	// model the same question is how identical advice arrives in different words,
	// which reads to the director as different advice.
	let notesText = "";
	const rejectedNotes: Array<{ bullet: string; reason: string }> = [];
	const geminiApiKey = process.env.GEMINI_API_KEY;

	if (!deterministic.changed) {
		notesText = `_Analysis not regenerated: every directive is unchanged from the brief issued ${previous?.asOf.toISOString().slice(0, 10)}, so there is nothing new to interpret._`;
	} else if (geminiApiKey) {
		const { prompt, allowedNumbers } = buildAnalystPrompt({
			analysis,
			history,
			actionText: deterministic.actionText,
		});
		const raw = await callGemini(prompt, geminiApiKey);
		if (raw) {
			const cleaned = raw
				.replace(/^#{1,6}.*$/gm, "")
				.replace(/^\*\*(Analyst Notes|Analysis):?\*\*$/gim, "")
				.trim()
				// The prompt asks for 700 characters; the cap is headroom, not a
				// target, because a long analysis is the wordiness being fixed.
				.slice(0, 900);
			const validated = validateAnalystNotes({
				notes: cleaned,
				allowedNumbers,
				directives: analysis.directives,
			});
			rejectedNotes.push(...validated.rejected);
			if (validated.rejected.length > 0) {
				logger.warn(
					`Dropped ${validated.rejected.length} analyst bullet(s) that contradicted the engines or cited unsupported figures: ${validated.rejected
						.map((r) => `"${r.bullet.slice(0, 80)}" (${r.reason})`)
						.join("; ")}`,
				);
			}
			notesText = validated.accepted.join("\n");
		} else {
			logger.warn(
				"No analyst notes returned; delivering the deterministic briefing only.",
			);
		}
	} else {
		notesText =
			"_No analyst model configured, so this brief carries the computed advice only._";
	}

	const advisorText = notesText
		? `${deterministic.advice}\n\n### Analyst Notes\n${notesText}`
		: deterministic.advice;

	const detailsBlock = `${companyDetails}\n\n### Provenance\n${provenanceText}${
		outcome ? `\n\n### Previous Brief Outcome\n• ${outcome.summary}` : ""
	}`;

	// ---- Console ------------------------------------------------------------
	logger.info("================ EXECUTIVE BRIEFING ================");
	console.log(advisorText);
	console.log("\n================ COMPANY DETAILS ================");
	console.log(detailsBlock);
	console.log(
		"\n================ WEEK-TO-DATE LOGS (MON–SUN) ================",
	);
	console.log(wtdTable);
	console.log(wtdSummaryText);
	logger.info("====================================================");

	// ---- Deliver ------------------------------------------------------------
	// Plain markdown messages rather than one embed: an embed description is capped
	// at 4096 characters, and the previous delivery sliced the advice at 4000, which
	// silently cut the brief off mid-sentence and dropped the rest of the analysis.
	// Messages are chunked on line boundaries instead, so nothing is ever lost.
	const discordToken = process.env.DISCORD_TOKEN;
	const discordUserId = process.env.DISCORD_USER_ID;
	const rating = snap.profile.rating;
	const header = `## Succession Oil (${rating}★) — Operations Brief\n_${new Date(analysis.decision.asOfSeconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC · ${analysis.provenance.dataBasis} settings + ${analysis.provenance.tickIsoDate ? `recorded tick ${analysis.provenance.tickIsoDate}` : "no recorded tick"}${deterministic.changed ? "" : " · no change"}_`;

	const streamed = [
		header,
		deterministic.advice,
		notesText ? `### Analyst Notes\n${notesText}` : "",
		companyDetails,
		provenanceText,
		outcome ? `_Since the last brief: ${outcome.summary}_` : "",
		`### Week To Date\n${wtdTable}${wtdSummaryText ? `\n${wtdSummaryText}` : ""}`,
	]
		.filter((section) => section.length > 0)
		.join("\n\n");

	const discordMessages = splitDiscordMessages(streamed);

	if (discordToken && discordUserId && !options?.skipDelivery) {
		logger.info(
			`Sending Discord DMs to user ${discordUserId} (${discordMessages.length} message(s))...`,
		);
		await sendDiscordContent(discordUserId, discordToken, discordMessages);
		logger.info(
			`Discord DMs successfully delivered (${discordMessages.length} message(s))!`,
		);
	} else if (!options?.skipDelivery) {
		logger.warn("Discord credentials missing. Skipping DM.");
	}

	// ---- Record -------------------------------------------------------------
	let persistedId: string | undefined;
	if (!options?.isolateFromDatabase) {
		persistedId = await persistBrief({
			companyId,
			analysis,
			signature: deterministic.signature,
			previous,
		});
	}

	const text = [advisorText, detailsBlock, wtdTable, wtdSummaryText]
		.filter((part) => part.length > 0)
		.join("\n\n");

	return {
		analysis,
		text,
		signature: deterministic.signature,
		changed: deterministic.changed,
		advisorText,
		companyDetails: detailsBlock,
		outcome,
		persistedId,
		rejectedNotes,
		discordMessages,
	};
}

/**
 * Backwards-compatible entry point: generates the briefing and returns its text.
 *
 * Kept because the Discord command, the manual script and the daily worker all
 * call it by this name.
 */
export async function generateAndSendDirectorBriefing(
	options?: DirectorBriefingOptions,
): Promise<string> {
	const result = await generateDirectorBriefing(options);
	return result.text;
}
