import { db, eq, systemStates } from "@sentinel/database";
import { getPersonalKey, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "personal:state_sync";
const STATE_ID = "personal:live_state";
const CADENCE_SEC = 300;

const logger = new Logger("Scheduler", "PersonalStateSync");

export type UserBars = {
	energy: {
		current: number;
		maximum: number;
		increment: number;
		interval: number;
		fullTime: number;
	};
	nerve: {
		current: number;
		maximum: number;
		increment: number;
		interval: number;
		fullTime: number;
	};
	happy: {
		current: number;
		maximum: number;
		increment: number;
		interval: number;
		fullTime: number;
	};
	life: {
		current: number;
		maximum: number;
		increment: number;
		interval: number;
		fullTime: number;
	};
};

export type UserCooldowns = {
	drug: number;
	medical: number;
	booster: number;
};

export type UserBattleStats = {
	strength: number;
	defense: number;
	speed: number;
	dexterity: number;
	total?: number;
};

export type PersonalLiveState = {
	bars: UserBars;
	cooldowns: UserCooldowns;
	money: Record<string, unknown>;
	battlestats: UserBattleStats;
	lastSyncDurationMs: number | null;
	updatedAt: string;
};

type TornUserCombinedResponse = {
	bars?: {
		energy?: {
			current?: number;
			maximum?: number;
			increment?: number;
			interval?: number;
			full_time?: number;
			fullTime?: number;
		};
		nerve?: {
			current?: number;
			maximum?: number;
			increment?: number;
			interval?: number;
			full_time?: number;
			fullTime?: number;
		};
		happy?: {
			current?: number;
			maximum?: number;
			increment?: number;
			interval?: number;
			full_time?: number;
			fullTime?: number;
		};
		life?: {
			current?: number;
			maximum?: number;
			increment?: number;
			interval?: number;
			full_time?: number;
			fullTime?: number;
		};
	};
	cooldowns?: {
		drug?: number;
		medical?: number;
		booster?: number;
	};
	money?: Record<string, unknown>;
	battlestats?: {
		strength?: number | { value?: number };
		defense?: number | { value?: number };
		speed?: number | { value?: number };
		dexterity?: number | { value?: number };
		total?: number;
	};
};

const DEFAULT_STATE: PersonalLiveState = {
	bars: {
		energy: { current: 0, maximum: 0, increment: 0, interval: 0, fullTime: 0 },
		nerve: { current: 0, maximum: 0, increment: 0, interval: 0, fullTime: 0 },
		happy: { current: 0, maximum: 0, increment: 0, interval: 0, fullTime: 0 },
		life: { current: 0, maximum: 0, increment: 0, interval: 0, fullTime: 0 },
	},
	cooldowns: {
		drug: 0,
		medical: 0,
		booster: 0,
	},
	money: {},
	battlestats: {
		strength: 0,
		defense: 0,
		speed: 0,
		dexterity: 0,
		total: 0,
	},
	lastSyncDurationMs: null,
	updatedAt: new Date().toISOString(),
};

let inMemoryState: PersonalLiveState = { ...DEFAULT_STATE };
let isStateLoaded = false;

/**
 * Loads the persistent live state from SQLite system_states.
 */
export async function loadPersonalLiveStateFromDb(): Promise<PersonalLiveState> {
	try {
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, STATE_ID),
		});

		if (record?.data && typeof record.data === "object") {
			inMemoryState = {
				...DEFAULT_STATE,
				...(record.data as Partial<PersonalLiveState>),
				updatedAt: new Date().toISOString(),
			};
		} else {
			inMemoryState = { ...DEFAULT_STATE };
		}
		isStateLoaded = true;
	} catch (error) {
		logger.error("Failed to load personal live state from database:", error);
		inMemoryState = { ...DEFAULT_STATE };
	}
	return inMemoryState;
}

/**
 * Returns the current in-memory personal live state.
 */
export function getPersonalLiveState(): PersonalLiveState {
	return { ...inMemoryState };
}

/**
 * Resets the in-memory personal live state to defaults (mainly for testing).
 */
export function resetPersonalLiveState(): void {
	inMemoryState = { ...DEFAULT_STATE, updatedAt: new Date().toISOString() };
	isStateLoaded = false;
}

/**
 * Fetches user bars, cooldowns, money, and battlestats in a single combined Torn API call,
 * normalizes the data, and commits the state atomically into SQLite system_states.
 */
export async function runPersonalStateSync(): Promise<void> {
	const finishSync = logger.time();
	const startTime = Date.now();

	try {
		if (!isStateLoaded) {
			await loadPersonalLiveStateFromDb();
		}

		const keyEntry = await getPersonalKey();
		if (!keyEntry) {
			logger.warn(
				"No personal API key found for personal state sync. Skipping.",
			);
			return;
		}

		const res = (await tornApi.getPersonal("/user", {
			queryParams: {
				selections: ["bars", "cooldowns", "money", "battlestats"],
			},
		})) as TornUserCombinedResponse;

		if (!res.bars || !res.cooldowns || !res.money) {
			throw new Error(
				"Incomplete response from Torn API: missing bars, cooldowns, or money.",
			);
		}

		const bars: UserBars = {
			energy: {
				current: Number(res.bars.energy?.current ?? 0),
				maximum: Number(res.bars.energy?.maximum ?? 0),
				increment: Number(res.bars.energy?.increment ?? 0),
				interval: Number(res.bars.energy?.interval ?? 0),
				fullTime: Number(
					res.bars.energy?.full_time ?? res.bars.energy?.fullTime ?? 0,
				),
			},
			nerve: {
				current: Number(res.bars.nerve?.current ?? 0),
				maximum: Number(res.bars.nerve?.maximum ?? 0),
				increment: Number(res.bars.nerve?.increment ?? 0),
				interval: Number(res.bars.nerve?.interval ?? 0),
				fullTime: Number(
					res.bars.nerve?.full_time ?? res.bars.nerve?.fullTime ?? 0,
				),
			},
			happy: {
				current: Number(res.bars.happy?.current ?? 0),
				maximum: Number(res.bars.happy?.maximum ?? 0),
				increment: Number(res.bars.happy?.increment ?? 0),
				interval: Number(res.bars.happy?.interval ?? 0),
				fullTime: Number(
					res.bars.happy?.full_time ?? res.bars.happy?.fullTime ?? 0,
				),
			},
			life: {
				current: Number(res.bars.life?.current ?? 0),
				maximum: Number(res.bars.life?.maximum ?? 0),
				increment: Number(res.bars.life?.increment ?? 0),
				interval: Number(res.bars.life?.interval ?? 0),
				fullTime: Number(
					res.bars.life?.full_time ?? res.bars.life?.fullTime ?? 0,
				),
			},
		};

		const cooldowns: UserCooldowns = {
			drug: Number(res.cooldowns.drug ?? 0),
			medical: Number(res.cooldowns.medical ?? 0),
			booster: Number(res.cooldowns.booster ?? 0),
		};

		const extractStat = (
			stat: number | { value?: number } | undefined,
		): number => {
			if (typeof stat === "number") return stat;
			if (stat && typeof stat === "object" && "value" in stat) {
				return Number(stat.value ?? 0);
			}
			return 0;
		};

		const battlestats: UserBattleStats = {
			strength: extractStat(res.battlestats?.strength),
			defense: extractStat(res.battlestats?.defense),
			speed: extractStat(res.battlestats?.speed),
			dexterity: extractStat(res.battlestats?.dexterity),
			total: Number(res.battlestats?.total ?? 0),
		};

		const elapsedMs = Date.now() - startTime;
		const now = new Date();

		inMemoryState = {
			bars,
			cooldowns,
			money: res.money,
			battlestats,
			lastSyncDurationMs: elapsedMs,
			updatedAt: now.toISOString(),
		};
		isStateLoaded = true;

		// Persist state atomically to SQLite system_states
		await db
			.insert(systemStates)
			.values({
				id: STATE_ID,
				init: true,
				data: inMemoryState,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					init: true,
					data: inMemoryState,
					updatedAt: now,
				},
			});
		finishSync();
	} catch (error) {
		logger.error("Failed to execute personal state sync:", error);
	}
}

/**
 * Initializes and registers the personal state sync background worker (5-minute cadence).
 */
export function startPersonalStateSync(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: CADENCE_SEC,
		initialDelayMs: options?.initialDelayMs,
		handler: runPersonalStateSync,
	});
}
