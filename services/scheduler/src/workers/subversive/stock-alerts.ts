import {
	db,
	eq,
	guildStockAlertConfigs,
	guildStockAlertStates,
	inArray,
	sql,
	userStockAlerts,
} from "@sentinel/database";
import {
	createEmptyUserStockAlertState,
	type GuildStockAlertConfig,
	isStockAlertRange,
	isUserStockAlertCondition,
	STOCK_ALERT_RANGES,
	type StockAlertEvent,
	type StockAlertRange,
	type StockAlertState,
	type TornSchema,
	type UserStockAlertEvent,
	type UserStockAlertSubscription,
} from "@sentinel/schemas";
import { type ManagedApiKey, TornError, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";
import {
	evaluateStockAlerts,
	normaliseStockAlertState,
	type StockAlertSnapshot,
	type StockAlertWindowPerformance,
} from "./stock-alert-rules";
import {
	getNextSubversiveUserKey,
	markSubversiveKeyDisabled,
	recordSubversiveKeySuccess,
} from "./subversive-key-pool";
import {
	evaluateUserStockAlert,
	normaliseUserStockAlertState,
} from "./user-stock-alert-rules";

const WORKER_NAME = "subversive:stock_alerts";
const logger = new Logger("Scheduler", "StockAlerts");

/**
 * How often the per-stock baselines are rebuilt from Torn even when nothing
 * moved.
 *
 * The fast path only fetches a stock's detail when its price changed, which is
 * sound — an unchanged price cannot set a new extreme — but a *stored* extreme
 * can age out of Torn's rolling windows. A periodic full sweep re-aligns every
 * baseline, so a stale-high figure can delay a genuine new high by at most this
 * interval instead of indefinitely.
 */
const FULL_REFRESH_INTERVAL_MS = 30 * 60_000;

/** Attempts per request before a stock is skipped for the cycle. */
const MAX_KEY_ATTEMPTS = 2;

/**
 * Detail failures tolerated in a row before the sweep gives up.
 *
 * A single stock failing is routine; every stock failing means the key pool is
 * rejecting requests, and continuing would only repeat the same warning for the
 * rest of the market.
 */
const MAX_CONSECUTIVE_DETAIL_FAILURES = 5;

/**
 * Detailed stock responses in flight at once during one sweep.
 *
 * The details of different stocks are independent, so a full refresh used to
 * cost one round trip per stock in series. The bound is deliberately small: it
 * stays inside the per-key window of Torn's rate limiter (50 requests / 60s per
 * key) rather than tripping it and waiting on a pause, and it multiplies the
 * sweep's throughput without widening the burst the pool has to absorb.
 */
const DETAIL_FETCH_CONCURRENCY = 4;

/**
 * Rows per multi-row state upsert statement.
 *
 * A cycle writes one row per (guild x stock) pair — a few hundred today — so this
 * only bounds the parameter count if the guild list or the market grows.
 */
const STATE_UPSERT_CHUNK_SIZE = 500;

/** Key-level Torn errors: the key is bad, not the request. */
const KEY_ERROR_CODES = new Set([2, 10, 13, 18]);

/** Maps each range onto the key Torn uses in `chart.performance`. */
const TORN_PERFORMANCE_KEYS: Record<
	StockAlertRange,
	keyof NonNullable<TornSchema<"TornStockDetailed">["chart"]["performance"]>
> = {
	"1h": "last_hour",
	"24h": "last_day",
	"7d": "last_week",
	"30d": "last_month",
	"1y": "last_year",
	all_time: "all_time",
};

let lastFullRefreshAtMs = 0;

/** Test seam: forgets the last full-sweep timestamp. */
export function resetStockAlertWorkerState(): void {
	lastFullRefreshAtMs = 0;
}

function isKeyError(error: unknown): boolean {
	if (error instanceof TornError) return KEY_ERROR_CODES.has(error.code);
	return String(error).includes("Key temporarily disabled");
}

/**
 * Runs one request against the Subversive key pool, rotating to a fresh key when
 * the current one is rejected.
 *
 * Keys are acquired per request rather than per cycle so a sweep of dozens of
 * calls spreads evenly across the pool instead of pinning one member. The key's
 * owner is passed through as the rate-limit bucket: Torn's limit is per account,
 * so bucketing every request under the anonymous user would throttle the whole
 * sweep as one account while the keys it uses are actually separate.
 */
async function requestWithKey<T>(
	label: string,
	run: (key: ManagedApiKey) => Promise<T>,
): Promise<T> {
	let lastError: unknown = null;

	for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
		const key: ManagedApiKey | null = await getNextSubversiveUserKey();
		if (!key) {
			throw new Error(
				"No active Subversive API keys available for the stock alert worker.",
			);
		}

		try {
			const result = await run(key);
			recordSubversiveKeySuccess(key.apiKey);
			return result;
		} catch (error) {
			lastError = error;
			if (isKeyError(error)) {
				const cooldownMs = markSubversiveKeyDisabled(key.apiKey);
				logger.warn(
					`${label} rejected key ending '...${key.apiKey.slice(-4)}' (disabled for ${Math.round(cooldownMs / 1000)}s).`,
				);
			}
			if (!isKeyError(error) || attempt === MAX_KEY_ATTEMPTS) throw error;
		}
	}

	throw lastError ?? new Error(`${label} failed without a recorded error.`);
}

/**
 * Guilds with stock alerts switched on and a channel to post them in.
 *
 * Both conditions are required to be considered active: an enabled guild with no
 * channel would otherwise drive a full Torn sweep every cycle for nothing.
 */
async function loadActiveConfigs(): Promise<
	Map<string, GuildStockAlertConfig>
> {
	const active = new Map<string, GuildStockAlertConfig>();

	let rows: Array<typeof guildStockAlertConfigs.$inferSelect>;
	try {
		rows = await db.select().from(guildStockAlertConfigs);
	} catch (error) {
		logger.error("Failed to load stock alert configurations:", error);
		return active;
	}

	for (const row of rows) {
		if (!row.enabled) continue;
		if (!row.channelId) {
			logger.warn(
				`Stock alerts are enabled for guild ${row.guildId} but no channel is selected; skipping it until a channel is set.`,
			);
			continue;
		}
		active.set(row.guildId, {
			enabled: row.enabled,
			channelId: row.channelId,
			changeRules: row.changeRules ?? [],
			highLowRanges: (row.highLowRanges ?? []).filter(isStockAlertRange),
			cooldownMinutes: row.cooldownMinutes,
			updatedAt: row.updatedAt.toISOString(),
			updatedBy: row.updatedBy ?? undefined,
		});
	}

	return active;
}

/**
 * Every enabled personal subscription, grouped by the stock it watches.
 *
 * Grouped because the sweep is driven per stock: a stock's subscriptions are all
 * evaluated from the same snapshot, and stocks nobody watches cost nothing.
 */
async function loadUserSubscriptions(): Promise<
	Map<number, UserStockAlertSubscription[]>
> {
	const byStock = new Map<number, UserStockAlertSubscription[]>();

	let rows: Array<typeof userStockAlerts.$inferSelect>;
	try {
		rows = await db.select().from(userStockAlerts);
	} catch (error) {
		logger.error("Failed to load personal stock alerts:", error);
		return byStock;
	}

	for (const row of rows) {
		if (!row.enabled) continue;
		if (!isUserStockAlertCondition(row.condition)) continue;
		if (row.rangeKey !== null && !isStockAlertRange(row.rangeKey)) continue;

		const subscription: UserStockAlertSubscription = {
			id: row.id,
			guildId: row.guildId,
			discordUserId: row.discordUserId,
			stockId: row.stockId,
			condition: row.condition,
			range: row.rangeKey,
			threshold: row.threshold ?? null,
			conditionKey: row.conditionKey,
			enabled: row.enabled,
			state: normaliseUserStockAlertState(row.state),
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};

		const bucket = byStock.get(row.stockId);
		if (bucket) bucket.push(subscription);
		else byStock.set(row.stockId, [subscription]);
	}

	return byStock;
}

function toWindowPerformance(
	source: TornSchema<"TornStockPerformance"> | undefined,
): StockAlertWindowPerformance | undefined {
	if (!source) return undefined;
	return {
		changePct: source.change_percentage,
		start: source.start,
		high: source.high,
		low: source.low,
	};
}

/**
 * Normalises one stock's Torn responses into the shape the rules consume.
 *
 * The list response supplies the current price; the detailed response supplies
 * Torn's own rolling-range figures for all six ranges and the one-minute history
 * series. Returns null when the price is unusable, which is the only case where
 * the stock is skipped entirely rather than evaluated with less context.
 */
export function buildStockSnapshot(
	stock: TornSchema<"TornStock">,
	detailed: TornSchema<"TornStockDetailed"> | null,
): StockAlertSnapshot | null {
	const price = stock.market?.price;
	if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
		return null;
	}

	const performance: StockAlertSnapshot["performance"] = {};
	for (const range of STOCK_ALERT_RANGES) {
		const source = detailed?.chart?.performance?.[TORN_PERFORMANCE_KEYS[range]];
		const mapped = toWindowPerformance(source);
		if (mapped) performance[range] = mapped;
	}

	const history = Array.isArray(detailed?.chart?.history)
		? detailed.chart.history
				.filter(
					(point) =>
						typeof point?.timestamp === "number" &&
						typeof point?.price === "number",
				)
				.map((point) => ({ timestamp: point.timestamp, price: point.price }))
		: [];

	return {
		stockId: stock.id,
		name: stock.name,
		acronym: stock.acronym,
		price,
		performance,
		history,
	};
}

/** Whether two persisted states differ enough to be worth writing back. */
function hasStateChanged(
	previous: StockAlertState | null,
	next: StockAlertState,
): boolean {
	if (!previous) return true;
	if (previous.seeded !== next.seeded) return true;
	if (previous.lastPrice !== next.lastPrice) return true;
	if (!extremesEqual(previous.extremes, next.extremes)) return true;
	return !shallowNumberMapEqual(previous.lastAlertAt, next.lastAlertAt);
}

/** Field-wise comparison of the range (high, low) extremes record. */
function extremesEqual(
	a: StockAlertState["extremes"] | undefined,
	b: StockAlertState["extremes"] | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;

	for (const range of STOCK_ALERT_RANGES) {
		const left = a[range];
		const right = b[range];
		if (left === right) continue;
		if (!left || !right) return false;
		if (left.high !== right.high || left.low !== right.low) return false;
	}
	return true;
}

/**
 * Field-wise comparison of two small numeric records.
 *
 * These hold a handful of alert keys, so comparing them directly avoids the four
 * `JSON.stringify` calls per (guild x stock) pair the previous form paid.
 */
function shallowNumberMapEqual(
	a: Record<string, number> | undefined,
	b: Record<string, number> | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;

	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;

	for (const key of aKeys) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}

export interface StockAlertCycleResult {
	stocksPolled: number;
	detailsFetched: number;
	alertsQueued: number;
	channelsNotified: number;
	userAlertsQueued: number;
}

/**
 * What one stock's detail attempt produced, held until the whole window has
 * settled so the failure run is counted in market order rather than in
 * completion order.
 */
type DetailOutcome =
	| { kind: "skipped" }
	| { kind: "fetched"; snapshot: StockAlertSnapshot | null }
	| { kind: "failed" };

/**
 * One alerting cycle: poll the market, evaluate every active guild and every
 * personal subscription, persist state, then hand the resulting alerts to the bot
 * over IPC.
 */
export async function runStockAlertCycle(
	signal?: AbortSignal,
): Promise<StockAlertCycleResult> {
	const finishLog = logger.time();
	const nowMs = Date.now();

	const configs = await loadActiveConfigs();
	const subscriptionsByStock = await loadUserSubscriptions();

	// Guild alerts and personal alerts are independent: a server may have no
	// channel configured while its members still have personal subscriptions, and
	// vice versa. Only when neither exists is the Torn market worth polling.
	if (configs.size === 0 && subscriptionsByStock.size === 0) {
		logger.debug(
			"No guild has stock alerts enabled and no personal subscriptions exist; skipping cycle without polling Torn.",
		);
		return {
			stocksPolled: 0,
			detailsFetched: 0,
			alertsQueued: 0,
			channelsNotified: 0,
			userAlertsQueued: 0,
		};
	}

	const universe = await requestWithKey("/torn/stocks", (key) =>
		tornApi.get("/torn/stocks", { apiKey: key.apiKey, userId: key.userId }),
	);
	const stocks = universe.stocks ?? [];
	if (stocks.length === 0) {
		logger.warn("Torn returned no stocks; skipping this cycle.");
		return {
			stocksPolled: 0,
			detailsFetched: 0,
			alertsQueued: 0,
			channelsNotified: 0,
			userAlertsQueued: 0,
		};
	}

	const guildIds = [...configs.keys()];
	const stateRows =
		guildIds.length > 0
			? await db
					.select()
					.from(guildStockAlertStates)
					.where(inArray(guildStockAlertStates.guildId, guildIds))
			: [];

	const stateByGuildStock = new Map<string, StockAlertState>();
	for (const row of stateRows) {
		stateByGuildStock.set(
			`${row.guildId}:${row.stockId}`,
			normaliseStockAlertState(row.state),
		);
	}

	const forceFullRefresh =
		nowMs - lastFullRefreshAtMs >= FULL_REFRESH_INTERVAL_MS;

	// A stock needs its detailed response when any active guild has never seen it,
	// when its price moved since the last sweep, when a personal subscription
	// watches it, or on a forced refresh. An unchanged price cannot set a new
	// extreme or cross a change threshold, so skipping it is safe rather than
	// merely cheap: a high or low that appears and reverts inside one cycle is
	// still visible in Torn's rolling windows on the next refresh, so it is
	// delayed by at most that interval, never lost.
	const needsDetails = (stock: TornSchema<"TornStock">): boolean => {
		// A personally-watched stock always gets its detail response: range
		// conditions are judged entirely from figures only it carries, and a
		// price-only subscription still needs a snapshot to be evaluated against at
		// all. Subscriptions are bounded per user, so this cannot run away.
		if ((subscriptionsByStock.get(stock.id)?.length ?? 0) > 0) return true;
		if (forceFullRefresh) return true;
		const price = stock.market?.price;
		if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
			return false;
		}
		for (const guildId of guildIds) {
			const state = stateByGuildStock.get(`${guildId}:${stock.id}`);
			if (!state?.seeded) return true;
			if (state.lastPrice === null || state.lastPrice !== price) return true;
		}
		return false;
	};

	const snapshots: StockAlertSnapshot[] = [];
	let detailsFetched = 0;
	let consecutiveFailures = 0;

	// The market is swept in windows rather than one stock at a time: the details
	// of different stocks are independent, so up to `DETAIL_FETCH_CONCURRENCY` of
	// them share a round trip's latency instead of paying it in series. Outcomes
	// are applied in market order afterwards, so the snapshots — and therefore the
	// alerts — are built exactly as they were serially.
	for (let index = 0; index < stocks.length; ) {
		if (signal?.aborted) {
			logger.warn(
				"Stock alert cycle aborted mid-sweep; the remaining stocks continue next cycle.",
			);
			break;
		}

		// The window is capped by the failures still allowed as well as by the
		// concurrency bound. That is what keeps the breaker identical to the serial
		// sweep: a window can never hold more requests than the failures remaining
		// before it trips, so the sweep stops on exactly the same stock and the
		// checks either side of the limit are never skipped.
		const windowSize = Math.max(
			1,
			Math.min(
				DETAIL_FETCH_CONCURRENCY,
				MAX_CONSECUTIVE_DETAIL_FAILURES - consecutiveFailures,
			),
		);
		const windowStocks = stocks.slice(index, index + windowSize);
		index += windowStocks.length;

		const outcomes = await Promise.all(
			windowStocks.map(async (stock): Promise<DetailOutcome> => {
				if (!needsDetails(stock)) return { kind: "skipped" };

				try {
					const response = await requestWithKey(
						`/torn/${stock.id}/stocks`,
						(key) =>
							tornApi.get("/torn/{stockId}/stocks", {
								apiKey: key.apiKey,
								userId: key.userId,
								pathParams: { stockId: stock.id },
							}),
					);
					return {
						kind: "fetched",
						snapshot: buildStockSnapshot(stock, response.stocks ?? null),
					};
				} catch (error) {
					// One unreachable stock must not cost the whole market its sweep, and
					// must not have its price recorded either: leaving the row untouched
					// means the next cycle retries the detailed fetch for it.
					logger.warn(
						`Skipping ${stock.acronym || `stock ${stock.id}`} this cycle: ${error instanceof Error ? error.message : String(error)}`,
					);
					return { kind: "failed" };
				}
			}),
		);

		for (const outcome of outcomes) {
			if (outcome.kind === "fetched") {
				detailsFetched++;
				consecutiveFailures = 0;
				if (outcome.snapshot) snapshots.push(outcome.snapshot);
			} else if (outcome.kind === "failed") {
				consecutiveFailures++;
			}
		}

		// A run of failures means the pool itself is failing (every key rejected or
		// disabled), not one unlucky stock. Stop rather than repeat the same failure
		// for the rest of the market.
		if (consecutiveFailures >= MAX_CONSECUTIVE_DETAIL_FAILURES) {
			logger.warn(
				`Aborting the sweep after ${consecutiveFailures} consecutive detail failures; the rest of the market is retried next cycle.`,
			);
			break;
		}
	}

	if (forceFullRefresh) lastFullRefreshAtMs = nowMs;

	const alertsByChannel = new Map<string, Map<string, StockAlertEvent>>();
	const stateUpserts: Array<{
		guildId: string;
		stockId: number;
		state: StockAlertState;
	}> = [];
	const userAlerts: UserStockAlertEvent[] = [];
	const userStateUpserts: Array<{
		id: string;
		state: UserStockAlertSubscription["state"];
	}> = [];

	for (const guildId of guildIds) {
		const config = configs.get(guildId);
		if (!config?.channelId) continue;

		for (const snapshot of snapshots) {
			const stateKey = `${guildId}:${snapshot.stockId}`;
			const previous = stateByGuildStock.get(stateKey) ?? null;

			const { events, nextState } = evaluateStockAlerts({
				snapshot,
				config,
				state: previous,
				nowMs,
			});

			if (hasStateChanged(previous, nextState)) {
				stateUpserts.push({
					guildId,
					stockId: snapshot.stockId,
					state: nextState,
				});
			}
			if (events.length === 0) continue;

			// Keyed by stock + alert kind so two guilds sharing one channel get a
			// single embed for the same event instead of a duplicate pair.
			let bucket = alertsByChannel.get(config.channelId);
			if (!bucket) {
				bucket = new Map<string, StockAlertEvent>();
				alertsByChannel.set(config.channelId, bucket);
			}
			for (const event of events) {
				bucket.set(`${event.stockId}:${event.alertKey}`, event);
			}
		}
	}

	// ── Personal alerts ───────────────────────────────────────────────────────
	// Evaluated from the same snapshots, but independently of any guild's channel
	// configuration: a user's subscription is theirs, not the server's.
	for (const snapshot of snapshots) {
		const subscriptions = subscriptionsByStock.get(snapshot.stockId);
		if (!subscriptions || subscriptions.length === 0) continue;

		for (const subscription of subscriptions) {
			const { event, nextState } = evaluateUserStockAlert({
				snapshot,
				subscription,
				state: subscription.state ?? createEmptyUserStockAlertState(),
				nowMs,
			});

			if (needsUserStateWrite(subscription.state, nextState)) {
				userStateUpserts.push({ id: subscription.id, state: nextState });
			}
			if (event) userAlerts.push(event);
		}
	}

	if (userStateUpserts.length > 0) {
		const now = new Date();
		await db.transaction(async (tx) => {
			for (const row of userStateUpserts) {
				await tx
					.update(userStockAlerts)
					.set({ state: row.state, updatedAt: now })
					.where(eq(userStockAlerts.id, row.id));
			}
		});
	}

	if (stateUpserts.length > 0) {
		const now = new Date();

		// One multi-row upsert per chunk instead of one statement per row. The
		// stored state differs per row, so the update takes each value back from
		// `excluded` — the row the insert proposed — which is exactly what the old
		// row-at-a-time loop wrote.
		//
		// Duplicate (guild, stock) pairs are collapsed first, keeping the last one:
		// Postgres rejects a statement that updates the same conflict target twice,
		// and last-write-wins is what the sequential loop left behind.
		const deduped = new Map<
			string,
			{ guildId: string; stockId: number; state: StockAlertState }
		>();
		for (const row of stateUpserts) {
			deduped.set(`${row.guildId}:${row.stockId}`, row);
		}
		const rowsToUpsert = [...deduped.values()];

		await db.transaction(async (tx) => {
			for (
				let offset = 0;
				offset < rowsToUpsert.length;
				offset += STATE_UPSERT_CHUNK_SIZE
			) {
				const chunk = rowsToUpsert.slice(
					offset,
					offset + STATE_UPSERT_CHUNK_SIZE,
				);
				await tx
					.insert(guildStockAlertStates)
					.values(
						chunk.map((row) => ({
							guildId: row.guildId,
							stockId: row.stockId,
							state: row.state,
							createdAt: now,
							updatedAt: now,
						})),
					)
					.onConflictDoUpdate({
						target: [
							guildStockAlertStates.guildId,
							guildStockAlertStates.stockId,
						],
						set: {
							state: sql`excluded.state`,
							updatedAt: sql`excluded.updated_at`,
						},
					});
			}
		});
	}

	const ipcServer = getActiveIpcServer();
	let alertsQueued = 0;
	let channelsNotified = 0;

	for (const [channelId, bucket] of alertsByChannel) {
		const alerts = [...bucket.values()];
		alertsQueued += alerts.length;
		if (!ipcServer) continue;

		ipcServer.broadcast({
			action: "subversive_stock_alerts",
			data: { notificationChannelId: channelId, alerts },
		});
		channelsNotified++;
	}

	if (userAlerts.length > 0 && ipcServer) {
		ipcServer.broadcast({
			action: "user_stock_alerts",
			data: { alerts: userAlerts },
		});
	}

	if (alertsQueued > 0 || userAlerts.length > 0) {
		logger.info(
			`Queued ${alertsQueued} guild alert(s) across ${alertsByChannel.size} channel(s) and ${userAlerts.length} personal alert(s)${ipcServer ? "" : " (no IPC listener connected, so nothing was delivered)"}.`,
		);
	}

	logger.info(
		`Polled ${stocks.length} stock(s), fetched ${detailsFetched} detail response(s) for ${configs.size} guild(s) and ${subscriptionsByStock.size} personally-watched stock(s)${forceFullRefresh ? " (full baseline refresh)" : ""}.`,
	);
	finishLog();

	return {
		stocksPolled: stocks.length,
		detailsFetched,
		alertsQueued,
		channelsNotified,
		userAlertsQueued: userAlerts.length,
	};
}

/** Whether a subscription's stored state actually moved this cycle. */
function needsUserStateWrite(
	previous: UserStockAlertSubscription["state"] | undefined,
	next: UserStockAlertSubscription["state"],
): boolean {
	if (!previous) return true;
	return (
		previous.seeded !== next.seeded ||
		previous.wasTrue !== next.wasTrue ||
		previous.lastExtreme !== next.lastExtreme ||
		previous.lastAlertAt !== next.lastAlertAt
	);
}

/**
 * Starts the stock alert worker: a five-minute sweep of the Torn stock market.
 *
 * Five minutes is deliberate. Every alert figure comes from Torn's own rolling
 * windows and one-minute history, so the comparison is exact regardless of how
 * often we look; the cadence only bounds how late an alert can arrive and how
 * many requests a sweep costs. A quieter cadence would delay alerts without
 * improving their accuracy.
 */
export function startSubversiveStockAlerts(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "*/5 * * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs,
		// Wrapped so the cycle's result object never reaches the runner, whose
		// contract only accepts a number, boolean or void.
		handler: async (signal) => {
			await runStockAlertCycle(signal);
		},
	});
}
