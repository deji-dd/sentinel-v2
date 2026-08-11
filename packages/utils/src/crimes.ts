function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type CrimeRule = {
	id: number;
	patterns: RegExp[];
};

// ID 13 placed near the top to maintain high priority
const CRIME_RULES: CrimeRule[] = [
	{
		id: 13,
		keywords: [
			"rob",
			"robbery",
			"inquire",
			"make entry",
			"plant evidence",
			"planting evidence",
			"place combustible",
			"ignite fire",
			"stoke fire",
			"dampen fire",
			"collect",
			"breaching",
			"combustible",
			"igniting",
			"dampening",
			"stoking",
			"arson",
			"fire",
		],
	},
	{
		id: 1,
		keywords: ["search", "trash", "junkyard", "cemetery", "fountain"],
	},
	{
		id: 2,
		keywords: ["dvd", "bootleg", "online store"],
	},
	{
		id: 3,
		keywords: ["graffiti"],
	},
	{
		id: 4,
		keywords: ["shoplift"],
	},
	{
		id: 5,
		keywords: ["pickpocket"],
	},
	{
		id: 6,
		keywords: ["skim", "atm", "gas pump", "train station", "cash register"],
	},
	{
		id: 7,
		keywords: [
			"burgle",
			"burgling",
			"burglary",
			"casing",
			"scouting for an industrial burglary",
			"brewery",
			"truckyard",
			"foundry",
		],
	},
	{
		id: 8,
		keywords: ["hustle", "hustling", "shell game", "street hustle"],
	},
	{
		id: 9,
		keywords: [
			"dispose",
			"disposal",
			"discard",
			"abandoning",
			"burying",
			"vehicle",
			"sinking",
		],
	},
	{
		id: 10,
		keywords: [
			"crack",
			"cracking",
			"safe",
			"vault",
			"brute force",
			"brute forcing",
			"password",
			"encryption",
			"hash",
		],
	},
	{
		id: 11,
		keywords: [
			"forge",
			"forgery",
			"project",
			"step #",
			"drafting",
			"signing",
			"laminating",
			"cutting",
			"perforating",
			"painting",
			"trimming",
			"stacking & folding",
			"sewing",
			"gluing",
			"embossing",
		],
	},
	{
		id: 12,
		keywords: ["scam", "spam"],
	},
].map((rule) => ({
	id: rule.id,
	patterns: rule.keywords.map(
		(kw) => new RegExp(`(?:^|\\b|\\s)${escapeRegExp(kw)}(?=$|\\b|\\s)`, "i"),
	),
}));

/**
 * Maps a crime action string to its numeric Crime ID (1-13) matching Torn Crimes 2.0.
 * Uses exact word-boundary matching to prevent sub-word collisions.
 */
export function getCrimeIdFromAction(action: string): number {
	const trimmed = action.trim();
	if (!trimmed) return 0;

	for (const rule of CRIME_RULES) {
		if (rule.patterns.some((pattern) => pattern.test(trimmed))) {
			return rule.id;
		}
	}

	return 0;
}

/**
 * Safely extracts inner crime log action and nerve data regardless of object nesting.
 */
export function extractCrimeDataPayload(raw: unknown): {
	action: string;
	nerve: number;
	innerData: unknown;
} {
	if (!raw || typeof raw !== "object") {
		return { action: "", nerve: 0, innerData: null };
	}

	const rawObj = raw as Record<string, unknown>;
	const inner =
		typeof rawObj.data === "object" && rawObj.data !== null
			? (rawObj.data as Record<string, unknown>)
			: rawObj;

	const rawAction = inner.crime_action ?? rawObj.crime_action ?? "";
	const rawNerve = inner.nerve ?? rawObj.nerve ?? 0;

	const action = String(rawAction).trim();
	const nerve = Number(rawNerve);

	return { action, nerve, innerData: inner };
}

/**
 * Calculates net monetary value gained/lost in a crime event payload.
 */
export function calculateCrimeLogValue(data: unknown): number {
	if (!data || typeof data !== "object") return 0;
	const obj = data as Record<string, unknown>;
	let total = 0;

	if (obj.money_gained) total += Number(obj.money_gained);
	if (obj.money_lost) total -= Number(obj.money_lost);

	if (obj.items_gained && typeof obj.items_gained === "object") {
		for (const [, qty] of Object.entries(obj.items_gained)) {
			total += Number(qty || 0) * 1000;
		}
	}

	if (obj.items_lost && typeof obj.items_lost === "object") {
		for (const [, qty] of Object.entries(obj.items_lost)) {
			total -= Number(qty || 0) * 1000;
		}
	}

	return total;
}
