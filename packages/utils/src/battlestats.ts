export type StatType = "strength" | "defense" | "speed" | "dexterity";
export type StatSource = "gym" | "item" | "book" | "company";

export const GYM_TRAIN_LOG_IDS = [5300, 5301, 5302, 5303];
export const STAT_ENHANCER_LOG_IDS = [2120, 2130, 2140, 2150];
export const BOOK_LOG_IDS = [2052, 2053, 2054, 2055];
export const COMPANY_LOG_IDS = [6526, 6527, 6528, 6529];

export const STAT_GAIN_LOG_IDS = [
	...GYM_TRAIN_LOG_IDS,
	...STAT_ENHANCER_LOG_IDS,
	...BOOK_LOG_IDS,
	...COMPANY_LOG_IDS,
];

export const STAT_GAIN_LOG_ID_SET = new Set<number>(STAT_GAIN_LOG_IDS);

export type ParsedStatGain = {
	statType: StatType;
	statGained: number;
	statBefore?: number | null;
	statAfter?: number | null;
	source: StatSource;
	trains?: number | null;
	energyUsed?: number | null;
};

/**
 * Extracts stat gain details, previous stat value, after stat value, and source from a Torn user log payload.
 * Supports both flat Torn API logs and nested personal_logs SQLite storage objects.
 */
export function parseStatGainFromLog(log: unknown): ParsedStatGain | null {
	if (!log || typeof log !== "object") {
		return null;
	}

	const logObj = log as Record<string, unknown>;
	let rawData: Record<string, unknown> = logObj;
	let logDetails: Record<string, unknown> | null = null;
	let logTypeCode = Number(logObj.log ?? 0);

	if (typeof logObj.details === "object" && logObj.details !== null) {
		logDetails = logObj.details as Record<string, unknown>;
		if (logDetails.id) logTypeCode = Number(logDetails.id);
	}

	if (typeof logObj.data === "object" && logObj.data !== null) {
		const firstLevel = logObj.data as Record<string, unknown>;
		if (typeof firstLevel.details === "object" && firstLevel.details !== null) {
			const innerDetails = firstLevel.details as Record<string, unknown>;
			if (innerDetails.id) logTypeCode = Number(innerDetails.id);
		}
		if (typeof firstLevel.data === "object" && firstLevel.data !== null) {
			rawData = firstLevel.data as Record<string, unknown>;
		} else {
			rawData = firstLevel;
		}
	}

	let statType: StatType | null = null;
	let statGained = 0;
	let statBefore: number | null = null;
	let statAfter: number | null = null;

	if (
		rawData.strength_increased !== undefined &&
		rawData.strength_increased !== null
	) {
		statType = "strength";
		statGained = Number(rawData.strength_increased);
		if (
			rawData.strength_before !== undefined &&
			rawData.strength_before !== null
		) {
			statBefore = Number(rawData.strength_before);
		}
		if (
			rawData.strength_after !== undefined &&
			rawData.strength_after !== null
		) {
			statAfter = Number(rawData.strength_after);
		}
	} else if (
		rawData.defense_increased !== undefined &&
		rawData.defense_increased !== null
	) {
		statType = "defense";
		statGained = Number(rawData.defense_increased);
		if (
			rawData.defense_before !== undefined &&
			rawData.defense_before !== null
		) {
			statBefore = Number(rawData.defense_before);
		}
		if (rawData.defense_after !== undefined && rawData.defense_after !== null) {
			statAfter = Number(rawData.defense_after);
		}
	} else if (
		rawData.speed_increased !== undefined &&
		rawData.speed_increased !== null
	) {
		statType = "speed";
		statGained = Number(rawData.speed_increased);
		if (rawData.speed_before !== undefined && rawData.speed_before !== null) {
			statBefore = Number(rawData.speed_before);
		}
		if (rawData.speed_after !== undefined && rawData.speed_after !== null) {
			statAfter = Number(rawData.speed_after);
		}
	} else if (
		rawData.dexterity_increased !== undefined &&
		rawData.dexterity_increased !== null
	) {
		statType = "dexterity";
		statGained = Number(rawData.dexterity_increased);
		if (
			rawData.dexterity_before !== undefined &&
			rawData.dexterity_before !== null
		) {
			statBefore = Number(rawData.dexterity_before);
		}
		if (
			rawData.dexterity_after !== undefined &&
			rawData.dexterity_after !== null
		) {
			statAfter = Number(rawData.dexterity_after);
		}
	}

	if (!statType || Number.isNaN(statGained) || statGained <= 0) {
		return null;
	}

	let source: StatSource = "gym";
	if (STAT_ENHANCER_LOG_IDS.includes(logTypeCode)) {
		source = "item";
	} else if (BOOK_LOG_IDS.includes(logTypeCode)) {
		source = "book";
	} else if (COMPANY_LOG_IDS.includes(logTypeCode)) {
		source = "company";
	}

	const trains =
		rawData.trains !== undefined && rawData.trains !== null
			? Number(rawData.trains)
			: null;
	const energyUsed =
		rawData.energy_used !== undefined && rawData.energy_used !== null
			? Number(rawData.energy_used)
			: null;

	return {
		statType,
		statGained,
		statBefore,
		statAfter,
		source,
		trains: Number.isNaN(trains) ? null : trains,
		energyUsed: Number.isNaN(energyUsed) ? null : energyUsed,
	};
}
