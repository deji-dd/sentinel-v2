import { db, systemStates } from "@sentinel/database";
import type {
	Bounty,
	TornBountiesResponse,
	UserProfileResponse,
} from "@sentinel/schemas";
import {
	getPersonalKey,
	getPlayerStats,
	tornApi,
	UserRateLimiter,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { getActiveIpcServer } from "../../lib/ipc";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const logger = new Logger("Scheduler", "PersonalBountyFinder");

export const WORKER_NAME = "personal:bounty_finder";
export const BOUNTY_STATE_ID = "personal:bounties";
const CADENCE_SEC = 30;

// Hardcoded thresholds
const MIN_BOUNTY_PREFILTER = 100_000;
const MAX_FF_THRESHOLD = 4.0;
const MIN_ACCOUNT_AGE_DAYS = 14;
const MAX_PROFILES_PER_CYCLE = 20; // Budgeted within 50/min rate limit (20 req / 30s)
const MAX_BOUNTY_PAGES = 3; // Fetches up to 300 bounties per cycle (3 pages * 100)

export interface PersonalBountyTarget {
	id: number;
	name: string;
	level: number;
	reward: number; // Highest single qualifying bounty reward
	fairFight: number | null; // null if unscouted
	estimatedBs: number | null;
	age: number; // Age in days (>= 14)
	status: {
		state: string; // "Okay", "Hospital", "Abroad", etc.
		description?: string;
		until?: number | null;
	};
	attackUrl: string;
	lastCheckedAt: number;
}

export interface PersonalBountyState {
	readyTargets: PersonalBountyTarget[];
	hospitalQueue: Array<PersonalBountyTarget & { secondsRemaining: number }>;
	lastSyncTimestamp: number;
	targetCount: number;
	pendingCount?: number;
}

// In-memory permanent age cache (once verified >= 14d, never checked again)
const verifiedAgeCache = new Map<number, number>();

// In-memory profile & status cache
interface CachedProfile {
	age: number;
	level: number;
	statusState: string;
	statusDescription?: string;
	statusUntil?: number | null;
	lastCheckedAt: number;
}
const targetProfileCache = new Map<number, CachedProfile>();

// Rate limiter for profile checks enforcing 50 requests/min
const personalRateLimiter = new UserRateLimiter(50, 60_000);

// In-memory latest state snapshot
let inMemoryBountyState: PersonalBountyState = {
	readyTargets: [],
	hospitalQueue: [],
	lastSyncTimestamp: 0,
	targetCount: 0,
};

let lastCycleCompletedAt = 0;
export const MIN_CYCLE_COOLDOWN_SEC = 15;

export function resetBountyFinderCooldown(): void {
	lastCycleCompletedAt = 0;
}

/**
 * Core execution cycle for Personal Bounty Target Finder.
 */
export async function runBountyFinderCycle(
	signalOrForce?: AbortSignal | boolean,
): Promise<void> {
	const force = typeof signalOrForce === "boolean" ? signalOrForce : false;
	const personalKey = await getPersonalKey();
	if (!personalKey?.apiKey) {
		logger.warn("No personal API key configured. Skipping bounty cycle.");
		return;
	}

	const now = new Date();
	const nowSec = Math.floor(now.getTime() / 1000);

	if (!force && nowSec - lastCycleCompletedAt < MIN_CYCLE_COOLDOWN_SEC) {
		logger.info(
			`Skipping bounty cycle: last cycle completed ${nowSec - lastCycleCompletedAt}s ago (cooling down for next scheduled tick).`,
		);
		return;
	}

	try {
		// 1. Fetch live bounties from Torn API with pagination (up to MAX_BOUNTY_PAGES = 300 bounties)
		const rawBounties: Bounty[] = [];
		let offset = 0;

		for (let page = 0; page < MAX_BOUNTY_PAGES; page++) {
			await personalRateLimiter.waitIfNeeded(personalKey.userId);
			const bountiesRes = (await tornApi.getPersonal("/torn/bounties", {
				queryParams: { limit: 100, offset },
			})) as TornBountiesResponse;

			const pageBounties = bountiesRes.bounties ?? [];
			rawBounties.push(...pageBounties);

			const total = bountiesRes._metadata?.total ?? 0;
			const hasNext = Boolean(bountiesRes._metadata?.links?.next);
			offset += pageBounties.length;

			// Stop if page is partial, no next link, or all bounties fetched
			if (pageBounties.length < 100 || !hasNext || offset >= total) {
				break;
			}
		}

		if (rawBounties.length === 0) {
			logger.info("No active bounties returned from Torn API.");
			return;
		}

		// 2. Pre-filter & aggregate by target ID: keep highest single bounty >= MIN_BOUNTY_PREFILTER
		const targetAggregates = new Map<
			number,
			{
				id: number;
				name: string;
				level: number;
				maxReward: number;
			}
		>();

		for (const bounty of rawBounties) {
			if (bounty.reward < MIN_BOUNTY_PREFILTER) {
				continue;
			}

			const existing = targetAggregates.get(bounty.target_id);
			if (!existing) {
				targetAggregates.set(bounty.target_id, {
					id: bounty.target_id,
					name: bounty.target_name,
					level: bounty.target_level,
					maxReward: bounty.reward,
				});
			} else if (bounty.reward > existing.maxReward) {
				existing.maxReward = bounty.reward;
			}
		}

		if (targetAggregates.size === 0) {
			logger.info("No bounties met the minimum reward pre-filter ($100k).");
			return;
		}

		// 3. Batch FFScouter lookup (0 Torn API requests)
		// Uses the fixed FFScouter API key from environment
		const candidateIds = Array.from(targetAggregates.keys());
		let scouts: Awaited<ReturnType<typeof getPlayerStats>> = [];
		try {
			scouts = await getPlayerStats(candidateIds);
		} catch (err) {
			logger.warn(
				"FFScouter lookup encountered error, proceeding with fallback:",
				err,
			);
		}

		const scoutMap = new Map<number, (typeof scouts)[number]>();
		for (const scout of scouts) {
			scoutMap.set(scout.player_id, scout);
		}

		// 4. Filter by Fair Fight and Unscouted Policy (0 Torn API calls)
		// - Scouted with FF <= 3.0: Keep
		// - Scouted with FF > 3.0: Discard
		// - Unscouted with Level <= 15: Keep (FF = null)
		// - Unscouted with Level > 15: Discard
		interface QualifiedCandidate {
			id: number;
			name: string;
			level: number;
			maxReward: number;
			fairFight: number | null;
			estimatedBs: number | null;
		}

		const qualifiedCandidates: QualifiedCandidate[] = [];

		for (const candidate of targetAggregates.values()) {
			const scout = scoutMap.get(candidate.id);

			if (scout) {
				const ff = scout.fair_fight;

				if (ff !== null && ff !== undefined) {
					if (ff > MAX_FF_THRESHOLD) {
						// Discard target who is too strong (FF > 3.0)
						continue;
					}

					qualifiedCandidates.push({
						...candidate,
						fairFight: Number(ff.toFixed(2)),
						estimatedBs: scout.bs_estimate,
					});
					continue;
				}

				// If scout exists but fair_fight is null, check level
				if (candidate.level > 15) {
					continue;
				}

				qualifiedCandidates.push({
					...candidate,
					fairFight: null,
					estimatedBs: scout.bs_estimate,
				});
			} else {
				// No scout available
				if (candidate.level > 15) {
					// Discard unscouted high-level target
					continue;
				}

				// Allow unscouted low-level target
				qualifiedCandidates.push({
					...candidate,
					fairFight: null,
					estimatedBs: null,
				});
			}
		}

		// 5. Age check from permanent cache
		// If known to be < 14 days old, discard
		const candidatesNeedingProfile = qualifiedCandidates.filter((c) => {
			const knownAge = verifiedAgeCache.get(c.id);
			if (knownAge !== undefined && knownAge < MIN_ACCOUNT_AGE_DAYS) {
				return false;
			}
			return true;
		});

		// 6. Build the in-memory inspection priority queue
		// Prioritization strategy across cycles:
		// Priority 1: Expired Hospital (statusState === "Hospital" && statusUntil <= nowSec) -> Catch exit immediately!
		// Priority 2: Unprofiled candidates (!cached) -> Discover new targets, prioritized by highest reward!
		// Priority 3: Stale "Okay" targets (statusState === "Okay" && nowSec - lastCheckedAt >= 60) -> Re-verify
		// Priority 4: Stale other statuses ("Abroad", "Traveling", etc. && nowSec - lastCheckedAt >= 120)
		// Targets still in hospital (until > nowSec) or freshly verified Okay (< 60s) skip inspection to conserve API quota.
		interface PrioritizedCandidate {
			candidate: QualifiedCandidate;
			priorityTier: number;
			staleness: number;
		}

		const profilingQueue: PrioritizedCandidate[] = [];

		for (const candidate of candidatesNeedingProfile) {
			const cached = targetProfileCache.get(candidate.id);
			if (!cached) {
				// Unprofiled candidate: Priority 2
				profilingQueue.push({
					candidate,
					priorityTier: 2,
					staleness: 999_999,
				});
				continue;
			}

			const stateLower = (cached.statusState || "").toLowerCase();
			if (stateLower === "hospital") {
				const until = cached.statusUntil ?? 0;
				if (until <= nowSec) {
					// Hospital stay expired: Priority 1 (Most urgent to attack upon exit!)
					profilingQueue.push({
						candidate,
						priorityTier: 1,
						staleness: nowSec - cached.lastCheckedAt,
					});
				}
				// If until > nowSec, target is still in hospital; no inspection call wasted.
			} else if (stateLower === "okay") {
				if (nowSec - cached.lastCheckedAt >= 60) {
					// Stale Okay: Priority 3
					profilingQueue.push({
						candidate,
						priorityTier: 3,
						staleness: nowSec - cached.lastCheckedAt,
					});
				}
			} else {
				if (nowSec - cached.lastCheckedAt >= 120) {
					// Stale other state (abroad/traveling): Priority 4
					profilingQueue.push({
						candidate,
						priorityTier: 4,
						staleness: nowSec - cached.lastCheckedAt,
					});
				}
			}
		}

		// Sort the profiling queue:
		// 1. By priority tier asc (1 = expired hospital, 2 = unprofiled, 3 = stale okay, 4 = stale other)
		// 2. Within Priority 1 & 2: By candidate reward desc (inspect highest-paying targets first)
		// 3. Within Priority 3 & 4: By staleness desc (oldest first), then reward desc
		profilingQueue.sort((a, b) => {
			if (a.priorityTier !== b.priorityTier) {
				return a.priorityTier - b.priorityTier;
			}
			if (a.priorityTier === 1 || a.priorityTier === 2) {
				return b.candidate.maxReward - a.candidate.maxReward;
			}
			if (Math.abs(a.staleness - b.staleness) > 30) {
				return b.staleness - a.staleness;
			}
			return b.candidate.maxReward - a.candidate.maxReward;
		});

		// 7. Profile queries throttled to safe budget (MAX_PROFILES_PER_CYCLE = 20)
		let profilesChecked = 0;
		for (const item of profilingQueue) {
			if (profilesChecked >= MAX_PROFILES_PER_CYCLE) {
				break;
			}

			const candidate = item.candidate;
			try {
				await personalRateLimiter.waitIfNeeded(personalKey.userId);
				const profileRes = (await tornApi.getPersonal("/user/{id}/profile", {
					pathParams: { id: candidate.id },
				})) as UserProfileResponse;

				const profile = profileRes.profile;
				if (profile) {
					verifiedAgeCache.set(candidate.id, profile.age);
					if (profile.age >= MIN_ACCOUNT_AGE_DAYS) {
						targetProfileCache.set(candidate.id, {
							age: profile.age,
							level: profile.level,
							statusState: profile.status.state,
							statusDescription: profile.status.description,
							statusUntil: profile.status.until,
							lastCheckedAt: nowSec,
						});
					}
				}
				profilesChecked++;
			} catch (err) {
				logger.warn(
					`Failed to fetch profile for candidate ${candidate.id}:`,
					err,
				);
			}
		}

		// 8. Assemble Ready Targets and Hospital Queue
		// STRICT REQUIREMENT: Only candidates whose profiles have been verified AND status is strictly "Okay"
		// are added to readyTargets. Unchecked/unprofiled candidates remain in the inspection queue.
		const readyTargets: PersonalBountyTarget[] = [];
		const hospitalQueue: Array<
			PersonalBountyTarget & { secondsRemaining: number }
		> = [];
		let unprofiledCount = 0;

		for (const candidate of candidatesNeedingProfile) {
			const knownAge = verifiedAgeCache.get(candidate.id);
			if (knownAge !== undefined && knownAge < MIN_ACCOUNT_AGE_DAYS) {
				continue;
			}

			const profile = targetProfileCache.get(candidate.id);
			if (!profile) {
				// Candidate has not been inspected yet — DO NOT list as ready
				unprofiledCount++;
				continue;
			}

			if (profile.age < MIN_ACCOUNT_AGE_DAYS) {
				continue;
			}

			const targetObj: PersonalBountyTarget = {
				id: candidate.id,
				name: candidate.name,
				level: profile.level,
				reward: candidate.maxReward,
				fairFight: candidate.fairFight,
				estimatedBs: candidate.estimatedBs,
				age: profile.age,
				status: {
					state: profile.statusState,
					description: profile.statusDescription,
					until: profile.statusUntil,
				},
				attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${candidate.id}`,
				lastCheckedAt: profile.lastCheckedAt,
			};

			const stateLower = (profile.statusState || "").toLowerCase();
			if (stateLower === "hospital") {
				const until = profile.statusUntil ?? nowSec;
				const remaining = Math.max(0, until - nowSec);
				hospitalQueue.push({
					...targetObj,
					secondsRemaining: remaining,
				});
			} else if (stateLower === "okay") {
				readyTargets.push(targetObj);
			}
		}

		// Sort ready targets by highest reward desc
		readyTargets.sort((a, b) => b.reward - a.reward);

		// Sort hospital queue by shortest time remaining asc (so targets exiting soonest are at top)
		hospitalQueue.sort((a, b) => a.secondsRemaining - b.secondsRemaining);

		inMemoryBountyState = {
			readyTargets,
			hospitalQueue,
			lastSyncTimestamp: nowSec,
			targetCount: readyTargets.length + hospitalQueue.length,
			pendingCount: unprofiledCount,
		};

		// Prune cached profiles older than 1 hour if cache grows large
		if (targetProfileCache.size > 500) {
			for (const [id, cached] of targetProfileCache.entries()) {
				if (nowSec - cached.lastCheckedAt > 3600) {
					targetProfileCache.delete(id);
				}
			}
		}

		// 9. Persist atomically to system_states
		try {
			await db
				.insert(systemStates)
				.values({
					id: BOUNTY_STATE_ID,
					init: true,
					data: inMemoryBountyState,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						init: true,
						data: inMemoryBountyState,
						updatedAt: now,
					},
				});
		} catch (dbErr) {
			logger.warn("Could not persist bounty state to database:", dbErr);
		}

		// 10. Broadcast update via IPC
		const ipcServer = getActiveIpcServer();
		if (ipcServer) {
			ipcServer.broadcast({
				action: "personal_bounties_updated",
				data: inMemoryBountyState,
			});
		}

		logger.info(
			`Bounty cycle completed: ${readyTargets.length} ready, ${hospitalQueue.length} in hospital, ${unprofiledCount} pending inspection. (${profilesChecked} profile calls).`,
		);
	} catch (error) {
		logger.error("Error executing bounty finder cycle:", error);
		throw error;
	} finally {
		lastCycleCompletedAt = Math.floor(Date.now() / 1000);
	}
}

/**
 * On-demand target recheck for instant accuracy before hitting.
 */
export async function recheckBountyTarget(
	targetId: number,
): Promise<PersonalBountyTarget | null> {
	const personalKey = await getPersonalKey();
	if (!personalKey?.apiKey) return null;

	const nowSec = Math.floor(Date.now() / 1000);
	try {
		await personalRateLimiter.waitIfNeeded(personalKey.userId);
		const profileRes = (await tornApi.getPersonal("/user/{id}/profile", {
			pathParams: { id: targetId },
		})) as UserProfileResponse;

		const profile = profileRes.profile;
		if (!profile) return null;

		verifiedAgeCache.set(targetId, profile.age);
		targetProfileCache.set(targetId, {
			age: profile.age,
			level: profile.level,
			statusState: profile.status.state,
			statusDescription: profile.status.description,
			statusUntil: profile.status.until,
			lastCheckedAt: nowSec,
		});

		// Find candidate in in-memory state or construct updated target
		const existing =
			inMemoryBountyState.readyTargets.find((t) => t.id === targetId) ??
			inMemoryBountyState.hospitalQueue.find((t) => t.id === targetId);

		const updatedTarget: PersonalBountyTarget = {
			id: targetId,
			name: profile.name,
			level: profile.level,
			reward: existing?.reward ?? 0,
			fairFight: existing?.fairFight ?? null,
			estimatedBs: existing?.estimatedBs ?? null,
			age: profile.age,
			status: {
				state: profile.status.state,
				description: profile.status.description,
				until: profile.status.until,
			},
			attackUrl: `https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`,
			lastCheckedAt: nowSec,
		};

		return updatedTarget;
	} catch (err) {
		logger.error(`Failed to recheck target ${targetId}:`, err);
		return null;
	}
}

/**
 * Instantly records a target defeat from the client-side userscript (hospitalized, mugged, left),
 * moving the target out of readyTargets and into hospitalQueue without waiting for the next cron cycle.
 */
export function recordTargetDefeated(targetId: number, outcome?: string): void {
	const nowSec = Math.floor(Date.now() / 1000);
	const defaultHospitalDuration = 1800; // 30 mins estimated hospital timer

	targetProfileCache.set(targetId, {
		age: verifiedAgeCache.get(targetId) ?? 100,
		level: 1,
		statusState: "Hospital",
		statusDescription: outcome ?? "Hospitalized in combat",
		statusUntil: nowSec + defaultHospitalDuration,
		lastCheckedAt: nowSec,
	});

	const readyIdx = inMemoryBountyState.readyTargets.findIndex(
		(t) => t.id === targetId,
	);
	if (readyIdx !== -1) {
		const [removed] = inMemoryBountyState.readyTargets.splice(readyIdx, 1);
		if (removed) {
			const existingHospIdx = inMemoryBountyState.hospitalQueue.findIndex(
				(t) => t.id === targetId,
			);
			const hospItem = {
				...removed,
				status: {
					state: "Hospital",
					description: outcome ?? "Hospitalized in combat",
					until: nowSec + defaultHospitalDuration,
				},
				secondsRemaining: defaultHospitalDuration,
				lastCheckedAt: nowSec,
			};

			if (existingHospIdx !== -1) {
				inMemoryBountyState.hospitalQueue[existingHospIdx] = hospItem;
			} else {
				inMemoryBountyState.hospitalQueue.push(hospItem);
			}

			inMemoryBountyState.hospitalQueue.sort(
				(a, b) => a.secondsRemaining - b.secondsRemaining,
			);
			inMemoryBountyState.lastSyncTimestamp = nowSec;
			inMemoryBountyState.targetCount =
				inMemoryBountyState.readyTargets.length +
				inMemoryBountyState.hospitalQueue.length;
		}
	}

	logger.info(
		`Target ${targetId} recorded as defeated (${outcome ?? "Hospital"}). Moved out of readyTargets.`,
	);

	const ipcServer = getActiveIpcServer();
	if (ipcServer) {
		ipcServer.broadcast({
			action: "personal_bounties_updated",
			data: inMemoryBountyState,
		});
	}
}

/**
 * Initializes and registers the personal bounty target finder background worker.
 */
export function startPersonalBountyFinder(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: {
			type: "cron",
			pattern: "1,31 * * * * *", // Ticks at :01 and :31 UTC (1s buffer after Torn's 30s cache flips)
			timezone: "Etc/UTC",
		},
		defaultCadenceSeconds: CADENCE_SEC,
		timeoutMs: 25_000,
		initialDelayMs: options?.initialDelayMs,
		retryPolicy: {
			maxRetries: 3,
			initialBackoffMs: 5_000,
			maxBackoffMs: 30_000,
		},
		handler: runBountyFinderCycle,
	});
}

export function getInMemoryBountyState(): PersonalBountyState {
	return inMemoryBountyState;
}
