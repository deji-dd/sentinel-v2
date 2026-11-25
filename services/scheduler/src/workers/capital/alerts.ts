import {
	and,
	capitalNavSnapshots,
	db,
	desc,
	eq,
	getCapitalBook,
	getCapitalState,
	getWorkerState,
	gte,
	lt,
	sql,
	upsertWorkerState,
	WORKER_STATE_IDS,
} from "@sentinel/database";
import type {
	CapitalAlertChartContext,
	CapitalAlertField,
	CapitalAlertPayload,
	CapitalBook,
} from "@sentinel/schemas";
import {
	computeNav,
	daysBetween,
	floorToUtcBucket,
	formatMoney,
	formatUnits,
	Logger,
	moneyFromPriceShares,
	moneyToNumber,
	navReturnFromParPct,
	parseMoney,
} from "@sentinel/utils";

import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";
import { runCapitalPersonalAlertsCycle } from "./personal-alerts";

const WORKER_NAME = "capital:alerts";
const DAILY_DIGEST_WORKER_NAME = "capital:daily-digest";
const logger = new Logger("Scheduler", "CapitalAlerts");

const DESK_URL = "https://stocks.blasted-labs.tech/desk";
const PAPER_DESK_URL = "https://stocks.blasted-labs.tech/desk/paper";

/**
 * Thresholds are code-level policy (like the rest of the capital risk rules),
 * so changing one is a deliberate edit rather than a dashboard tweak.
 */
const THRESHOLDS = {
	/** Ignore a new extreme unless it beats the old one by at least this much. */
	newExtremeMinPct: 0.05,
	navMove1hPct: 1,
	navMove1dPct: 3,
	/** Consecutive hourly snapshots moving the same way. */
	streakPeriods: 3,
	/**
	 * Minimum net move across a trend streak. Without this, a book parked at
	 * par ($1.00) with a few open positions emits "trends" driven by sub-cent
	 * rounding noise in the unit price.
	 */
	trendMinPct: 1,
	returnMilestonesUp: [5, 10, 25, 50],
	returnMilestonesDown: [-5, -10, -20],
	drawdownMilestones: [5, 10, 15],
	/** Deployed share of NAV below this is idle cash. */
	idleCashPct: 50,
	/** One position above this share of NAV is a concentration risk. */
	concentrationPct: 15,
	/** Book-level APR is only shown once it has this much track record. */
	aprMinDays: 30,
} as const;

const COOLDOWNS = {
	newExtreme: 30 * 60_000,
	navMove: 60 * 60_000,
	streak: 3 * 60 * 60_000,
	milestone: 60 * 60_000,
	drawdown: 60 * 60_000,
	exposure: 6 * 60 * 60_000,
} as const;

const MINUTE_HISTORY_DAYS = 7;

const DIGEST_COOLDOWN_MS = 24 * 60 * 60_000;
const COOLDOWN_DETAILS_KEY = "firedAt";
let lastMinutePruneAt = 0;

/**
 * Emission cooldowns live in `worker_state`, not in memory. A restart used to
 * clear the map, so the next cycle replayed the daily digest and whatever
 * trend streak happened to be in the hourly history — the "alert on every
 * boot" behaviour. Persisting the timestamps keeps a throttled alert throttled
 * across deploys without needing a dedicated table or migration.
 */
let firedAt: Map<string, number> | null = null;

async function loadFiredAt(): Promise<Map<string, number>> {
	if (firedAt) return firedAt;
	const map = new Map<string, number>();
	try {
		const row = await getWorkerState(WORKER_STATE_IDS.capitalAlerts);
		const stored = row?.details?.[COOLDOWN_DETAILS_KEY];
		if (stored && typeof stored === "object" && !Array.isArray(stored)) {
			for (const [key, value] of Object.entries(stored)) {
				if (typeof value === "number" && Number.isFinite(value)) {
					map.set(key, value);
				}
			}
		}
	} catch (error) {
		logger.warn(
			`Could not load capital alert cooldowns: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	firedAt = map;
	return map;
}

async function shouldFire(key: string, cooldownMs: number): Promise<boolean> {
	const timestamps = await loadFiredAt();
	const now = Date.now();
	if (now - (timestamps.get(key) ?? 0) < cooldownMs) return false;
	timestamps.set(key, now);
	try {
		await upsertWorkerState({
			workerId: WORKER_STATE_IDS.capitalAlerts,
			details: { [COOLDOWN_DETAILS_KEY]: Object.fromEntries(timestamps) },
			lastRunAt: new Date(now),
		});
	} catch (error) {
		logger.warn(
			`Could not persist capital alert cooldown '${key}': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return true;
}

function broadcast(payload: CapitalAlertPayload): void {
	const server = getActiveIpcServer();
	if (!server) return;
	server.broadcast({ action: "capital_alert", data: payload });
}

function insight(
	book: CapitalBook,
	title: string,
	body: string,
	fields: CapitalAlertField[],
	chart?: CapitalAlertChartContext,
): void {
	broadcast({
		kind: "insight",
		book,
		// Paper insights carry the same TEST marker as paper risk alerts so two
		// books' messages are never confused in the DM stream.
		title: book === "paper" ? `TEST ${title}` : title,
		body,
		fields,
		link: book === "paper" ? PAPER_DESK_URL : DESK_URL,
		chart,
	});
}

interface HistoryRow {
	capturedAt: Date;
	navPerUnit: string;
}

async function loadHistory(
	book: CapitalBook,
	granularity: "minute" | "hourly" | "daily",
	since: Date,
	before: Date,
): Promise<HistoryRow[]> {
	return db
		.select({
			capturedAt: capitalNavSnapshots.capturedAt,
			navPerUnit: capitalNavSnapshots.navPerUnit,
		})
		.from(capitalNavSnapshots)
		.where(
			and(
				eq(capitalNavSnapshots.book, book),
				eq(capitalNavSnapshots.granularity, granularity),
				gte(capitalNavSnapshots.capturedAt, since),
				lt(capitalNavSnapshots.capturedAt, before),
			),
		)
		.orderBy(capitalNavSnapshots.capturedAt);
}

/** Last row at or before `target`, assuming ascending order. */
function navAt(rows: HistoryRow[], target: Date): string | null {
	let found: string | null = null;
	for (const row of rows) {
		if (row.capturedAt > target) break;
		found = row.navPerUnit;
	}
	return found;
}

/**
 * Builds the unit-price series an insight alert hands to the bot for drawing.
 * The current mark is appended so the event is visible at the right-hand edge,
 * and the event time is passed through for a marker on the line.
 */
async function buildChart(
	book: CapitalBook,
	now: Date,
	currentNav: bigint,
	options: {
		granularity: "minute" | "hourly" | "daily";
		days: number;
		title: string;
		subtitle?: string;
		reference?: { value: bigint; label: string } | null;
	},
): Promise<CapitalAlertChartContext> {
	let rows: HistoryRow[] = [];
	try {
		rows = await loadHistory(
			book,
			options.granularity,
			new Date(now.getTime() - options.days * 86_400_000),
			now,
		);
	} catch (error) {
		logger.warn(
			`Could not load chart history for ${book}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const points = rows.map((row) => ({
		capturedAtIso: row.capturedAt.toISOString(),
		navPerUnit: moneyToNumber(parseMoney(row.navPerUnit)),
	}));
	const last = points[points.length - 1];
	if (!last || now.getTime() - Date.parse(last.capturedAtIso) > 60_000) {
		points.push({
			capturedAtIso: now.toISOString(),
			navPerUnit: moneyToNumber(currentNav),
		});
	}
	return {
		title: options.title,
		subtitle: options.subtitle,
		points,
		eventAtIso: now.toISOString(),
		reference: options.reference
			? {
					value: moneyToNumber(options.reference.value),
					label: options.reference.label,
				}
			: null,
	};
}

function pctChange(current: bigint, previous: bigint): number | null {
	if (previous <= 0n) return null;
	return (
		((moneyToNumber(current) - moneyToNumber(previous)) /
			moneyToNumber(previous)) *
		100
	);
}

function signedPct(value: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export interface TrendPoint {
	navPerUnit: string;
}

export interface DetectedTrend {
	direction: "up" | "down";
	changePct: number;
}

/**
 * Finds a run of consecutive hourly moves in the same direction and checks
 * that it is a real move, not rounding noise around par. The current mark is
 * part of the comparison so a streak that has already reversed (or is stale
 * after a restart) does not emit.
 */
export function detectPriceTrend(
	history: TrendPoint[],
	currentNav: bigint,
	periods: number,
	minMovePct: number,
): DetectedTrend | null {
	const tail = history.slice(-(periods + 1));
	if (tail.length < periods + 1) return null;

	const signs: number[] = [];
	for (let i = 1; i < tail.length; i++) {
		signs.push(
			parseMoney(tail[i]!.navPerUnit) > parseMoney(tail[i - 1]!.navPerUnit)
				? 1
				: -1,
		);
	}
	const direction = signs.every((sign) => sign === 1)
		? "up"
		: signs.every((sign) => sign === -1)
			? "down"
			: null;
	if (!direction) return null;

	const changePct = pctChange(currentNav, parseMoney(tail[0]!.navPerUnit));
	if (changePct === null) return null;
	if (direction === "up" && changePct <= 0) return null;
	if (direction === "down" && changePct >= 0) return null;
	if (Math.abs(changePct) < minMovePct) return null;

	return { direction, changePct };
}

/** Human-facing wording for a trend insight: "risen/fallen by x% in y hours". */
export function formatTrendAlert(
	trend: DetectedTrend,
	hours: number,
): { title: string; body: string; subtitle: string; changeLabel: string } {
	const verb = trend.direction === "up" ? "risen" : "fallen";
	const magnitude = `${Math.abs(trend.changePct).toFixed(2)}%`;
	return {
		title: `Unit price ${verb} by ${magnitude} in ${hours}h`,
		body: `Unit price has ${verb} by ${magnitude} in ${hours} hours.`,
		subtitle: `${verb} by ${magnitude} in ${hours} hours`,
		changeLabel: signedPct(trend.changePct),
	};
}

type CapitalNavResult = {
	nav: ReturnType<typeof computeNav>;
	positions: Awaited<ReturnType<typeof getCapitalState>>["positions"];
};

/** Current unit price and positions, shared by the insight cycle and digest. */
async function readCurrentNav(book: CapitalBook): Promise<CapitalNavResult> {
	const state = await getCapitalState(book);
	return {
		nav: computeNav({
			cash: state.cash,
			units: state.units,
			positions: state.positions.map((position) => ({
				shares: position.shares,
				price: position.price,
			})),
		}),
		positions: state.positions,
	};
}

/** Persist the current mark at minute granularity; return it for evaluation. */
async function recordMinuteSnapshot(
	book: CapitalBook,
	now: Date,
	bucket: Date,
): Promise<CapitalNavResult> {
	const { nav, positions } = await readCurrentNav(book);
	const [previous] = await db
		.select({ navPerUnit: capitalNavSnapshots.navPerUnit })
		.from(capitalNavSnapshots)
		.where(
			and(
				eq(capitalNavSnapshots.book, book),
				eq(capitalNavSnapshots.granularity, "minute"),
				lt(capitalNavSnapshots.capturedAt, bucket),
			),
		)
		.orderBy(desc(capitalNavSnapshots.capturedAt))
		.limit(1);
	const [carry] = await db
		.select()
		.from(capitalNavSnapshots)
		.where(
			and(
				eq(capitalNavSnapshots.book, book),
				eq(capitalNavSnapshots.granularity, "hourly"),
			),
		)
		.orderBy(desc(capitalNavSnapshots.capturedAt))
		.limit(1);
	const returnPct = previous
		? (pctChange(nav.navPerUnit, parseMoney(previous.navPerUnit)) ?? 0)
		: 0;

	const values = {
		book,
		capturedAt: bucket,
		granularity: "minute",
		cash: formatMoney(nav.cash),
		positionsValue: formatMoney(nav.positionsValue),
		totalValue: formatMoney(nav.totalValue),
		unitsOutstanding: formatUnits(nav.units),
		navPerUnit: formatMoney(nav.navPerUnit),
		investedCapital: carry?.investedCapital ?? "0",
		cumulativePayouts: carry?.cumulativePayouts ?? "0",
		cumulativeFees: carry?.cumulativeFees ?? "0",
		investorCount: carry?.investorCount ?? 0,
		returnPct,
	};
	await db
		.insert(capitalNavSnapshots)
		.values(values)
		.onConflictDoUpdate({
			target: [
				capitalNavSnapshots.book,
				capitalNavSnapshots.granularity,
				capitalNavSnapshots.capturedAt,
			],
			set: {
				cash: values.cash,
				positionsValue: values.positionsValue,
				totalValue: values.totalValue,
				unitsOutstanding: values.unitsOutstanding,
				navPerUnit: values.navPerUnit,
				returnPct: values.returnPct,
			},
		});
	return { nav, positions };
}

async function evaluateBook(book: CapitalBook, now: Date): Promise<void> {
	const bucket = floorToUtcBucket(now, 1);
	const { nav, positions } = await recordMinuteSnapshot(book, now, bucket);

	// History is loaded strictly before the current bucket so the current mark
	// is never compared with itself when detecting a new high or low.
	const [minutes, hourlies, extremes] = await Promise.all([
		loadHistory(
			book,
			"minute",
			new Date(now.getTime() - 2 * 60 * 60_000),
			bucket,
		),
		loadHistory(
			book,
			"hourly",
			new Date(now.getTime() - 26 * 60 * 60_000),
			bucket,
		),
		db
			.select({
				high: sql<string | null>`MAX(${capitalNavSnapshots.navPerUnit})`,
				low: sql<string | null>`MIN(${capitalNavSnapshots.navPerUnit})`,
			})
			.from(capitalNavSnapshots)
			.where(
				and(
					eq(capitalNavSnapshots.book, book),
					lt(capitalNavSnapshots.capturedAt, bucket),
				),
			),
	]);
	const previousNav =
		minutes.length > 0
			? parseMoney(minutes[minutes.length - 1]!.navPerUnit)
			: null;
	const label = formatMoney(nav.navPerUnit);

	// New unit-price high / low -------------------------------------------------
	const high = extremes[0]?.high ? parseMoney(extremes[0].high) : null;
	const low = extremes[0]?.low ? parseMoney(extremes[0].low) : null;
	const newHigh =
		high !== null &&
		pctChange(nav.navPerUnit, high)! >= THRESHOLDS.newExtremeMinPct;
	const newLow =
		low !== null &&
		pctChange(nav.navPerUnit, low)! <= -THRESHOLDS.newExtremeMinPct;
	if (
		newHigh &&
		(await shouldFire(`${book}:extreme:high`, COOLDOWNS.newExtreme))
	) {
		insight(
			book,
			"New unit price high",
			`Unit price set a new all-time high at $${label}.`,
			[
				{ name: "Unit price", value: `$${label}`, inline: true },
				{
					name: "Previous high",
					value: `$${formatMoney(high!)}`,
					inline: true,
				},
			],
			await buildChart(book, now, nav.navPerUnit, {
				granularity: "hourly",
				days: 7,
				title: `${book === "paper" ? "TEST — " : ""}Unit price — new high`,
				subtitle: `New all-time high $${label}`,
				reference: { value: high!, label: "Previous high" },
			}),
		);
	}
	if (
		newLow &&
		(await shouldFire(`${book}:extreme:low`, COOLDOWNS.newExtreme))
	) {
		insight(
			book,
			"New unit price low",
			`Unit price set a new all-time low at $${label}.`,
			[
				{ name: "Unit price", value: `$${label}`, inline: true },
				{ name: "Previous low", value: `$${formatMoney(low!)}`, inline: true },
			],
			await buildChart(book, now, nav.navPerUnit, {
				granularity: "hourly",
				days: 7,
				title: `${book === "paper" ? "TEST — " : ""}Unit price — new low`,
				subtitle: `New all-time low $${label}`,
				reference: { value: low!, label: "Previous low" },
			}),
		);
	}

	// 1h / 1d moves -------------------------------------------------------------
	const oneHourAgo = new Date(now.getTime() - 60 * 60_000);
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
	const moves: Array<{
		window: string;
		nav: string | null;
		threshold: number;
	}> = [
		{
			window: "1h",
			nav: navAt(minutes, oneHourAgo) ?? navAt(hourlies, oneHourAgo),
			threshold: THRESHOLDS.navMove1hPct,
		},
		{
			window: "1d",
			nav: navAt(hourlies, oneDayAgo),
			threshold: THRESHOLDS.navMove1dPct,
		},
	];
	for (const move of moves) {
		if (!move.nav) continue;
		const change = pctChange(nav.navPerUnit, parseMoney(move.nav));
		if (change === null || Math.abs(change) < move.threshold) continue;
		const direction = change > 0 ? "up" : "down";
		if (
			!(await shouldFire(
				`${book}:move:${move.window}:${direction}`,
				COOLDOWNS.navMove,
			))
		)
			continue;
		insight(
			book,
			`Unit price ${direction} over ${move.window}`,
			`Unit price is ${signedPct(change)} over the past ${move.window}.`,
			[
				{ name: "Now", value: `$${label}`, inline: true },
				{
					name: `${move.window} ago`,
					value: `$${formatMoney(parseMoney(move.nav))}`,
					inline: true,
				},
				{ name: "Change", value: signedPct(change), inline: true },
			],
			await buildChart(book, now, nav.navPerUnit, {
				granularity: move.window === "1h" ? "minute" : "hourly",
				days: move.window === "1h" ? 0.25 : 2,
				title: `${book === "paper" ? "TEST — " : ""}Unit price — ${move.window} ${direction}`,
				subtitle: `${signedPct(change)} over ${move.window}`,
				reference: {
					value: parseMoney(move.nav),
					label: `${move.window} ago`,
				},
			}),
		);
	}

	// Hourly trend / streak -----------------------------------------------------
	const trend = detectPriceTrend(
		hourlies,
		nav.navPerUnit,
		THRESHOLDS.streakPeriods,
		THRESHOLDS.trendMinPct,
	);
	if (
		trend &&
		(await shouldFire(`${book}:streak:${trend.direction}`, COOLDOWNS.streak))
	) {
		const wording = formatTrendAlert(trend, THRESHOLDS.streakPeriods);
		insight(
			book,
			wording.title,
			wording.body,
			[
				{ name: "Now", value: `$${label}`, inline: true },
				{ name: "Change", value: wording.changeLabel, inline: true },
			],
			await buildChart(book, now, nav.navPerUnit, {
				granularity: "hourly",
				days: 3,
				title: `${book === "paper" ? "TEST — " : ""}Unit price — ${trend.direction} trend`,
				subtitle: wording.subtitle,
			}),
		);
	}

	// Return milestones ---------------------------------------------------------
	const currentReturn = navReturnFromParPct(nav.navPerUnit);
	const previousReturn = previousNav ? navReturnFromParPct(previousNav) : null;
	if (currentReturn !== null && previousReturn !== null) {
		const milestones = [
			...THRESHOLDS.returnMilestonesUp.map((level) => ({
				level,
				direction: "up" as const,
			})),
			...THRESHOLDS.returnMilestonesDown.map((level) => ({
				level,
				direction: "down" as const,
			})),
		];
		for (const milestone of milestones) {
			const crossed =
				milestone.direction === "up"
					? previousReturn < milestone.level && currentReturn >= milestone.level
					: previousReturn > milestone.level &&
						currentReturn <= milestone.level;
			if (!crossed) continue;
			if (
				!(await shouldFire(
					`${book}:milestone:${milestone.level}`,
					COOLDOWNS.milestone,
				))
			)
				continue;
			insight(
				book,
				`Return ${milestone.direction === "up" ? "reached" : "fell to"} ${milestone.level}%`,
				`Since-inception return ${milestone.direction === "up" ? "crossed above" : "crossed below"} ${milestone.level}%.`,
				[
					{
						name: "Since inception",
						value: signedPct(currentReturn),
						inline: true,
					},
					{ name: "Unit price", value: `$${label}`, inline: true },
				],
				await buildChart(book, now, nav.navPerUnit, {
					granularity: "daily",
					days: 90,
					title: `${book === "paper" ? "TEST — " : ""}Unit price — ${milestone.level}% return`,
					subtitle: `Since inception ${signedPct(currentReturn)}`,
					reference: { value: parseMoney("1"), label: "Par $1.00" },
				}),
			);
		}
	}

	// Drawdown from peak --------------------------------------------------------
	if (high !== null) {
		const currentDrawdown = pctChange(nav.navPerUnit, high);
		const previousDrawdown = previousNav ? pctChange(previousNav, high) : null;
		if (currentDrawdown !== null && previousDrawdown !== null) {
			for (const level of THRESHOLDS.drawdownMilestones) {
				const crossed = previousDrawdown > -level && currentDrawdown <= -level;
				if (!crossed) continue;
				if (
					!(await shouldFire(`${book}:drawdown:${level}`, COOLDOWNS.drawdown))
				)
					continue;
				insight(
					book,
					`Unit price drawdown ${level}%`,
					`Unit price is ${level}% below its all-time high of $${formatMoney(high)}.`,
					[
						{
							name: "From peak",
							value: signedPct(currentDrawdown),
							inline: true,
						},
						{ name: "Unit price", value: `$${label}`, inline: true },
					],
					await buildChart(book, now, nav.navPerUnit, {
						granularity: "hourly",
						days: 7,
						title: `${book === "paper" ? "TEST — " : ""}Unit price — ${level}% drawdown`,
						subtitle: `Below all-time high $${formatMoney(high)}`,
						reference: { value: high, label: "Peak" },
					}),
				);
			}
		}
	}

	// Idle cash and concentration ----------------------------------------------
	const totalValue = moneyToNumber(nav.totalValue);
	if (totalValue > 0) {
		const cash = moneyToNumber(nav.cash);
		const deployedPct = ((totalValue - cash) / totalValue) * 100;
		if (
			deployedPct < THRESHOLDS.idleCashPct &&
			(await shouldFire(`${book}:exposure:idle`, COOLDOWNS.exposure))
		) {
			insight(
				book,
				"Idle cash",
				`Only ${deployedPct.toFixed(1)}% of the book is deployed; ${(100 - deployedPct).toFixed(1)}% sits in cash.`,
				[
					{
						name: "Deployed",
						value: `${deployedPct.toFixed(1)}%`,
						inline: true,
					},
					{ name: "Cash", value: `$${formatMoney(nav.cash)}`, inline: true },
				],
			);
		}
		const valued = positions
			.map((position) => ({
				stockId: position.stockId,
				value: moneyToNumber(
					moneyFromPriceShares(position.price, position.shares),
				),
			}))
			.sort((a, b) => b.value - a.value);
		if (valued[0]) {
			const weightPct = (valued[0].value / totalValue) * 100;
			if (
				weightPct > THRESHOLDS.concentrationPct &&
				(await shouldFire(`${book}:exposure:concentration`, COOLDOWNS.exposure))
			) {
				insight(
					book,
					"Position concentration",
					`The largest position is ${weightPct.toFixed(1)}% of the book (above ${THRESHOLDS.concentrationPct}%).`,
					[
						{
							name: "Largest weight",
							value: `${weightPct.toFixed(1)}%`,
							inline: true,
						},
						{
							name: "Positions",
							value: String(positions.filter((p) => p.shares > 0).length),
							inline: true,
						},
					],
				);
			}
		}
	}
}

/**
 * One book's daily digest. Runs from its own 07:00 UTC cron worker, not from
 * the per-minute insight cycle, and uses a persisted 24h cooldown so a boot
 * or manual trigger cannot send a second digest for the same day.
 */
async function sendDailyDigest(book: CapitalBook, now: Date): Promise<void> {
	if (!(await shouldFire(`${book}:digest`, DIGEST_COOLDOWN_MS))) return;

	const { nav, positions } = await readCurrentNav(book);
	const bookRow = await getCapitalBook(book);
	const days = bookRow?.startedAt ? daysBetween(bookRow.startedAt, now) : null;
	const label = formatMoney(nav.navPerUnit);
	const inceptionReturn = navReturnFromParPct(nav.navPerUnit);
	const apr =
		days !== null && days >= THRESHOLDS.aprMinDays && inceptionReturn !== null
			? (inceptionReturn * 365) / days
			: null;

	const hourlies = await loadHistory(
		book,
		"hourly",
		new Date(now.getTime() - 26 * 60 * 60_000),
		now,
	);
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
	const dayChangeNav = navAt(hourlies, oneDayAgo);
	const dayChange = dayChangeNav
		? pctChange(nav.navPerUnit, parseMoney(dayChangeNav))
		: null;
	const totalValue = moneyToNumber(nav.totalValue);
	const fields: CapitalAlertField[] = [
		{ name: "Unit price", value: `$${label}`, inline: true },
		{
			name: "24h",
			value: dayChange !== null ? signedPct(dayChange) : "—",
			inline: true,
		},
		{
			name: "Since inception",
			value: inceptionReturn !== null ? signedPct(inceptionReturn) : "—",
			inline: true,
		},
		...(apr !== null
			? [{ name: "APR (indicative)", value: signedPct(apr), inline: true }]
			: []),
		{
			name: "Open positions",
			value: String(positions.filter((position) => position.shares > 0).length),
			inline: true,
		},
		{
			name: "Deployed",
			value:
				totalValue > 0
					? `${(((totalValue - moneyToNumber(nav.cash)) / totalValue) * 100).toFixed(1)}%`
					: "—",
			inline: true,
		},
	];
	insight(
		book,
		"Daily book digest",
		book === "paper"
			? "Simulation snapshot — no real funds."
			: "Daily snapshot of the live fund.",
		fields,
		await buildChart(book, now, nav.navPerUnit, {
			granularity: "daily",
			days: 90,
			title: `${book === "paper" ? "TEST — " : ""}Unit price — daily digest`,
			subtitle: `Since inception ${signedPct(inceptionReturn)}`,
			reference: { value: parseMoney("1"), label: "Par $1.00" },
		}),
	);
}

export async function runCapitalDailyDigest(now = new Date()): Promise<void> {
	for (const book of ["live", "paper"] as const) {
		try {
			await sendDailyDigest(book, now);
		} catch (error) {
			logger.error(
				`Daily digest failed for ${book}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

async function pruneMinuteSnapshots(now: Date): Promise<void> {
	if (Date.now() - lastMinutePruneAt < 24 * 60 * 60_000) return;
	lastMinutePruneAt = Date.now();
	const cutoff = new Date(
		now.getTime() - MINUTE_HISTORY_DAYS * 24 * 60 * 60_000,
	);
	try {
		const deleted = await db
			.delete(capitalNavSnapshots)
			.where(
				and(
					eq(capitalNavSnapshots.granularity, "minute"),
					lt(capitalNavSnapshots.capturedAt, cutoff),
				),
			)
			.returning({ id: capitalNavSnapshots.id });
		if (deleted.length > 0) {
			logger.info(`Pruned ${deleted.length} minute NAV snapshot(s).`);
		}
	} catch (error) {
		logger.warn(
			`Minute NAV snapshot retention failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function runCapitalAlertsCycle(): Promise<void> {
	const now = new Date();
	try {
		for (const book of ["live", "paper"] as const) {
			try {
				await evaluateBook(book, now);
			} catch (error) {
				logger.error(
					`Capital alerts failed for ${book}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		await pruneMinuteSnapshots(now);
		await runCapitalPersonalAlertsCycle(now);
	} catch (error) {
		logger.error("Capital alerts cycle failed:", error);
	}
}

export function startCapitalAlerts(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "* * * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			await runCapitalAlertsCycle();
		},
	});
}

/**
 * Fixed 07:00 UTC digest. `skipBootRun` keeps a restart (or a missed tick)
 * from replaying a digest the system already sent; the persisted 24h cooldown
 * in `sendDailyDigest` is the second line of defence.
 */
export function startCapitalDailyDigest(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: DAILY_DIGEST_WORKER_NAME,
		schedule: { type: "cron", pattern: "0 7 * * *", timezone: "Etc/UTC" },
		skipBootRun: true,
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			await runCapitalDailyDigest();
		},
	});
}
