import {
	db,
	eq,
	isNull,
	systemStates,
	territoryStates,
	warLedgers,
} from "@sentinel/database";
import type {
	IpcTerritoryPayload,
	IpcWarPayload,
	TornSchema,
} from "@sentinel/schemas";
import { getActiveSystemKeyPool, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { trackFactions } from "../../lib/faction-tracker";
import { dispatchToBot } from "../../lib/ipc";
import { startEventDrivenRunner } from "../../lib/scheduler.js";
import type { WorkerStartOptions } from "../registry.js";

const WORKER_NAME = "torn:territory_activity";
const logger = new Logger("Scheduler", "TerritoryActivity");

let dbStatesCache: Map<string, CompactTerritoryState> | null = null;
let dbActiveWarsCache: Map<string, IpcWarPayload> | null = null;

/**
 * Memoised once-true initialisation flags.
 *
 * These are read every cycle purely to decide whether to wipe and rebuild on
 * first boot. Once a flag reads true it stays true for the process lifetime (the
 * schema-reset path requires a restart), so re-reading it on every ~1-5s cycle
 * was two permanent no-op queries. A false value is deliberately not cached, so
 * the very first cycle still performs its fresh sync.
 */
let warsInitialized = false;
let territoriesInitialized = false;

/**
 * Upper bound on territory-ownership pages (500 rows each). Narrowed at runtime
 * to the last page that actually returned rows.
 */
const MAX_OWNERSHIP_PAGES = 9;
let ownershipPageCount = MAX_OWNERSHIP_PAGES;
type CompactTerritoryState = {
	id: string;
	factionId: number | null;
	racket: ApiRacket | null;
	racketChangedAt: number | null;
	racketLevel: number | null;
	isWarring: boolean;
};

type ApiOwnership = TornSchema<"FactionTerritoryOwnership">;
type ApiRacket = TornSchema<"TornRacket"> & { territory?: string };
type ApiFactionRacketsResponse = { rackets?: ApiRacket[] };

type ApiTerritoryWarV1 = {
	territorywars?: Record<
		string,
		{
			territory_war_id: number;
			assaulting_faction: number;
			defending_faction: number;
			started: number;
			score: number;
			required_score: number;
			ended?: number;
		}
	>;
};

/**
 * Calculates safe polling cadence in seconds based on available system API key pool size.
 */
function calculateOptimalCadence(
	keyCount: number,
	requestsPerLoop: number,
): number {
	const maxRequestsPerMinute = Math.max(1, keyCount) * 30;
	const maxLoopsPerMinute = Math.floor(maxRequestsPerMinute / requestsPerLoop);
	return Number((60 / Math.max(1, maxLoopsPerMinute)).toFixed(2));
}

/**
 * Core state reconciliation engine for territory ownership, rackets, and warfare.
 */
export async function executeActivityEngine(): Promise<number> {
	const finishLog = logger.time();

	try {
		// Check system initialization state flags from SQLite. Skipped entirely
		// once both flags have been observed true, so the steady-state loop costs
		// zero queries for this.
		if (!warsInitialized || !territoriesInitialized) {
			if (!warsInitialized) {
				const warInitState = await db.query.systemStates.findFirst({
					where: eq(systemStates.id, "war_ledger_init_state"),
				});
				warsInitialized = Boolean(warInitState?.init);
			}
			if (!territoriesInitialized) {
				const stateInitState = await db.query.systemStates.findFirst({
					where: eq(systemStates.id, "tt_init_state"),
				});
				territoriesInitialized = Boolean(stateInitState?.init);
			}
		}

		const isWarsInit = warsInitialized;
		const isStatesInit = territoriesInitialized;

		if (!isWarsInit) {
			logger.info(
				"War Ledger not initialized. Clearing table for fresh sync...",
			);
			await db.delete(warLedgers);
			dbActiveWarsCache = null;
		}

		if (!isStatesInit) {
			logger.info(
				"Territory States not initialized. Clearing table for fresh sync...",
			);
			await db.delete(territoryStates);
			dbStatesCache = null;
		}

		const offsets = Array.from(
			{ length: ownershipPageCount },
			(_, i) => i * 500,
		);

		// Execute parallel fetches across endpoints using centralized system key pool.
		//
		// `allSettled` rather than `all`: with 11 concurrent requests a single
		// rate-limited or transiently failing endpoint used to reject the whole
		// batch and kill the cycle (observed in production as repeated Torn 119
		// failures followed by a backoff), taking the high-frequency territory
		// monitor down with it.
		//
		// Partial results are only safe because each phase below is gated on the
		// completeness of *its own* inputs. Treating a missing response as "empty"
		// would be far worse than failing: an absent wars payload looks like every
		// war ended (firing peace-treaty/success events), an absent rackets payload
		// looks like every racket despawned, and a missing ownership page looks
		// like territory was lost.
		const settled = await Promise.allSettled([
			tornApi.get("/faction/rackets") as Promise<ApiFactionRacketsResponse>,
			tornApi.getRaw<ApiTerritoryWarV1>("/torn", {
				queryParams: { selections: "territorywars" },
			}),
			...offsets.map(
				(offset) =>
					tornApi.get("/faction/territoryownership", {
						queryParams: { limit: 500, offset },
					}) as Promise<TornSchema<"FactionTerritoriesOwnershipResponse">>,
			),
		]);

		const [racketsSettled, warsSettled, ...ownershipSettled] = settled;
		const racketsRes =
			racketsSettled?.status === "fulfilled" ? racketsSettled.value : null;
		const warfareRes =
			warsSettled?.status === "fulfilled" ? warsSettled.value : null;
		const ownershipResPages = ownershipSettled.map((page) =>
			page.status === "fulfilled" ? page.value : null,
		);

		const isRacketsOk = racketsRes !== null;
		const isWarsOk = warfareRes !== null;
		const isOwnershipOk = ownershipResPages.every((page) => page !== null);

		if (!isRacketsOk && !isWarsOk && !isOwnershipOk) {
			// Nothing usable: surface it so the runner retries with backoff.
			const firstFailure = settled.find((s) => s.status === "rejected");
			throw firstFailure?.status === "rejected"
				? firstFailure.reason
				: new Error("All territory-activity upstream requests failed.");
		}

		if (!isOwnershipOk || !isWarsOk || !isRacketsOk) {
			const failed = [
				isRacketsOk ? null : "rackets",
				isWarsOk ? null : "territorywars",
				isOwnershipOk ? null : "territoryownership",
			]
				.filter(Boolean)
				.join(", ");
			logger.warn(
				`Partial territory cycle: ${failed} unavailable; skipping the affected reconciliation phases this cycle.`,
			);
		}

		// Shrink the page window to what actually returned data, so a deployment
		// whose territory count is below the hardcoded maximum stops fetching and
		// parsing empty tail pages every cycle. Self-correcting: if any requested
		// page comes back exactly full, the window is restored to the maximum so a
		// growing territory set is never truncated. Only narrowed on a fully
		// successful sweep, so a transient failure cannot shrink the window.
		if (isOwnershipOk) {
			let lastNonEmptyPage = 0;
			const maxPageIndex = ownershipResPages.length - 1;
			for (let p = 0; p < ownershipResPages.length; p++) {
				const pageList = ownershipResPages[p]?.territoryOwnership;
				if (pageList && pageList.length > 0) lastNonEmptyPage = p;
			}
			const lastPage = ownershipResPages[maxPageIndex]?.territoryOwnership;
			const lastPageWasFull = (lastPage?.length ?? 0) >= 500;
			ownershipPageCount = lastPageWasFull
				? MAX_OWNERSHIP_PAGES
				: Math.max(1, lastNonEmptyPage + 1);
		}

		const apiRackets = racketsRes?.rackets || [];
		const apiWarsMap = warfareRes?.territorywars || {};

		const apiRacketsMap = new Map<string, ApiRacket>();
		for (let i = 0; i < apiRackets.length; i++) {
			const r = apiRackets[i];
			if (r) {
				apiRacketsMap.set(r.territory || r.name, r);
			}
		}

		const apiOwnershipMap = new Map<string, ApiOwnership>();
		const factionIdsToTrack: number[] = [];

		for (let p = 0; p < ownershipResPages.length; p++) {
			const pageList = ownershipResPages[p]?.territoryOwnership;
			if (pageList) {
				for (let i = 0; i < pageList.length; i++) {
					const item = pageList[i];
					if (item) {
						apiOwnershipMap.set(item.id, item);
						const facId = item.owned_by;
						if (facId) {
							factionIdsToTrack.push(facId);
						}
					}
				}
			}
		}

		for (const w of Object.values(apiWarsMap)) {
			if (w.assaulting_faction) {
				factionIdsToTrack.push(w.assaulting_faction);
			}
			if (w.defending_faction) {
				factionIdsToTrack.push(w.defending_faction);
			}
		}

		if (factionIdsToTrack.length > 0) {
			trackFactions(factionIdsToTrack).catch((err: unknown) => {
				logger.error("Background faction tracking error:", err);
			});
		}

		// Query active database records if not cached
		if (!dbStatesCache) {
			const dbStatesList = await db.query.territoryStates.findMany();
			dbStatesCache = new Map(
				dbStatesList.map((s) => {
					const racket = s.racket as unknown as ApiRacket | null;
					return [
						s.id,
						{
							id: s.id,
							factionId: s.factionId,
							racket: racket,
							racketChangedAt: racket?.changed_at ?? null,
							racketLevel: racket?.level ?? null,
							isWarring: s.isWarring,
						},
					];
				}),
			);
		}
		const dbStates = dbStatesCache;

		if (!dbActiveWarsCache) {
			const dbActiveWarsList = await db.query.warLedgers.findMany({
				where: isNull(warLedgers.endTime),
			});
			dbActiveWarsCache = new Map(
				dbActiveWarsList.map((w) => [
					w.tt,
					{
						id: w.id,
						tt: w.tt,
						assaultingFaction: w.assaultingFaction,
						defendingFaction: w.defendingFaction,
						victorFaction: w.victorFaction,
						startTime: w.startTime,
						endTime: w.endTime,
					},
				]),
			);
		}
		const dbActiveWars = dbActiveWarsCache;

		const warUpserts: IpcWarPayload[] = [];
		const stateUpserts: IpcTerritoryPayload[] = [];

		// ==========================================
		// PHASE 1: WAR RESOLUTION
		// ==========================================
		//
		// Runs only with a complete wars payload: an empty/partial map would make
		// every tracked war look ended, emitting false peace-treaty and
		// assault-success/fail events. When the wars fetch failed we leave the
		// existing war ledger untouched and resolve it on the next cycle.
		const activeApiWarIds = new Set(Object.keys(apiWarsMap));
		const now = Date.now();

		if (isWarsOk) {
			// Resolve ENDED Wars
			for (const [tt, dbWar] of dbActiveWars) {
				if (!activeApiWarIds.has(tt)) {
					const currentOwner = apiOwnershipMap.get(tt)?.owned_by;

					const startTimeMs =
						dbWar.startTime instanceof Date
							? dbWar.startTime.getTime()
							: Number(dbWar.startTime);

					const updatedWar: IpcWarPayload = {
						id: dbWar.id,
						tt: dbWar.tt,
						assaultingFaction: dbWar.assaultingFaction,
						defendingFaction: dbWar.defendingFaction,
						victorFaction: currentOwner ?? null,
						startTime: dbWar.startTime,
						endTime: new Date(now),
					};

					warUpserts.push(updatedWar);

					const isTruce =
						now - startTimeMs < 72 * 3600000 &&
						currentOwner === dbWar.defendingFaction;

					if (isTruce) {
						dispatchToBot({ action: "peace_treaty", data: updatedWar });
					} else if (currentOwner === dbWar.assaultingFaction) {
						if (isWarsInit)
							dispatchToBot({ action: "assault_succeed", data: updatedWar });
					} else {
						if (isWarsInit)
							dispatchToBot({ action: "assault_fail", data: updatedWar });
					}
				}
			}

			// Register NEW Wars
			for (const [tt, war] of Object.entries(apiWarsMap)) {
				if (!dbActiveWars.has(tt)) {
					const data: IpcWarPayload = {
						id: war.territory_war_id.toString(),
						tt,
						assaultingFaction: war.assaulting_faction,
						defendingFaction: war.defending_faction,
						victorFaction: null,
						startTime: new Date(war.started * 1000),
						endTime: null,
					};

					warUpserts.push(data);
					if (isWarsInit) dispatchToBot({ action: "assault_start", data });
				}
			}
		}

		// ==========================================
		// PHASE 2: OWNERSHIP & RACKETS
		// ==========================================
		//
		// Gated on a fully successful ownership sweep (and a usable rackets
		// payload for the racket half). Missing pages would look like lost
		// territory and emit a burst of false tt_drop/racket_despawn events, so a
		// partial sweep is skipped entirely rather than applied.
		const activeWarTerritories = new Set(Object.keys(apiWarsMap));

		if (isOwnershipOk) {
			for (const [ttId, tt] of apiOwnershipMap) {
				const oldState = dbStates.get(ttId);
				const newFaction = tt.owned_by ?? null;
				const racket = apiRacketsMap.get(ttId) ?? null;
				const isWarring = activeWarTerritories.has(ttId);

				const newState: IpcTerritoryPayload = {
					id: ttId,
					factionId: newFaction,
					racket: racket,
					isWarring,
				};

				let hasChanged = !oldState;

				if (oldState) {
					if (oldState.factionId !== newState.factionId) {
						hasChanged = true;
						if (!isWarring) {
							if (oldState.factionId && isStatesInit) {
								dispatchToBot({
									action: "tt_drop",
									data: {
										id: oldState.id,
										factionId: oldState.factionId,
										racket: null,
										isWarring: oldState.isWarring,
									},
								});
							}
							if (newState.factionId && isStatesInit) {
								dispatchToBot({ action: "tt_claim", data: newState });
							}
						}
					}

					const oldRacketChangedAt = oldState.racketChangedAt;
					const newRacketChangedAt = racket?.changed_at ?? null;

					if (oldRacketChangedAt !== newRacketChangedAt) {
						hasChanged = true;

						const oldRacketLevel = oldState.racketLevel;
						const newRacketLevel = racket?.level ?? null;

						if (
							oldRacketLevel === null &&
							newRacketLevel !== null &&
							isStatesInit
						) {
							dispatchToBot({ action: "racket_spawn", data: newState });
						} else if (
							oldRacketLevel !== null &&
							newRacketLevel === null &&
							isStatesInit
						) {
							dispatchToBot({
								action: "racket_despawn",
								data: {
									id: oldState.id,
									factionId: oldState.factionId,
									racket: oldState.racket,
									isWarring: oldState.isWarring,
								},
							});
						} else if (oldRacketLevel !== null && newRacketLevel !== null) {
							if (oldRacketLevel > newRacketLevel && isStatesInit) {
								dispatchToBot({ action: "racket_level_down", data: newState });
							} else if (oldRacketLevel < newRacketLevel && isStatesInit) {
								dispatchToBot({ action: "racket_level_up", data: newState });
							}
						}
					}

					if (oldState.isWarring !== newState.isWarring) {
						hasChanged = true;
					}
				}

				if (hasChanged) {
					stateUpserts.push(newState);
				}
			}
		}

		// Persist changes to SQLite using Drizzle transactions
		if (stateUpserts.length > 0) {
			const chunkSize = 50;
			for (let i = 0; i < stateUpserts.length; i += chunkSize) {
				const chunk = stateUpserts.slice(i, i + chunkSize);
				await db.transaction(async (tx) => {
					for (const item of chunk) {
						const nowDb = new Date();
						await tx
							.insert(territoryStates)
							.values({
								id: item.id,
								factionId: item.factionId,
								racket: item.racket,
								isWarring: item.isWarring,
								createdAt: nowDb,
								updatedAt: nowDb,
							})
							.onConflictDoUpdate({
								target: territoryStates.id,
								set: {
									factionId: item.factionId,
									racket: item.racket,
									isWarring: item.isWarring,
									updatedAt: nowDb,
								},
							});
					}
				});
				for (const item of chunk) {
					const itemRacket = item.racket as unknown as ApiRacket | null;
					dbStatesCache?.set(item.id, {
						id: item.id,
						factionId: item.factionId,
						racket: itemRacket,
						racketChangedAt: itemRacket?.changed_at ?? null,
						racketLevel: itemRacket?.level ?? null,
						isWarring: item.isWarring,
					});
				}
			}
		}

		if (warUpserts.length > 0) {
			const chunkSize = 50;
			for (let i = 0; i < warUpserts.length; i += chunkSize) {
				const chunk = warUpserts.slice(i, i + chunkSize);
				await db.transaction(async (tx) => {
					for (const item of chunk) {
						const nowDb = new Date();
						const startTimeDate =
							item.startTime instanceof Date
								? item.startTime
								: new Date(item.startTime);
						const endTimeDate = item.endTime
							? item.endTime instanceof Date
								? item.endTime
								: new Date(item.endTime)
							: null;

						await tx
							.insert(warLedgers)
							.values({
								id: item.id,
								tt: item.tt,
								assaultingFaction: item.assaultingFaction,
								defendingFaction: item.defendingFaction,
								victorFaction: item.victorFaction,
								startTime: startTimeDate,
								endTime: endTimeDate,
								createdAt: nowDb,
								updatedAt: nowDb,
							})
							.onConflictDoUpdate({
								target: warLedgers.id,
								set: {
									tt: item.tt,
									assaultingFaction: item.assaultingFaction,
									defendingFaction: item.defendingFaction,
									victorFaction: item.victorFaction,
									startTime: startTimeDate,
									endTime: endTimeDate,
									updatedAt: nowDb,
								},
							});
					}
				});

				for (const item of chunk) {
					if (item.endTime) {
						dbActiveWarsCache?.delete(item.tt);
					} else {
						dbActiveWarsCache?.set(item.tt, {
							id: item.id,
							tt: item.tt,
							assaultingFaction: item.assaultingFaction,
							defendingFaction: item.defendingFaction,
							victorFaction: item.victorFaction,
							startTime: item.startTime,
							endTime: item.endTime,
						});
					}
				}
			}
		}

		// Update system initialization flags
		if (!isWarsInit) {
			const nowDb = new Date();
			await db
				.insert(systemStates)
				.values({
					id: "war_ledger_init_state",
					init: true,
					createdAt: nowDb,
					updatedAt: nowDb,
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: { init: true, updatedAt: nowDb },
				});
		}

		if (!isStatesInit) {
			const nowDb = new Date();
			await db
				.insert(systemStates)
				.values({
					id: "tt_init_state",
					init: true,
					createdAt: nowDb,
					updatedAt: nowDb,
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: { init: true, updatedAt: nowDb },
				});
		}

		finishLog();

		const totalRequestsPerLoop = 11;
		const availableKeys = (await getActiveSystemKeyPool()).length;
		const nextCadence = calculateOptimalCadence(
			availableKeys,
			totalRequestsPerLoop,
		);
		logger.info(
			`Optimal cadence calculated: ${nextCadence}s (${availableKeys} key(s), ${totalRequestsPerLoop} reqs/loop). Next run in ${nextCadence}s.`,
		);
		return Date.now() + nextCadence * 1000;
	} catch (error) {
		logger.error("Failed to execute territory activity engine:", error);
		dbStatesCache = null;
		dbActiveWarsCache = null;
		throw error;
	}
}

/**
 * Initializes and boots the territory activity sync worker.
 */
export function startTornTerritoryActivity(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: 15,
		initialDelayMs: options?.initialDelayMs,
		handler: executeActivityEngine,
	});
}
