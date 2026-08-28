import {
	db,
	eq,
	personalLogs,
	sql,
	systemStates,
	tornGyms,
} from "@sentinel/database";
import { getPersonalKey, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { schedulerEvents } from "../../lib/events";
import {
	getNextUtcTargetTimestamp,
	startEventDrivenRunner,
} from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "personal:reference_sync";
const PERKS_STATE_ID = "personal:user_perks";
const GYM_UNLOCKS_STATE_ID = "personal:gym_unlocks";
const LOG_MANAGER_STATE_ID = "personal:log_manager";

const logger = new Logger("Scheduler", "PersonalReferenceSync");

export type GymPerkModifiers = {
	strength: number;
	speed: number;
	defense: number;
	dexterity: number;
};

export type BoosterPerkModifiers = {
	energyDrink: number;
};

export type TravelPerkModifiers = {
	hasAirstrip: boolean;
	hasWltBenefit: boolean;
	hasBookPerk: boolean;
	factionTravelReduction: number;
	totalTravelReduction: number;
};

export type DestinationTravelData = {
	id: number;
	countryCode: string;
	name: string;
	cityName: string;
	standardCost: number;
	standardSeconds: number;
};

export type UserPerksData = {
	allPerks: string[];
	categorizedPerks: Record<string, string[]>;
	travelPerks: TravelPerkModifiers;
	timestamp: number;
};

export type GymUnlocksData = {
	strengthGym: number;
	defenseGym: number;
	speedGym: number;
	dexterityGym: number;
	unlockedGymIds: number[];
	timestamp: number;
};

export const DESTINATION_TRAVEL_INFO: Record<number, DestinationTravelData> = {
	1: {
		id: 1,
		countryCode: "mex",
		name: "Mexico",
		cityName: "Ciudad Juárez",
		standardCost: 6500,
		standardSeconds: 1440,
	},
	2: {
		id: 2,
		countryCode: "cay",
		name: "Cayman Islands",
		cityName: "George Town",
		standardCost: 10000,
		standardSeconds: 1980,
	},
	3: {
		id: 3,
		countryCode: "can",
		name: "Canada",
		cityName: "Toronto",
		standardCost: 9000,
		standardSeconds: 2340,
	},
	4: {
		id: 4,
		countryCode: "haw",
		name: "Hawaii",
		cityName: "Honolulu",
		standardCost: 11000,
		standardSeconds: 7620,
	},
	5: {
		id: 5,
		countryCode: "uk",
		name: "United Kingdom",
		cityName: "London",
		standardCost: 18000,
		standardSeconds: 9060,
	},
	6: {
		id: 6,
		countryCode: "arg",
		name: "Argentina",
		cityName: "Buenos Aires",
		standardCost: 21000,
		standardSeconds: 9480,
	},
	7: {
		id: 7,
		countryCode: "swi",
		name: "Switzerland",
		cityName: "Zurich",
		standardCost: 27000,
		standardSeconds: 9960,
	},
	8: {
		id: 8,
		countryCode: "jap",
		name: "Japan",
		cityName: "Tokyo",
		standardCost: 32000,
		standardSeconds: 12780,
	},
	9: {
		id: 9,
		countryCode: "chi",
		name: "China",
		cityName: "Beijing",
		standardCost: 35000,
		standardSeconds: 13740,
	},
	10: {
		id: 10,
		countryCode: "uae",
		name: "UAE",
		cityName: "Dubai",
		standardCost: 32000,
		standardSeconds: 15420,
	},
	11: {
		id: 11,
		countryCode: "saf",
		name: "South Africa",
		cityName: "Johannesburg",
		standardCost: 40000,
		standardSeconds: 16920,
	},
};

/**
 * Dynamically parses gym gain multipliers from raw perk strings.
 */
export function parseGymPerkModifiers(perks: string[]): GymPerkModifiers {
	let strength = 1.0;
	let speed = 1.0;
	let defense = 1.0;
	let dexterity = 1.0;

	const gymRegex =
		/\+\s*(\d+(?:\.\d+)?)%\s*(strength|speed|defense|dexterity)?\s*gym gains/i;

	for (const perk of perks) {
		const match = perk.match(gymRegex);
		if (match?.[1]) {
			const percent = Number.parseFloat(match[1]);
			const multiplier = 1 + percent / 100;
			const stat = match[2]?.toLowerCase();

			if (stat === "strength") {
				strength *= multiplier;
			} else if (stat === "speed") {
				speed *= multiplier;
			} else if (stat === "defense") {
				defense *= multiplier;
			} else if (stat === "dexterity") {
				dexterity *= multiplier;
			} else {
				strength *= multiplier;
				speed *= multiplier;
				defense *= multiplier;
				dexterity *= multiplier;
			}
		}
	}

	return { strength, speed, defense, dexterity };
}

/**
 * Dynamically parses booster gain multipliers (e.g. energy drinks) from raw perk strings.
 */
export function parseBoosterPerkModifiers(
	perks: string[],
): BoosterPerkModifiers {
	let energyDrink = 1.0;
	const drinkRegex = /\+\s*(\d+(?:\.\d+)?)%\s*energy gain from energy drinks/i;

	for (const perk of perks) {
		const match = perk.match(drinkRegex);
		if (match?.[1]) {
			energyDrink += Number.parseFloat(match[1]) / 100;
		}
	}

	return { energyDrink };
}

/**
 * Dynamically parses travel perk modifiers (Airstrip, WLT, Book, Faction Excursion) from raw perk strings.
 */
export function parseTravelPerkModifiers(perks: string[]): TravelPerkModifiers {
	let factionTravelReduction = 0;
	let hasAirstrip = false;
	let hasWltBenefit = false;
	let hasBookPerk = false;

	const travelTimeRegex = /-\s*(\d+(?:\.\d+)?)%\s*travel\s*time/i;

	for (const perk of perks) {
		const lower = perk.toLowerCase();
		if (lower.includes("airstrip")) {
			hasAirstrip = true;
		}
		if (lower.includes("wlt") || lower.includes("westside")) {
			hasWltBenefit = true;
		}
		if (lower.includes("mailing yourself abroad")) {
			hasBookPerk = true;
			continue;
		}

		const match = perk.match(travelTimeRegex);
		if (match?.[1]) {
			const pct = Number.parseFloat(match[1]) / 100;
			factionTravelReduction += pct;
		}
	}

	const totalTravelReduction =
		factionTravelReduction + (hasBookPerk ? 0.25 : 0);

	return {
		hasAirstrip,
		hasWltBenefit,
		hasBookPerk,
		factionTravelReduction,
		totalTravelReduction,
	};
}

/**
 * Calculates estimated flight time in seconds given travel method & perk modifiers.
 */
export function calculateTravelTimeSeconds(
	destinationId: number,
	method: "standard" | "airstrip" | "wlt" | "business" = "airstrip",
	perks?: TravelPerkModifiers,
): number {
	const dest = DESTINATION_TRAVEL_INFO[destinationId];
	if (!dest) return 0;

	let baseMult = 1.0;
	if (method === "airstrip") baseMult = 0.7;
	else if (method === "wlt") baseMult = 0.5;
	else if (method === "business") baseMult = 0.3;

	let timeSec = dest.standardSeconds * baseMult;

	if (perks) {
		if (perks.hasBookPerk) {
			timeSec *= 0.75;
		}
		if (perks.factionTravelReduction > 0) {
			timeSec *= 1 - perks.factionTravelReduction;
		}
	}

	return Math.round(timeSec);
}

/**
 * Syncs unlocked gyms from personal logs and determines the best gym for each stat.
 */
export async function syncGymUnlocks(): Promise<void> {
	// Guard: skip if log_manager backfill is still in progress.
	// Gym unlock logs (5320) come from PersonalLog which won't be fully populated
	// until the backfill completes, leading to falsely low gym results.
	const backfillRecord = await db.query.systemStates.findFirst({
		where: eq(systemStates.id, LOG_MANAGER_STATE_ID),
	});

	const backfillData = backfillRecord?.data as
		| { backfillStatus?: string }
		| undefined;

	if (backfillData && backfillData.backfillStatus !== "completed") {
		logger.warn(
			"Log backfill is still in progress. Skipping gym unlock sync to avoid incomplete results.",
		);
		return;
	}

	const logs = await db
		.select()
		.from(personalLogs)
		.where(sql`${personalLogs.log} IN (5320, 5321)`)
		.all();

	type TornGym = typeof tornGyms.$inferSelect;
	const tornGymsList: TornGym[] = await db.select().from(tornGyms).all();

	const unlockedGymIds = new Set<number>([1]); // Everyone has gym 1 by default
	let maxStandardGym = 1;

	for (const log of logs) {
		const rawData = log.data as Record<string, unknown> | null;
		if (rawData && typeof rawData === "object") {
			let gymId: number | undefined;

			if (typeof rawData.gym === "number") {
				gymId = rawData.gym;
			} else if (
				rawData.data &&
				typeof rawData.data === "object" &&
				"gym" in rawData.data &&
				typeof (rawData.data as Record<string, unknown>).gym === "number"
			) {
				gymId = (rawData.data as Record<string, unknown>).gym as number;
			} else if (
				rawData.details &&
				typeof rawData.details === "object" &&
				"gym" in rawData.details &&
				typeof (rawData.details as Record<string, unknown>).gym === "number"
			) {
				gymId = (rawData.details as Record<string, unknown>).gym as number;
			}

			if (gymId !== undefined && gymId > 0) {
				unlockedGymIds.add(gymId);
				if (gymId <= 24 && gymId > maxStandardGym) {
					maxStandardGym = gymId;
				}
			}
		}
	}

	// In Torn, unlocking standard gym N implicitly unlocks all prior standard gyms 1..N
	for (let g = 1; g <= maxStandardGym; g++) {
		unlockedGymIds.add(g);
	}

	let bestStrengthGym = 1;
	let bestDefenseGym = 1;
	let bestSpeedGym = 1;
	let bestDexterityGym = 1;

	let maxStrength = 0;
	let maxDefense = 0;
	let maxSpeed = 0;
	let maxDexterity = 0;

	for (const gymId of unlockedGymIds) {
		const gym = tornGymsList.find((g: TornGym) => Number(g.id) === gymId);
		if (!gym) continue;

		if (gym.strength > maxStrength) {
			maxStrength = gym.strength;
			bestStrengthGym = gymId;
		}
		if (gym.defense > maxDefense) {
			maxDefense = gym.defense;
			bestDefenseGym = gymId;
		}
		if (gym.speed > maxSpeed) {
			maxSpeed = gym.speed;
			bestSpeedGym = gymId;
		}
		if (gym.dexterity > maxDexterity) {
			maxDexterity = gym.dexterity;
			bestDexterityGym = gymId;
		}
	}

	const now = new Date();
	const gymUnlockData: GymUnlocksData = {
		strengthGym: bestStrengthGym,
		defenseGym: bestDefenseGym,
		speedGym: bestSpeedGym,
		dexterityGym: bestDexterityGym,
		unlockedGymIds: Array.from(unlockedGymIds),
		timestamp: Math.floor(Date.now() / 1000),
	};

	await db
		.insert(systemStates)
		.values({
			id: GYM_UNLOCKS_STATE_ID,
			init: true,
			data: gymUnlockData,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: systemStates.id,
			set: {
				init: true,
				data: gymUnlockData,
				updatedAt: now,
			},
		});

	logger.info(
		`Synced gym unlocks. Best gyms: Str:${bestStrengthGym}, Def:${bestDefenseGym}, Spd:${bestSpeedGym}, Dex:${bestDexterityGym}`,
	);
}

type UserPerksResponse = {
	perks?: {
		faction?: string[];
		job?: string[];
		property?: string[];
		education?: string[];
		enhancer?: string[];
		book?: string[];
		stock?: string[];
		merit?: string[];
	};
	faction_perks?: string[];
	job_perks?: string[];
	property_perks?: string[];
	education_perks?: string[];
	enhancer_perks?: string[];
	book_perks?: string[];
	stock_perks?: string[];
	merit_perks?: string[];
};

/**
 * Runs daily sync at 00:15 UTC to fetch raw user perks & gym unlocks.
 */
export async function runPersonalReferenceSync(): Promise<number> {
	const finishSync = logger.time();

	try {
		const keyEntry = await getPersonalKey();
		if (!keyEntry) {
			logger.warn(
				"No personal API key found for personal reference sync. Skipping.",
			);
			return getNextUtcTargetTimestamp(0, 15);
		}

		// 1. Fetch raw perks from Torn API
		const res = (await tornApi.getPersonal("/user", {
			queryParams: { selections: ["perks"] },
		})) as UserPerksResponse;

		const innerPerks = res.perks ?? {};
		const categorizedPerks: Record<string, string[]> = {
			faction_perks: innerPerks.faction ?? res.faction_perks ?? [],
			job_perks: innerPerks.job ?? res.job_perks ?? [],
			property_perks: innerPerks.property ?? res.property_perks ?? [],
			education_perks: innerPerks.education ?? res.education_perks ?? [],
			enhancer_perks: innerPerks.enhancer ?? res.enhancer_perks ?? [],
			book_perks: innerPerks.book ?? res.book_perks ?? [],
			stock_perks: innerPerks.stock ?? res.stock_perks ?? [],
			merit_perks: innerPerks.merit ?? res.merit_perks ?? [],
		};

		const allPerks: string[] = Object.values(categorizedPerks).flat();
		const travelPerks = parseTravelPerkModifiers(allPerks);

		const now = new Date();
		const perksData: UserPerksData = {
			allPerks,
			categorizedPerks,
			travelPerks,
			timestamp: Math.floor(Date.now() / 1000),
		};

		// 2. Store raw perk list, categories & parsed travel perks in SQLite system_states
		await db
			.insert(systemStates)
			.values({
				id: PERKS_STATE_ID,
				init: true,
				data: perksData,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					init: true,
					data: perksData,
					updatedAt: now,
				},
			});

		logger.info(
			`Stored ${allPerks.length} raw user perks in SQLite system_states.`,
		);

		// 3. Sync gym unlocks
		await syncGymUnlocks();

		finishSync();
		return getNextUtcTargetTimestamp(0, 15);
	} catch (error) {
		logger.error("Failed to execute personal reference sync:", error);
		return getNextUtcTargetTimestamp(0, 15);
	}
}

/**
 * Starts the personal reference sync worker scheduled for 00:15 UTC.
 */
export function startPersonalReferenceSync(options?: WorkerStartOptions): void {
	// Once log backfill completes, immediately run gym unlock sync so we don't
	// wait until the next 00:15 UTC cycle for accurate gym data.
	schedulerEvents.on("log_backfill_completed", () => {
		syncGymUnlocks().catch((err) =>
			logger.error("Error running gym unlock sync after backfill:", err),
		);
	});

	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: 86400, // 24 hours
		initialDelayMs: options?.initialDelayMs,
		handler: runPersonalReferenceSync,
	});
}
