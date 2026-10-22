import {
	and,
	asc,
	db,
	eq,
	gt,
	isNull,
	notInArray,
	or,
	subversiveTargetFinderTargets,
} from "@sentinel/database";
import type {
	SubversiveChainAlertTarget,
	SubversiveChainConfig,
} from "@sentinel/schemas";
import { tornApi, TornError } from "@sentinel/torn-api";
import {
	getSubversiveFactionName,
	Logger,
	SUBVERSIVE_FAMILY_FACTION_IDS,
} from "@sentinel/utils";

import { resolveChainConfigs } from "../../lib/chain-config";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";
import {
	getNextSubversiveUserKey,
	markSubversiveKeyDisabled,
	recordSubversiveKeySuccess,
} from "./subversive-key-pool";

const logger = new Logger("Scheduler", "SubversiveChainMonitor");

export const CHAIN_MONITOR_WORKER_NAME = "subversive:chain_monitor";

/** Poll interval while at least one configured faction has a qualifying chain. */
export const ACTIVE_CADENCE_MS = 5_000;

/** Longest idle poll interval. */
export const MAX_IDLE_CADENCE_MS = 60_000;

/** Shortest idle poll interval, even for a very small warning window. */
export const MIN_IDLE_CADENCE_MS = 10_000;

/**
 * A chain warning is only valid if the snapshot it was derived from is fresh.
 *
 * The worker fetches and evaluates in the same cycle, so this is a safety rail:
 * if a future refactor ever reuses a cached snapshot — or a DB/target lookup
 * delays the send — an old chain timer can never trigger a blind ping.
 */
export const MAX_WARNING_SNAPSHOT_AGE_MS = 15_000;

/** Key-level Torn errors: the key is bad, not the request. */
const KEY_ERROR_CODES = new Set([2, 10, 13, 18]);

/** Attempts per faction per cycle before the cycle gives up on that faction. */
const MAX_KEY_ATTEMPTS = 2;

/** Suppresses a repeating failure log for one faction. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

export interface ChainSnapshot {
	/** Torn's current chain count. */
	current: number;
	/** Torn's displayed chain target/max. */
	max: number;
	/** Seconds until the chain breaks. */
	timeoutSeconds: number;
	/** Timestamp until which the chain is on cooldown. */
	cooldown: number;
	/** Epoch seconds when this chain started. */
	start: number;
	/** Chain respect modifier. */
	modifier: number;
	/** Local epoch ms when the snapshot was fetched. */
	fetchedAtMs: number;
}

export interface ChainMonitorState {
	chainStart: number;
	lastWarningAtMs: number | null;
	warningCount: number;
	active: boolean;
}

export interface ChainWarningDecision {
	state: ChainMonitorState;
	send: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function emptyState(): ChainMonitorState {
	return {
		chainStart: 0,
		lastWarningAtMs: null,
		warningCount: 0,
		active: false,
	};
}

/**
 * Parses Torn's `/faction/{id}/chain` response.
 *
 * Returns `null` when the payload is missing or malformed, which the caller
 * treats as an API failure. That distinction matters: a broken response must
 * never be read as "chain count zero" and clear a live warning, nor as a fresh
 * chain that is safe to ping against.
 *
 * An explicit `chain: null` is Torn's "no chain" state and parses to zeros.
 */
export function parseChainSnapshot(
	raw: unknown,
	fetchedAtMs: number,
): ChainSnapshot | null {
	if (!isRecord(raw) || !("chain" in raw)) return null;

	const chain = raw.chain;
	if (chain === null) {
		return {
			current: 0,
			max: 0,
			timeoutSeconds: 0,
			cooldown: 0,
			start: 0,
			modifier: 0,
			fetchedAtMs,
		};
	}
	if (!isRecord(chain)) return null;

	const current = finiteNumber(chain.current);
	const timeoutSeconds = finiteNumber(chain.timeout);
	if (current === null || timeoutSeconds === null) return null;

	return {
		current: Math.max(0, current),
		max: Math.max(0, finiteNumber(chain.max) ?? 0),
		timeoutSeconds: Math.max(0, timeoutSeconds),
		cooldown: Math.max(0, finiteNumber(chain.cooldown) ?? 0),
		start: Math.max(0, finiteNumber(chain.start) ?? 0),
		modifier: finiteNumber(chain.modifier) ?? 1,
		fetchedAtMs,
	};
}

/**
 * Decides whether one fresh chain snapshot should produce a warning.
 *
 * The snapshot's age is part of the decision on purpose: when Torn is down,
 * rate-limited or returning garbage, the caller passes no snapshot at all, and
 * this function additionally refuses to act on one that is no longer fresh.
 */
export function evaluateChainWarning(
	previous: ChainMonitorState | undefined,
	snapshot: ChainSnapshot,
	config: SubversiveChainConfig,
	nowMs: number,
): ChainWarningDecision {
	const previousState = previous ?? emptyState();

	if (nowMs - snapshot.fetchedAtMs > MAX_WARNING_SNAPSHOT_AGE_MS) {
		return {
			state: { ...previousState, active: false },
			send: false,
		};
	}

	const qualifies =
		snapshot.current >= config.minimumChainStart && snapshot.timeoutSeconds > 0;

	if (!qualifies) {
		return { state: emptyState(), send: false };
	}

	// A new chain starts with no warning history. A chain that has merely become
	// active keeps it, so a timer that was already warning does not reset on the
	// next poll.
	const state: ChainMonitorState =
		previousState.chainStart === snapshot.start
			? { ...previousState, active: true }
			: {
					chainStart: snapshot.start,
					lastWarningAtMs: null,
					warningCount: 0,
					active: true,
				};

	// The timer rose above the threshold (a hit extended the chain), so the next
	// dip into the warning window starts a fresh warning sequence. This also
	// stops repeats while the chain is comfortable.
	if (snapshot.timeoutSeconds > config.chainTimeWarningSeconds) {
		return {
			state: {
				chainStart: state.chainStart,
				lastWarningAtMs: null,
				warningCount: 0,
				active: true,
			},
			send: false,
		};
	}

	if (state.lastWarningAtMs === null) {
		return {
			state: {
				chainStart: state.chainStart,
				lastWarningAtMs: nowMs,
				warningCount: 1,
				active: true,
			},
			send: true,
		};
	}

	if (config.subsequentWarningIntervalSeconds <= 0) {
		return { state, send: false };
	}

	if (
		nowMs - state.lastWarningAtMs >=
		config.subsequentWarningIntervalSeconds * 1000
	) {
		return {
			state: {
				chainStart: state.chainStart,
				lastWarningAtMs: nowMs,
				warningCount: state.warningCount + 1,
				active: true,
			},
			send: true,
		};
	}

	return { state, send: false };
}

/**
 * Idle poll interval for the current configuration set.
 *
 * Polling no slower than half the shortest warning window means a chain that
 * newly reaches its minimum is discovered before its timer can run out, while
 * the 10s floor and 60s ceiling keep idle API usage predictable.
 */
export function idleCadenceMsFor(
	configs: Iterable<SubversiveChainConfig>,
): number {
	let shortestWarningSeconds = Number.POSITIVE_INFINITY;

	for (const config of configs) {
		if (!config.enabled || !config.channelId) continue;
		if (config.chainTimeWarningSeconds < shortestWarningSeconds) {
			shortestWarningSeconds = config.chainTimeWarningSeconds;
		}
	}

	if (!Number.isFinite(shortestWarningSeconds)) return MAX_IDLE_CADENCE_MS;

	return Math.min(
		MAX_IDLE_CADENCE_MS,
		Math.max(MIN_IDLE_CADENCE_MS, Math.floor(shortestWarningSeconds * 500)),
	);
}

/**
 * Picks the lowest-stat attackable targets from the existing target-finder
 * pool. No Torn calls: the pool is maintained by the target finder worker, and
 * a chain warning must stay cheap and fast.
 */
export async function selectLowStatOkayTargets(
	limit = 3,
): Promise<SubversiveChainAlertTarget[]> {
	try {
		const rows = await db
			.select({
				targetId: subversiveTargetFinderTargets.targetId,
				name: subversiveTargetFinderTargets.name,
				level: subversiveTargetFinderTargets.level,
				estimatedBs: subversiveTargetFinderTargets.estimatedBs,
			})
			.from(subversiveTargetFinderTargets)
			.where(
				and(
					eq(subversiveTargetFinderTargets.status, "okay"),
					eq(subversiveTargetFinderTargets.inHospital, false),
					gt(subversiveTargetFinderTargets.estimatedBs, 0),
					or(
						isNull(subversiveTargetFinderTargets.factionId),
						notInArray(subversiveTargetFinderTargets.factionId, [
							...SUBVERSIVE_FAMILY_FACTION_IDS,
						]),
					),
				),
			)
			.orderBy(asc(subversiveTargetFinderTargets.estimatedBs))
			.limit(limit);

		return rows.map((row) => ({
			id: row.targetId,
			name: row.name,
			level: row.level,
			estimatedBs: row.estimatedBs,
		}));
	} catch (err) {
		logger.warn("Failed to select chain-warning targets:", err);
		return [];
	}
}

const monitorState = new Map<number, ChainMonitorState>();
const lastFailureLogAt = new Map<number, number>();

/** Test seam: forgets per-faction warning and failure state. */
export function resetChainMonitorStateForTesting(): void {
	monitorState.clear();
	lastFailureLogAt.clear();
}

function isKeyError(error: unknown): boolean {
	if (error instanceof TornError) return KEY_ERROR_CODES.has(error.code);
	return String(error).includes("Key temporarily disabled");
}

function logFetchFailure(factionId: number, error: unknown): void {
	const now = Date.now();
	const last = lastFailureLogAt.get(factionId) ?? 0;
	if (now - last < FAILURE_LOG_INTERVAL_MS) return;
	lastFailureLogAt.set(factionId, now);
	logger.warn(
		`Chain poll failed for faction ${factionId}; suppressing warnings until a fresh snapshot is available:`,
		error,
	);
}

/**
 * Fetches one faction's chain with a key from the Subversive script pool.
 *
 * Returns `null` for every failure path — no key, key rejection, Torn error,
 * network failure, malformed response. The caller treats `null` as "unknown"
 * and never sends a warning from it.
 */
async function fetchChainSnapshot(
	factionId: number,
	nowMs: number,
): Promise<ChainSnapshot | null> {
	let lastError: unknown = null;

	for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
		const key = await getNextSubversiveUserKey();
		if (!key) {
			logger.debug(
				`No active Subversive API key available for faction ${factionId}'s chain poll.`,
			);
			return null;
		}

		try {
			const response = await tornApi.get("/faction/{id}/chain", {
				apiKey: key.apiKey,
				userId: key.userId,
				pathParams: { id: factionId },
				// Our own key rotation handles failover; the managed client's
				// retries would only delay the next cycle.
				maxAttempts: 1,
			});

			recordSubversiveKeySuccess(key.apiKey);
			const snapshot = parseChainSnapshot(response, nowMs);
			if (!snapshot) {
				logger.warn(
					`Malformed chain response for faction ${factionId}; ignoring it rather than assuming no chain.`,
				);
				return null;
			}
			return snapshot;
		} catch (error) {
			lastError = error;
			if (!isKeyError(error) || attempt === MAX_KEY_ATTEMPTS) break;

			const cooldownMs = markSubversiveKeyDisabled(key.apiKey);
			logger.warn(
				`Chain poll rejected key ending '...${key.apiKey.slice(-4)}' for faction ${factionId} (disabled for ${Math.round(cooldownMs / 1000)}s).`,
			);
		}
	}

	logFetchFailure(factionId, lastError);
	return null;
}

/**
 * One chain-monitor cycle.
 *
 * Every warning is derived from a snapshot fetched in this cycle. If Torn is
 * unreachable, rate-limiting, or returning a malformed payload, the faction's
 * warning cursor is left untouched and no ping is sent; the chain is not treated
 * as active for cadence purposes either, so a broken API cannot keep the worker
 * in a fast retry loop.
 */
export async function runChainMonitorCycle(): Promise<number> {
	const factionIds = [...SUBVERSIVE_FAMILY_FACTION_IDS];
	const configs = await resolveChainConfigs(factionIds);
	const ipcServer = getActiveIpcServer();
	let anyActive = false;

	for (const factionId of factionIds) {
		const config = configs.get(factionId);
		if (!config) continue;

		if (!config.enabled || !config.channelId) {
			monitorState.delete(factionId);
			continue;
		}

		const nowMs = Date.now();
		const snapshot = await fetchChainSnapshot(factionId, nowMs);

		if (!snapshot) {
			const previous = monitorState.get(factionId);
			if (previous) monitorState.set(factionId, { ...previous, active: false });
			continue;
		}

		const previous = monitorState.get(factionId);
		const decision = evaluateChainWarning(previous, snapshot, config, nowMs);

		if (decision.state.active) anyActive = true;

		if (!decision.send) {
			monitorState.set(factionId, decision.state);
			continue;
		}

		if (!ipcServer) {
			// Keep the previous warning cursor so the next cycle retries instead of
			// silently consuming the warning.
			monitorState.set(factionId, {
				...(previous ?? emptyState()),
				active: decision.state.active,
			});
			logger.warn(
				`Chain warning for faction ${factionId} was due but no IPC listener is connected; retrying next cycle.`,
			);
			continue;
		}

		const targets = await selectLowStatOkayTargets();
		ipcServer.broadcast({
			action: "subversive_chain_alert",
			data: {
				factionId,
				factionName: getSubversiveFactionName(factionId),
				channelId: config.channelId,
				warningRoleId: config.warningRoleId,
				chainCurrent: snapshot.current,
				chainMax: snapshot.max,
				timeoutSeconds: snapshot.timeoutSeconds,
				modifier: snapshot.modifier,
				warningNumber: decision.state.warningCount,
				targets,
			},
		});
		monitorState.set(factionId, decision.state);

		logger.info(
			`Queued chain warning #${decision.state.warningCount} for faction ${factionId} (${snapshot.current} links, ${snapshot.timeoutSeconds}s left, ${targets.length} target(s)).`,
		);
	}

	return (
		Date.now() +
		(anyActive ? ACTIVE_CADENCE_MS : idleCadenceMsFor(configs.values()))
	);
}

export function startSubversiveChainMonitor(
	options?: WorkerStartOptions,
): void {
	startEventDrivenRunner({
		worker: CHAIN_MONITOR_WORKER_NAME,
		defaultCadenceSeconds: MAX_IDLE_CADENCE_MS / 1000,
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			return runChainMonitorCycle();
		},
	});
}
