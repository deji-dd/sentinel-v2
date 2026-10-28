import { db, eq, userShopliftingAlerts } from "@sentinel/database";
import {
	createEmptyUserShopliftingAlertState,
	findShopliftingShop,
	isUserShopliftingAlertCondition,
	type ShopliftingSecurityStatus,
	type ShopliftingShopSnapshot,
	type TornSchema,
	type UserShopliftingAlertEvent,
	type UserShopliftingAlertSubscription,
} from "@sentinel/schemas";
import { type ManagedApiKey, tornApi, TornError } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";

import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";
import {
	evaluateUserShopliftingAlert,
	normaliseUserShopliftingAlertState,
} from "./shoplifting-alert-rules";
import {
	getNextSubversiveUserKey,
	markSubversiveKeyDisabled,
	recordSubversiveKeySuccess,
} from "./subversive-key-pool";

const WORKER_NAME = "subversive:shoplifting_alerts";
const logger = new Logger("Scheduler", "ShopliftingAlerts");

/** Attempts per request before the cycle is abandoned. */
const MAX_KEY_ATTEMPTS = 2;

/** Key-level Torn errors: the key is bad, not the request. */
const KEY_ERROR_CODES = new Set([2, 10, 13, 18]);

/** Whether an error means the key itself was rejected. */
function isKeyError(error: unknown): boolean {
	if (error instanceof TornError) return KEY_ERROR_CODES.has(error.code);
	return String(error).includes("Key temporarily disabled");
}

/**
 * Runs one request against the Subversive key pool, rotating to a fresh key when
 * the current one is rejected.
 *
 * The key's owner is passed through as the rate-limit bucket because Torn's limit
 * is per account; bucketing every request under one anonymous user would throttle
 * the whole pool as a single account.
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
				"No active Subversive API keys available for the shoplifting alert worker.",
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

/** Every enabled personal subscription, grouped by the shop it watches. */
async function loadSubscriptions(): Promise<
	Map<number, UserShopliftingAlertSubscription[]>
> {
	const byShop = new Map<number, UserShopliftingAlertSubscription[]>();

	let rows: Array<typeof userShopliftingAlerts.$inferSelect>;
	try {
		rows = await db.select().from(userShopliftingAlerts);
	} catch (error) {
		logger.error("Failed to load personal shoplifting alerts:", error);
		return byShop;
	}

	for (const row of rows) {
		if (!row.enabled) continue;
		if (!isUserShopliftingAlertCondition(row.condition)) continue;
		if (!findShopliftingShop(row.shopId)) continue;

		const subscription: UserShopliftingAlertSubscription = {
			id: row.id,
			guildId: row.guildId,
			discordUserId: row.discordUserId,
			shopId: row.shopId,
			condition: row.condition,
			conditionKey: row.conditionKey,
			enabled: row.enabled,
			state: normaliseUserShopliftingAlertState(row.state),
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};

		const bucket = byShop.get(row.shopId);
		if (bucket) bucket.push(subscription);
		else byShop.set(row.shopId, [subscription]);
	}

	return byShop;
}

/**
 * Normalises Torn's response into the snapshots the rules consume.
 *
 * Unknown shop ids and malformed status entries are skipped rather than guessed
 * at: a status without a string title or a boolean flag is not evidence that a
 * security measure is down.
 */
export function buildShopliftingSnapshots(
	response: TornSchema<"TornShopliftingResponse">,
): Map<number, ShopliftingShopSnapshot> {
	const snapshots = new Map<number, ShopliftingShopSnapshot>();

	for (const entry of response.shoplifting ?? []) {
		const shop = findShopliftingShop(entry.id);
		if (!shop) continue;

		const statuses: ShopliftingSecurityStatus[] = [];
		for (const status of entry.status ?? []) {
			if (typeof status.title !== "string") continue;
			if (typeof status.disabled !== "boolean") continue;
			statuses.push({ title: status.title, disabled: status.disabled });
		}

		if (statuses.length === 0) continue;
		snapshots.set(shop.id, {
			shopId: shop.id,
			name: shop.name,
			statuses,
		});
	}

	return snapshots;
}

export interface ShopliftingAlertCycleResult {
	shopsPolled: number;
	alertsQueued: number;
	usersNotified: number;
}

/**
 * One alerting poll: fetch every shop's security state, evaluate each personal
 * subscription, persist the edge memory, then hand the resulting events to the
 * bot over IPC.
 */
export async function runShopliftingAlertCycle(
	signal?: AbortSignal,
): Promise<ShopliftingAlertCycleResult> {
	const finishLog = logger.time();
	const nowMs = Date.now();

	const subscriptionsByShop = await loadSubscriptions();
	if (subscriptionsByShop.size === 0) {
		logger.debug(
			"No personal shoplifting alerts exist; skipping the Torn poll.",
		);
		return { shopsPolled: 0, alertsQueued: 0, usersNotified: 0 };
	}

	if (signal?.aborted) {
		return { shopsPolled: 0, alertsQueued: 0, usersNotified: 0 };
	}

	const response = await requestWithKey("/torn/shoplifting", (key) =>
		tornApi.get("/torn/shoplifting", {
			apiKey: key.apiKey,
			userId: key.userId,
			// Security windows are as short as ten minutes, so a cached response is
			// the difference between catching a guard break and reading yesterday's
			// state.
			queryParams: { timestamp: Math.floor(Date.now() / 1000) },
		}),
	);
	const snapshots = buildShopliftingSnapshots(response);

	const events: UserShopliftingAlertEvent[] = [];
	const stateUpserts: Array<{
		id: string;
		state: UserShopliftingAlertSubscription["state"];
	}> = [];

	for (const [shopId, subscriptions] of subscriptionsByShop) {
		const snapshot = snapshots.get(shopId);
		if (!snapshot) continue;

		for (const subscription of subscriptions) {
			const { event, nextState } = evaluateUserShopliftingAlert({
				snapshot,
				subscription,
				state: subscription.state ?? createEmptyUserShopliftingAlertState(),
				nowMs,
			});

			if (needsStateWrite(subscription.state, nextState)) {
				stateUpserts.push({ id: subscription.id, state: nextState });
			}
			if (event) events.push(event);
		}
	}

	if (stateUpserts.length > 0) {
		const now = new Date();
		await db.transaction(async (tx) => {
			for (const row of stateUpserts) {
				await tx
					.update(userShopliftingAlerts)
					.set({ state: row.state, updatedAt: now })
					.where(eq(userShopliftingAlerts.id, row.id));
			}
		});
	}

	const ipcServer = getActiveIpcServer();
	let usersNotified = 0;

	if (events.length > 0 && ipcServer) {
		ipcServer.broadcast({
			action: "user_shoplifting_alerts",
			data: { alerts: events },
		});
		usersNotified = new Set(events.map((event) => event.discordUserId)).size;
	}

	if (events.length > 0) {
		logger.info(
			`Queued ${events.length} shoplifting alert(s) for ${usersNotified} user(s)${ipcServer ? "" : " (no IPC listener connected, so nothing was delivered)"}.`,
		);
	}

	logger.debug(
		`Polled ${snapshots.size} shop(s) for ${subscriptionsByShop.size} watched shop(s).`,
	);
	finishLog();

	return {
		shopsPolled: snapshots.size,
		alertsQueued: events.length,
		usersNotified,
	};
}

/** Whether a subscription's persisted state actually moved this poll. */
function needsStateWrite(
	previous: UserShopliftingAlertSubscription["state"] | undefined,
	next: UserShopliftingAlertSubscription["state"],
): boolean {
	if (!previous) return true;
	return (
		previous.seeded !== next.seeded ||
		previous.wasTrue !== next.wasTrue ||
		previous.lastAlertAt !== next.lastAlertAt
	);
}

/**
 * Starts the shoplifting alert worker.
 *
 * One minute is deliberate: guards only break for 10–15 minutes, so a slower
 * poll would routinely miss the shortest — and most valuable — clean windows.
 * The endpoint is a single public request per cycle, and the cycle is skipped
 * entirely when nobody has a subscription.
 */
export function startSubversiveShopliftingAlerts(
	options?: WorkerStartOptions,
): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "* * * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs,
		handler: async (signal) => {
			await runShopliftingAlertCycle(signal);
		},
	});
}
