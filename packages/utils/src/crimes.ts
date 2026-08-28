function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOPWORDS = new Set([
	"the",
	"for",
	"and",
	"of",
	"in",
	"at",
	"to",
	"a",
	"an",
	"on",
	"with",
	"from",
	"by",
	"into",
	"as",
]);

/**
 * Generates an inflection regex pattern for a single English root word.
 * E.g., "farming" -> "farm(?:e|ing|ed|s|er|ers)?", "force" -> "forc(?:e|ing|ed|es|y|ery|al|als)?"
 */
export function createWordPattern(word: string): string {
	const clean = word.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!clean) return "";

	// introduction / production -> introduce, introducing, introduction
	if (clean.endsWith("duction") && clean.length > 7) {
		const stem = clean.slice(0, -4);
		return `${escapeRegExp(stem)}(?:e|ing|ed|es|tion|tions|tor|tors)?`;
	}
	// collection / encryption / destruction -> collect, encrypt, etc.
	if (clean.endsWith("tion") && clean.length > 5) {
		const stem = clean.slice(0, -3);
		return `${escapeRegExp(stem)}(?:e|ing|ed|s|es|ion|ions|or|ors)?`;
	}
	// disposal -> dispose, disposing, disposal
	if (clean.endsWith("al") && clean.length > 5) {
		const stem = clean.slice(0, -2);
		return `${escapeRegExp(stem)}(?:e|ing|ed|es|al|als)?`;
	}
	// advertisement / recruitment / development -> advertise, recruiting, etc.
	if (clean.endsWith("ment") && clean.length > 6) {
		let stem = clean.slice(0, -4);
		if (stem.endsWith("e")) {
			stem = stem.slice(0, -1);
		}
		return `${escapeRegExp(stem)}(?:e|ing|ed|es|ment|ments|er|ers)?`;
	}
	if (clean.endsWith("ing") && clean.length > 4) {
		const stem = clean.slice(0, -3);
		return `${escapeRegExp(stem)}(?:e|ing|ed|s|er|ers)?`;
	}
	if (clean.endsWith("ary") && clean.length > 5) {
		const stem = clean.slice(0, -3);
		return `${escapeRegExp(stem)}(?:e|ing|ed|s|er|ers|ary|aries|ar|ars)?`;
	}
	if (clean.endsWith("ery") && clean.length > 4) {
		const stem = clean.slice(0, -3);
		return `${escapeRegExp(stem)}(?:e|ing|ed|es|y|ery|ies)?`;
	}
	if (clean.endsWith("e") && clean.length > 3) {
		const stem = clean.slice(0, -1);
		return `${escapeRegExp(stem)}(?:e|ing|ed|es|y|ery|al|als)?`;
	}
	if (clean.endsWith("y") && clean.length > 3) {
		const stem = clean.slice(0, -1);
		return `${escapeRegExp(stem)}(?:y|ies|ied|ying|e|ing|ed|es)?`;
	}
	// Doubled consonants on short verbs (e.g. rob -> robbing, skim -> skimming, scam -> scamming)
	if (/[bcdfghjklmnpqrstvwxyz][aeiou][bdfgmnprtz]$/i.test(clean)) {
		const lastChar = clean[clean.length - 1];
		return `${escapeRegExp(clean)}(?:${lastChar}?ing|${lastChar}?ed|s|bery)?`;
	}
	if (clean === "junkyard") {
		return `(?:junk(?:\\s+|-)?yard|junkyard)(?:ing|ed|s|es|er|ers)?`;
	}
	return `${escapeRegExp(clean)}(?:ing|ed|s|es|er|ers)?`;
}

export const HIGH_PRIORITY_ACTION_WORDS = new Set<string>([
	"dampen",
	"dampening",
	"dampened",
	"ignite",
	"igniting",
	"ignited",
	"stoke",
	"stoking",
	"stoked",
	"breach",
	"breaching",
	"breached",
	"arson",
]);

/**
 * Builds comprehensive patterns for a phrase, partitioned by specificity (multi-word vs single-word):
 * 1. Literal word-boundary matching.
 * 2. Sequential inflection matching (e.g. "Brute force" -> "brute forcing").
 * 3. Order-independent conjunction matching requiring all significant words (e.g. "Email Farming" -> "farming email addresses").
 */
export function buildCategorizedPatternsForPhrase(phrase: string): {
	all: RegExp[];
	multiWord: RegExp[];
	singleWord: RegExp[];
} {
	const trimmed = phrase.trim();
	if (!trimmed) {
		return { all: [], multiWord: [], singleWord: [] };
	}

	const multiWord: RegExp[] = [];
	const singleWord: RegExp[] = [];

	const words = trimmed.split(/\s+/);
	const sigWords = words
		.map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
		.filter((w) => !STOPWORDS.has(w.toLowerCase()) && w.length >= 3);

	if (sigWords.length > 1) {
		// 1. Literal phrase match
		multiWord.push(
			new RegExp(`(?:^|\\b|\\s)${escapeRegExp(trimmed)}(?=$|\\b|\\s)`, "i"),
		);

		// 2. Sequential phrase with flexible inflections
		const seq = sigWords
			.map((w) => `\\b${createWordPattern(w)}\\b`)
			.join("(?:\\s+|-|\\w+\\s+)");
		multiWord.push(new RegExp(seq, "i"));

		// 3. Order-independent conjunction (all significant words must be present)
		// e.g. "Cyber Force" requires BOTH "cyber" and "force"
		// e.g. "Brute force" requires BOTH "brute" and "force"
		// e.g. "Email Farming" requires BOTH "farm" and "email"
		// e.g. "Online Store" requires BOTH "online" and "store"
		const lookaheads = sigWords
			.map((w) => `(?=.*\\b${createWordPattern(w)}\\b)`)
			.join("");
		multiWord.push(new RegExp(`^${lookaheads}.*$`, "i"));
	} else if (sigWords.length === 1 && sigWords[0]) {
		const wordPattern = new RegExp(
			`\\b${createWordPattern(sigWords[0])}\\b`,
			"i",
		);
		// If this is a distinctive high-priority action verb (e.g. "dampening", "igniting", "stoking", "breaching"),
		// promote it to multiWord so it matches with primary priority alongside multi-word phrases.
		if (HIGH_PRIORITY_ACTION_WORDS.has(sigWords[0].toLowerCase())) {
			multiWord.push(wordPattern);
		} else {
			// 1. Literal phrase match
			singleWord.push(
				new RegExp(`(?:^|\\b|\\s)${escapeRegExp(trimmed)}(?=$|\\b|\\s)`, "i"),
			);
			// Single significant word (e.g. "Graffiti", "Pickpocketing", "Hustling", "Crack", "Collect")
			singleWord.push(wordPattern);
		}
	}

	return {
		all: [...multiWord, ...singleWord],
		multiWord,
		singleWord,
	};
}

export function buildPatternsForPhrase(phrase: string): RegExp[] {
	return buildCategorizedPatternsForPhrase(phrase).all;
}

export type CrimeRule = {
	id: number;
	patterns: RegExp[];
	multiWordPatterns?: RegExp[];
	singleWordPatterns?: RegExp[];
};

export type CrimeDefinitionSource = {
	id: number | string;
	name?: string | null;
	subcrimes?: Array<{
		id: number | string;
		name: string;
		nerve_cost?: number;
	}>;
};

/**
 * Map of known Torn Crimes API subcrime names to alternate vocabulary used in personal logs.
 * E.g. Torn API subcrime #329 is "Make Entry", but personal log actions record "breaching a Candle Shop...".
 * E.g. Torn API subcrime #332 is "Ignite Fire", but personal log actions record "igniting a Chiropractors Office...".
 */
export const SUBCRIME_SYNONYMS: Record<string, string[]> = {
	"make entry": ["breach", "breaching", "making entry"],
	"ignite fire": ["ignite", "igniting", "ignited"],
	"stoke fire": ["stoke", "stoking", "stoked"],
	"dampen fire": ["dampen", "dampening", "dampened"],
	"place combustible": [
		"combustible",
		"place combustible",
		"placing combustible",
	],
	"plant evidence": ["plant evidence", "planting evidence"],
	"online store": [
		"online store",
		"collecting funds from an online store",
		"collecting from an online store",
		"collecting from online store",
	],
	"advertisement agency - burgle": [
		"burgle an advertising agency",
		"burgling an advertising agency",
		"burgle advertising agency",
		"burgling advertising agency",
	],
	"advertising agency - case": [
		"case an advertising agency",
		"casing an advertising agency",
		"case advertising agency",
		"casing advertising agency",
	],
	"search the junkyard": [
		"search the junk yard",
		"searching the junk yard",
		"searched the junk yard",
		"junk yard",
		"junkyard",
	],
	junkyard: ["junk yard", "junkyard"],
};

/**
 * Builds prioritized RegExp patterns dynamically from Torn API subcrimes and crime categories.
 * Generates flexible word-boundary, inflection, and order-independent patterns for each subcrime and crime title.
 * Preserves high-priority rules (e.g. ID 13) near the top to prevent sub-word collisions.
 */
export const DEFAULT_CRIME_DEFINITIONS: CrimeDefinitionSource[] = [
	{
		id: 1,
		name: "Search for Cash",
		subcrimes: [
			{
				id: 1,
				name: "Search the Trash",
				nerve_cost: 2,
			},
			{
				id: 2,
				name: "Search the Subway",
				nerve_cost: 2,
			},
			{
				id: 3,
				name: "Search the Junkyard",
				nerve_cost: 2,
			},
			{
				id: 4,
				name: "Search the Beach",
				nerve_cost: 2,
			},
			{
				id: 5,
				name: "Search the Cemetery",
				nerve_cost: 2,
			},
			{
				id: 6,
				name: "Search the Fountain",
				nerve_cost: 2,
			},
		],
	},
	{
		id: 2,
		name: "Bootlegging",
		subcrimes: [
			{
				id: 8,
				name: "Copy DVDs",
				nerve_cost: 2,
			},
			{
				id: 9,
				name: "Sell Counterfeit DVDs",
				nerve_cost: 5,
			},
			{
				id: 10,
				name: "Set Up Online Store",
				nerve_cost: 10,
			},
			{
				id: 11,
				name: "Online Store",
				nerve_cost: 1,
			},
		],
	},
	{
		id: 3,
		name: "Graffiti",
		subcrimes: [
			{
				id: 12,
				name: "West Side",
				nerve_cost: 3,
			},
			{
				id: 13,
				name: "North Side",
				nerve_cost: 3,
			},
			{
				id: 14,
				name: "Red-Light District",
				nerve_cost: 3,
			},
			{
				id: 15,
				name: "Residential District",
				nerve_cost: 3,
			},
			{
				id: 16,
				name: "City Center",
				nerve_cost: 3,
			},
			{
				id: 17,
				name: "Financial District",
				nerve_cost: 3,
			},
			{
				id: 18,
				name: "East Side",
				nerve_cost: 3,
			},
		],
	},
	{
		id: 4,
		name: "Shoplifting",
		subcrimes: [
			{
				id: 19,
				name: "Sally's Sweet Shop",
				nerve_cost: 4,
			},
			{
				id: 20,
				name: "Bits 'n' Bobs",
				nerve_cost: 4,
			},
			{
				id: 22,
				name: "Super Store",
				nerve_cost: 4,
			},
			{
				id: 21,
				name: "TC Clothing",
				nerve_cost: 4,
			},
			{
				id: 23,
				name: "Big Al's Gun Shop",
				nerve_cost: 4,
			},
			{
				id: 24,
				name: "Jewelry Store",
				nerve_cost: 4,
			},
			{
				id: 217,
				name: "Cyber Force",
				nerve_cost: 4,
			},
			{
				id: 218,
				name: "Pharmacy",
				nerve_cost: 4,
			},
		],
	},
	{
		id: 5,
		name: "Pickpocketing",
		subcrimes: [
			{
				id: 27,
				name: "Young woman",
				nerve_cost: 5,
			},
			{
				id: 29,
				name: "Elderly man",
				nerve_cost: 5,
			},
			{
				id: 28,
				name: "Young man",
				nerve_cost: 5,
			},
			{
				id: 30,
				name: "Elderly woman",
				nerve_cost: 5,
			},
			{
				id: 31,
				name: "Businessman",
				nerve_cost: 5,
			},
			{
				id: 33,
				name: "Student",
				nerve_cost: 5,
			},
			{
				id: 38,
				name: "Thug",
				nerve_cost: 5,
			},
			{
				id: 32,
				name: "Businesswoman",
				nerve_cost: 5,
			},
			{
				id: 37,
				name: "Drunk woman",
				nerve_cost: 5,
			},
			{
				id: 34,
				name: "Homeless person",
				nerve_cost: 5,
			},
			{
				id: 35,
				name: "Classy lady",
				nerve_cost: 5,
			},
			{
				id: 36,
				name: "Drunk man",
				nerve_cost: 5,
			},
			{
				id: 40,
				name: "Mobster",
				nerve_cost: 5,
			},
			{
				id: 39,
				name: "Gang member",
				nerve_cost: 5,
			},
			{
				id: 42,
				name: "Junkie",
				nerve_cost: 5,
			},
			{
				id: 43,
				name: "Cyclist",
				nerve_cost: 5,
			},
			{
				id: 41,
				name: "Laborer",
				nerve_cost: 5,
			},
			{
				id: 44,
				name: "Postal worker",
				nerve_cost: 5,
			},
			{
				id: 45,
				name: "Sex worker",
				nerve_cost: 5,
			},
			{
				id: 46,
				name: "Rich kid",
				nerve_cost: 5,
			},
			{
				id: 47,
				name: "Jogger",
				nerve_cost: 5,
			},
			{
				id: 48,
				name: "Police officer",
				nerve_cost: 5,
			},
		],
	},
	{
		id: 6,
		name: "Card Skimming",
		subcrimes: [
			{
				id: 60,
				name: "Recover College Campus",
				nerve_cost: 4,
			},
			{
				id: 51,
				name: "Sell Card Details",
				nerve_cost: 6,
			},
			{
				id: 53,
				name: "Install College Campus",
				nerve_cost: 6,
			},
			{
				id: 50,
				name: "Recover Bus Station",
				nerve_cost: 4,
			},
			{
				id: 58,
				name: "Install Bank Branch",
				nerve_cost: 6,
			},
			{
				id: 55,
				name: "Install Post Office",
				nerve_cost: 6,
			},
			{
				id: 61,
				name: "Recover Gas Station",
				nerve_cost: 4,
			},
			{
				id: 54,
				name: "Install Gas Station",
				nerve_cost: 6,
			},
			{
				id: 56,
				name: "Install Airport Terminal",
				nerve_cost: 6,
			},
			{
				id: 52,
				name: "Install Subway Station",
				nerve_cost: 6,
			},
			{
				id: 57,
				name: "Install Casino Lobby",
				nerve_cost: 6,
			},
			{
				id: 49,
				name: "Install Bus Station",
				nerve_cost: 6,
			},
			{
				id: 59,
				name: "Recover Subway Station",
				nerve_cost: 4,
			},
			{
				id: 62,
				name: "Recover Post Office",
				nerve_cost: 4,
			},
			{
				id: 63,
				name: "Recover Airport Terminal",
				nerve_cost: 4,
			},
			{
				id: 65,
				name: "Recover Bank Branch",
				nerve_cost: 4,
			},
			{
				id: 64,
				name: "Recover Casino Lobby",
				nerve_cost: 4,
			},
		],
	},
	{
		id: 7,
		name: "Burglary",
		subcrimes: [
			{
				id: 71,
				name: "Beach Hut - Case",
				nerve_cost: 2,
			},
			{
				id: 69,
				name: "Tool Shed - Case",
				nerve_cost: 2,
			},
			{
				id: 76,
				name: "Bungalow - Burgle",
				nerve_cost: 6,
			},
			{
				id: 75,
				name: "Bungalow - Case",
				nerve_cost: 2,
			},
			{
				id: 70,
				name: "Tool Shed - Burgle",
				nerve_cost: 6,
			},
			{
				id: 66,
				name: "Residential targets",
				nerve_cost: 3,
			},
			{
				id: 67,
				name: "Commercial targets",
				nerve_cost: 3,
			},
			{
				id: 68,
				name: "Industrial targets",
				nerve_cost: 3,
			},
			{
				id: 77,
				name: "Cottage - Case",
				nerve_cost: 2,
			},
			{
				id: 73,
				name: "Mobile Home - Case",
				nerve_cost: 2,
			},
			{
				id: 74,
				name: "Mobile Home - Burgle",
				nerve_cost: 6,
			},
			{
				id: 72,
				name: "Beach Hut - Burgle",
				nerve_cost: 6,
			},
			{
				id: 85,
				name: "Farmhouse - Case",
				nerve_cost: 2,
			},
			{
				id: 90,
				name: "Luxury Villa - Burgle",
				nerve_cost: 6,
			},
			{
				id: 78,
				name: "Cottage - Burgle",
				nerve_cost: 6,
			},
			{
				id: 87,
				name: "Lake House - Case",
				nerve_cost: 2,
			},
			{
				id: 80,
				name: "Apartment - Burgle",
				nerve_cost: 6,
			},
			{
				id: 79,
				name: "Apartment - Case",
				nerve_cost: 2,
			},
			{
				id: 86,
				name: "Farmhouse - Burgle",
				nerve_cost: 6,
			},
			{
				id: 89,
				name: "Luxury Villa - Case",
				nerve_cost: 2,
			},
			{
				id: 82,
				name: "Suburban Home - Burgle",
				nerve_cost: 6,
			},
			{
				id: 81,
				name: "Suburban Home - Case",
				nerve_cost: 2,
			},
			{
				id: 83,
				name: "Secluded Cabin - Case",
				nerve_cost: 2,
			},
			{
				id: 84,
				name: "Secluded Cabin - Burgle",
				nerve_cost: 6,
			},
			{
				id: 88,
				name: "Lake House - Burgle",
				nerve_cost: 6,
			},
			{
				id: 92,
				name: "Manor House - Burgle",
				nerve_cost: 6,
			},
			{
				id: 93,
				name: "Self Storage Facility - Case",
				nerve_cost: 2,
			},
			{
				id: 96,
				name: "Postal Office - Burgle",
				nerve_cost: 6,
			},
			{
				id: 95,
				name: "Postal Office - Case",
				nerve_cost: 2,
			},
			{
				id: 94,
				name: "Self Storage Facility - Burgle",
				nerve_cost: 6,
			},
			{
				id: 91,
				name: "Manor House - Case",
				nerve_cost: 2,
			},
			{
				id: 97,
				name: "Funeral Parlor - Case",
				nerve_cost: 2,
			},
			{
				id: 98,
				name: "Funeral Parlor - Burgle",
				nerve_cost: 6,
			},
			{
				id: 99,
				name: "Market - Case",
				nerve_cost: 2,
			},
			{
				id: 100,
				name: "Market - Burgle",
				nerve_cost: 6,
			},
			{
				id: 101,
				name: "Cleaning Agency - Case",
				nerve_cost: 2,
			},
			{
				id: 102,
				name: "Cleaning Agency - Burgle",
				nerve_cost: 6,
			},
			{
				id: 103,
				name: "Barbershop - Case",
				nerve_cost: 2,
			},
			{
				id: 104,
				name: "Barbershop - Burgle",
				nerve_cost: 6,
			},
			{
				id: 105,
				name: "Liquor Store - Case",
				nerve_cost: 2,
			},
			{
				id: 106,
				name: "Liquor Store - Burgle",
				nerve_cost: 6,
			},
			{
				id: 107,
				name: "Dentists Office - Case",
				nerve_cost: 2,
			},
			{
				id: 108,
				name: "Dentists Office - Burgle",
				nerve_cost: 6,
			},
			{
				id: 109,
				name: "Chiropractors - Case",
				nerve_cost: 2,
			},
			{
				id: 110,
				name: "Chiropractors - Burgle",
				nerve_cost: 6,
			},
			{
				id: 112,
				name: "Recruitment Agency - Burgle",
				nerve_cost: 6,
			},
			{
				id: 111,
				name: "Recruitment Agency - Case",
				nerve_cost: 2,
			},
			{
				id: 113,
				name: "Advertising Agency - Case",
				nerve_cost: 2,
			},
			{
				id: 114,
				name: "Advertisement Agency - Burgle",
				nerve_cost: 6,
			},
			{
				id: 115,
				name: "Shipyard - Case",
				nerve_cost: 2,
			},
			{
				id: 116,
				name: "Shipyard - Burgle",
				nerve_cost: 6,
			},
			{
				id: 117,
				name: "Dockside Warehouse - Case",
				nerve_cost: 2,
			},
			{
				id: 118,
				name: "Dockside Warehouse - Burgle",
				nerve_cost: 6,
			},
			{
				id: 119,
				name: "Farm Storage Unit - Case",
				nerve_cost: 2,
			},
			{
				id: 120,
				name: "Farm Storage Unit - Burgle",
				nerve_cost: 6,
			},
			{
				id: 121,
				name: "Printing Works - Case",
				nerve_cost: 2,
			},
			{
				id: 122,
				name: "Printing Works - Burgle",
				nerve_cost: 6,
			},
			{
				id: 123,
				name: "Brewery - Case",
				nerve_cost: 2,
			},
			{
				id: 124,
				name: "Brewery - Burgle",
				nerve_cost: 6,
			},
			{
				id: 125,
				name: "Truckyard - Case",
				nerve_cost: 2,
			},
			{
				id: 126,
				name: "Truckyard - Burgle",
				nerve_cost: 6,
			},
			{
				id: 127,
				name: "Old Factory - Case",
				nerve_cost: 2,
			},
			{
				id: 128,
				name: "Old Factory - Burgle",
				nerve_cost: 6,
			},
			{
				id: 129,
				name: "Slaughterhouse - Case",
				nerve_cost: 2,
			},
			{
				id: 130,
				name: "Slaughterhouse - Burgle",
				nerve_cost: 6,
			},
			{
				id: 131,
				name: "Paper Mill - Case",
				nerve_cost: 2,
			},
			{
				id: 132,
				name: "Paper Mill - Burgle",
				nerve_cost: 6,
			},
			{
				id: 133,
				name: "Foundry - Case",
				nerve_cost: 2,
			},
			{
				id: 134,
				name: "Foundry - Burgle",
				nerve_cost: 6,
			},
			{
				id: 135,
				name: "Fertilizer Plant - Case",
				nerve_cost: 2,
			},
			{
				id: 136,
				name: "Fertilizer Plant - Burgle",
				nerve_cost: 6,
			},
		],
	},
	{
		id: 8,
		name: "Hustling",
		subcrimes: [
			{
				id: 137,
				name: "Audience",
				nerve_cost: 4,
			},
			{
				id: 138,
				name: "Recruit Shill",
				nerve_cost: 4,
			},
			{
				id: 139,
				name: "Recruit Pickpocket",
				nerve_cost: 4,
			},
			{
				id: 140,
				name: "Shell Game - Introduction",
				nerve_cost: 2,
			},
			{
				id: 141,
				name: "Find the Lady - Introduction",
				nerve_cost: 2,
			},
			{
				id: 142,
				name: "Cornhole - Introduction",
				nerve_cost: 2,
			},
			{
				id: 143,
				name: "Snail Racing - Introduction",
				nerve_cost: 2,
			},
			{
				id: 144,
				name: "Shill Collect",
				nerve_cost: 2,
			},
			{
				id: 145,
				name: "Pickpocket collect",
				nerve_cost: 2,
			},
			{
				id: 146,
				name: "Shell Game - Lose",
				nerve_cost: 2,
			},
			{
				id: 147,
				name: "Find the Lady - Lose",
				nerve_cost: 2,
			},
			{
				id: 148,
				name: "Cornhole - Lose",
				nerve_cost: 2,
			},
			{
				id: 149,
				name: "Snail Racing - Lose",
				nerve_cost: 2,
			},
			{
				id: 150,
				name: "Shell Game - Win",
				nerve_cost: 2,
			},
			{
				id: 151,
				name: "Find the Lady - Win",
				nerve_cost: 2,
			},
			{
				id: 152,
				name: "Cornhole - Win",
				nerve_cost: 2,
			},
			{
				id: 153,
				name: "Snail Racing - Win",
				nerve_cost: 2,
			},
		],
	},
	{
		id: 9,
		name: "Disposal",
		subcrimes: [
			{
				id: 157,
				name: "General Waste - Abandon",
				nerve_cost: 6,
			},
			{
				id: 160,
				name: "General Waste - Sink",
				nerve_cost: 12,
			},
			{
				id: 158,
				name: "General Waste - Burn",
				nerve_cost: 10,
			},
			{
				id: 159,
				name: "General Waste - Bury",
				nerve_cost: 8,
			},
			{
				id: 161,
				name: "General Waste - Dissolve",
				nerve_cost: 14,
			},
			{
				id: 163,
				name: "Old Furniture - Burn",
				nerve_cost: 10,
			},
			{
				id: 162,
				name: "Old Furniture - Abandon",
				nerve_cost: 6,
			},
			{
				id: 164,
				name: "Old Furniture - Bury",
				nerve_cost: 8,
			},
			{
				id: 167,
				name: "Broken Appliance - Abandon",
				nerve_cost: 6,
			},
			{
				id: 165,
				name: "Old Furniture - Sink",
				nerve_cost: 12,
			},
			{
				id: 169,
				name: "Broken Appliance - Sink",
				nerve_cost: 12,
			},
			{
				id: 168,
				name: "Broken Appliance - Bury",
				nerve_cost: 8,
			},
			{
				id: 166,
				name: "Old Furniture - Dissolve",
				nerve_cost: 14,
			},
			{
				id: 172,
				name: "Building Debris - Bury",
				nerve_cost: 8,
			},
			{
				id: 171,
				name: "Building Debris - Abandon",
				nerve_cost: 6,
			},
			{
				id: 170,
				name: "Broken Appliance - Dissolve",
				nerve_cost: 14,
			},
			{
				id: 173,
				name: "Building Debris - Sink",
				nerve_cost: 12,
			},
			{
				id: 176,
				name: "Documents - Bury",
				nerve_cost: 8,
			},
			{
				id: 174,
				name: "Documents - Abandon",
				nerve_cost: 6,
			},
			{
				id: 175,
				name: "Documents - Burn",
				nerve_cost: 10,
			},
			{
				id: 177,
				name: "Documents - Sink",
				nerve_cost: 12,
			},
			{
				id: 178,
				name: "Documents - Dissolve",
				nerve_cost: 14,
			},
			{
				id: 180,
				name: "Vehicle - Burn",
				nerve_cost: 10,
			},
			{
				id: 179,
				name: "Vehicle - Abandon",
				nerve_cost: 6,
			},
			{
				id: 181,
				name: "Vehicle - Sink",
				nerve_cost: 12,
			},
			{
				id: 182,
				name: "Industrial Waste - Abandon",
				nerve_cost: 6,
			},
			{
				id: 183,
				name: "Industrial Waste - Sink",
				nerve_cost: 12,
			},
			{
				id: 184,
				name: "Biological Waste - Abandon",
				nerve_cost: 6,
			},
			{
				id: 185,
				name: "Biological Waste - Sink",
				nerve_cost: 12,
			},
			{
				id: 188,
				name: "Murder Weapon - Sink",
				nerve_cost: 12,
			},
			{
				id: 187,
				name: "Murder Weapon - Bury",
				nerve_cost: 8,
			},
			{
				id: 190,
				name: "Firearm - Abandon",
				nerve_cost: 6,
			},
			{
				id: 189,
				name: "Murder Weapon - Dissolve",
				nerve_cost: 14,
			},
			{
				id: 186,
				name: "Murder Weapon - Abandon",
				nerve_cost: 6,
			},
			{
				id: 191,
				name: "Firearm - Bury",
				nerve_cost: 8,
			},
			{
				id: 192,
				name: "Firearm - Sink",
				nerve_cost: 12,
			},
			{
				id: 193,
				name: "Firearm - Dissolve",
				nerve_cost: 14,
			},
			{
				id: 195,
				name: "Body Part - Burn",
				nerve_cost: 10,
			},
			{
				id: 196,
				name: "Body Part - Bury",
				nerve_cost: 8,
			},
			{
				id: 197,
				name: "Body Part - Sink",
				nerve_cost: 12,
			},
			{
				id: 194,
				name: "Body Part - Abandon",
				nerve_cost: 6,
			},
			{
				id: 200,
				name: "Dead Body - Burn",
				nerve_cost: 10,
			},
			{
				id: 198,
				name: "Body Part - Dissolve",
				nerve_cost: 14,
			},
			{
				id: 199,
				name: "Dead Body - Abandon",
				nerve_cost: 6,
			},
			{
				id: 201,
				name: "Dead Body - Bury",
				nerve_cost: 8,
			},
			{
				id: 203,
				name: "Dead Body - Dissolve",
				nerve_cost: 14,
			},
			{
				id: 202,
				name: "Dead Body - Sink",
				nerve_cost: 12,
			},
			{
				id: 214,
				name: "Industrial Waste - Bury",
				nerve_cost: 8,
			},
			{
				id: 215,
				name: "Biological Waste - Burn",
				nerve_cost: 10,
			},
			{
				id: 216,
				name: "Biological Waste - Bury",
				nerve_cost: 8,
			},
		],
	},
	{
		id: 10,
		name: "Cracking",
		subcrimes: [
			{
				id: 205,
				name: "Brute force",
				nerve_cost: 7,
			},
			{
				id: 206,
				name: "Crack",
				nerve_cost: 5,
			},
		],
	},
	{
		id: 11,
		name: "Forgery",
		subcrimes: [
			{
				id: 207,
				name: "Begin Driver's License project",
				nerve_cost: 0,
			},
			{
				id: 208,
				name: "Step #1 : License drafting",
				nerve_cost: 5,
			},
			{
				id: 209,
				name: "Step #2 : License signing",
				nerve_cost: 5,
			},
			{
				id: 210,
				name: "Step #3 : License printing",
				nerve_cost: 5,
			},
			{
				id: 211,
				name: "Step #4 : License lamination",
				nerve_cost: 5,
			},
			{
				id: 212,
				name: "Begin Parking Permit project",
				nerve_cost: 0,
			},
			{
				id: 213,
				name: "Step #1 : Permit drafting",
				nerve_cost: 5,
			},
			{
				id: 219,
				name: "Step #2 : Permit printing",
				nerve_cost: 5,
			},
			{
				id: 220,
				name: "Step #3 : Permit cutting",
				nerve_cost: 5,
			},
			{
				id: 221,
				name: "Step #4 : Permit lamination",
				nerve_cost: 5,
			},
			{
				id: 223,
				name: "Step #1 : Ticket drafting",
				nerve_cost: 5,
			},
			{
				id: 233,
				name: "Step #6 : Plate drilling",
				nerve_cost: 5,
			},
			{
				id: 244,
				name: "Step #4 : Diploma signing",
				nerve_cost: 5,
			},
			{
				id: 228,
				name: "Step #1 : Plate pressing",
				nerve_cost: 5,
			},
			{
				id: 226,
				name: "Step #4 : Ticket perforation",
				nerve_cost: 5,
			},
			{
				id: 238,
				name: "Step #4 : Birth certificate sealing",
				nerve_cost: 5,
			},
			{
				id: 242,
				name: "Step #2 : Diploma printing",
				nerve_cost: 5,
			},
			{
				id: 231,
				name: "Step #4 : Plate stencil cutting",
				nerve_cost: 5,
			},
			{
				id: 239,
				name: "Step #5 : Birth certificate signing",
				nerve_cost: 5,
			},
			{
				id: 243,
				name: "Step #3 : Diploma sealing",
				nerve_cost: 5,
			},
			{
				id: 241,
				name: "Step #1 : Diploma drafting",
				nerve_cost: 5,
			},
			{
				id: 235,
				name: "Step #1 : Birth certificate drafting",
				nerve_cost: 5,
			},
			{
				id: 229,
				name: "Step #2 : Plate background painting",
				nerve_cost: 5,
			},
			{
				id: 237,
				name: "Step #3 : Birth certificate typewriting",
				nerve_cost: 5,
			},
			{
				id: 230,
				name: "Step #3 : Plate rubbing",
				nerve_cost: 5,
			},
			{
				id: 236,
				name: "Step #2 : Birth certificate printing",
				nerve_cost: 5,
			},
			{
				id: 232,
				name: "Step #5 : Plate letter painting",
				nerve_cost: 5,
			},
			{
				id: 222,
				name: "Begin Concert Ticket project",
				nerve_cost: 0,
			},
			{
				id: 227,
				name: "Begin License Plate project",
				nerve_cost: 0,
			},
			{
				id: 240,
				name: "Begin Diploma project",
				nerve_cost: 0,
			},
			{
				id: 234,
				name: "Begin Birth Certificate project",
				nerve_cost: 0,
			},
			{
				id: 224,
				name: "Step #2 : Ticket printing",
				nerve_cost: 5,
			},
			{
				id: 225,
				name: "Step #3 : Ticket cutting",
				nerve_cost: 5,
			},
			{
				id: 246,
				name: "Step #1 : Key mold forming",
				nerve_cost: 5,
			},
			{
				id: 245,
				name: "Begin Skeleton Key project",
				nerve_cost: 0,
			},
			{
				id: 247,
				name: "Step #2 : Key casting",
				nerve_cost: 5,
			},
			{
				id: 250,
				name: "Begin Prescription project",
				nerve_cost: 0,
			},
			{
				id: 248,
				name: "Step #3 : Key filing",
				nerve_cost: 5,
			},
			{
				id: 249,
				name: "Step #4 : Key polishing",
				nerve_cost: 5,
			},
			{
				id: 252,
				name: "Step #2 : Prescription printing",
				nerve_cost: 5,
			},
			{
				id: 251,
				name: "Step #1 : Prescription drafting",
				nerve_cost: 5,
			},
			{
				id: 253,
				name: "Step #3 : Prescription typewriting",
				nerve_cost: 5,
			},
			{
				id: 254,
				name: "Step #4 : Prescription signing",
				nerve_cost: 5,
			},
			{
				id: 255,
				name: "Begin Travel Visa project",
				nerve_cost: 0,
			},
			{
				id: 256,
				name: "Step #1 : Travel Visa drafting",
				nerve_cost: 5,
			},
			{
				id: 257,
				name: "Step #2 : Travel Visa printing",
				nerve_cost: 5,
			},
			{
				id: 258,
				name: "Step #3 : Travel Visa embossing",
				nerve_cost: 5,
			},
			{
				id: 259,
				name: "Step #4 : Travel Visa holography",
				nerve_cost: 5,
			},
			{
				id: 260,
				name: "Begin Bank Check project",
				nerve_cost: 0,
			},
			{
				id: 261,
				name: "Step #1 : Bank Check drafting",
				nerve_cost: 5,
			},
			{
				id: 262,
				name: "Step #2 : Bank Check printing",
				nerve_cost: 5,
			},
			{
				id: 263,
				name: "Step #3 : Check cutting",
				nerve_cost: 5,
			},
			{
				id: 264,
				name: "Step #4 : Check embossing",
				nerve_cost: 5,
			},
			{
				id: 265,
				name: "Step #5 : Check perforation",
				nerve_cost: 5,
			},
			{
				id: 266,
				name: "Step #6 : Check signing",
				nerve_cost: 5,
			},
			{
				id: 267,
				name: "Begin Police Badge project",
				nerve_cost: 0,
			},
			{
				id: 270,
				name: "Step #3 : Badge filing",
				nerve_cost: 5,
			},
			{
				id: 268,
				name: "Step #1 : Badge mold forming",
				nerve_cost: 5,
			},
			{
				id: 269,
				name: "Step #2 : Badge casting",
				nerve_cost: 5,
			},
			{
				id: 272,
				name: "Step #4 : Badge graving",
				nerve_cost: 5,
			},
			{
				id: 273,
				name: "Step #5 : Badge firing",
				nerve_cost: 5,
			},
			{
				id: 274,
				name: "Step #6 : Badge enamel grinding",
				nerve_cost: 5,
			},
			{
				id: 275,
				name: "Step #7 : Badge final polishing",
				nerve_cost: 5,
			},
			{
				id: 276,
				name: "Begin Passport project",
				nerve_cost: 0,
			},
			{
				id: 277,
				name: "Step #1 : Passport cover cutting",
				nerve_cost: 5,
			},
			{
				id: 278,
				name: "Step #2 : Passport latex wrapping",
				nerve_cost: 5,
			},
			{
				id: 279,
				name: "Step #3 : Passport cover embossing",
				nerve_cost: 5,
			},
			{
				id: 280,
				name: "Step #4 : Passport logo stamping",
				nerve_cost: 5,
			},
			{
				id: 281,
				name: "Step #5 : Passport photo page drafting",
				nerve_cost: 5,
			},
			{
				id: 282,
				name: "Step #6 : Passport page printing",
				nerve_cost: 5,
			},
			{
				id: 283,
				name: "Step #7 : Passport page trimming",
				nerve_cost: 5,
			},
			{
				id: 284,
				name: "Step #8 : Passport page stacking & folding",
				nerve_cost: 5,
			},
			{
				id: 285,
				name: "Step #9 : Passport booklet sewing",
				nerve_cost: 5,
			},
			{
				id: 286,
				name: "Step #10 : Passport cover gluing",
				nerve_cost: 5,
			},
			{
				id: 287,
				name: "Step #11 : Passport lamination",
				nerve_cost: 5,
			},
			{
				id: 288,
				name: "Step #12 : Passport quality check",
				nerve_cost: 5,
			},
			{
				id: 289,
				name: "Step #5 : Visa lamination",
				nerve_cost: 5,
			},
			{
				id: 314,
				name: "Begin ID Badge project",
				nerve_cost: 0,
			},
			{
				id: 315,
				name: "Step #1 : ID drafting",
				nerve_cost: 5,
			},
			{
				id: 316,
				name: "Step #2 : ID printing",
				nerve_cost: 5,
			},
			{
				id: 317,
				name: "Step #3 : ID extracting",
				nerve_cost: 5,
			},
			{
				id: 318,
				name: "Step #4 : ID Embedding",
				nerve_cost: 5,
			},
			{
				id: 319,
				name: "Step #5 : ID Programming",
				nerve_cost: 5,
			},
			{
				id: 320,
				name: "Begin ATM Key project",
				nerve_cost: 0,
			},
			{
				id: 321,
				name: "Step #1 : Key mold forming",
				nerve_cost: 5,
			},
			{
				id: 322,
				name: "Step #2 : Key casting",
				nerve_cost: 5,
			},
			{
				id: 323,
				name: "Step #3 : Key melding",
				nerve_cost: 5,
			},
			{
				id: 324,
				name: "Step #4 : Key forging",
				nerve_cost: 5,
			},
			{
				id: 325,
				name: "Step #5 : Key carving",
				nerve_cost: 5,
			},
			{
				id: 326,
				name: "Step #6 : Key polishing",
				nerve_cost: 5,
			},
			{
				id: 338,
				name: "Begin Collection Bucket project",
				nerve_cost: 0,
			},
			{
				id: 339,
				name: "Step #1 : Lid drafting",
				nerve_cost: 5,
			},
			{
				id: 340,
				name: "Step #2 : Lid printing",
				nerve_cost: 5,
			},
			{
				id: 341,
				name: "Step #3 : Lid lamination",
				nerve_cost: 5,
			},
			{
				id: 342,
				name: "Step #4 : Lid assembly",
				nerve_cost: 5,
			},
			{
				id: 343,
				name: "Begin Ordination Certificate project",
				nerve_cost: 0,
			},
			{
				id: 344,
				name: "Step #1 : Ordination certificate drafting",
				nerve_cost: 5,
			},
			{
				id: 345,
				name: "Step #2 : Ordination certificate printing",
				nerve_cost: 5,
			},
			{
				id: 346,
				name: "Step #3 : Ordination certificate stamping",
				nerve_cost: 5,
			},
			{
				id: 347,
				name: "Step #4 : Ordination certificate signing",
				nerve_cost: 5,
			},
			{
				id: 348,
				name: "Step #5 : Ordination certificate framing",
				nerve_cost: 5,
			},
			{
				id: 349,
				name: "Begin Medical License project",
				nerve_cost: 0,
			},
			{
				id: 350,
				name: "Step #1 : License drafting",
				nerve_cost: 5,
			},
			{
				id: 351,
				name: "Step #2 : License printing",
				nerve_cost: 5,
			},
			{
				id: 352,
				name: "Step #3 : License branding",
				nerve_cost: 5,
			},
			{
				id: 353,
				name: "Step #4 : License gluing",
				nerve_cost: 5,
			},
			{
				id: 354,
				name: "Step #5 : License lamination",
				nerve_cost: 5,
			},
			{
				id: 395,
				name: "Step #5 : Lid Cutting",
				nerve_cost: 5,
			},
		],
	},
	{
		id: 12,
		name: "Scamming",
		subcrimes: [
			{
				id: 290,
				name: "Email Farming",
				nerve_cost: 8,
			},
			{
				id: 291,
				name: "Spam : Prize scam",
				nerve_cost: 8,
			},
			{
				id: 292,
				name: "Prize Scam",
				nerve_cost: 3,
			},
			{
				id: 293,
				name: "Spam : Family scam",
				nerve_cost: 8,
			},
			{
				id: 294,
				name: "Family Scam",
				nerve_cost: 3,
			},
			{
				id: 295,
				name: "Spam : Delivery scam",
				nerve_cost: 8,
			},
			{
				id: 296,
				name: "Delivery Scam",
				nerve_cost: 3,
			},
			{
				id: 297,
				name: "Spam : Charity scam",
				nerve_cost: 8,
			},
			{
				id: 298,
				name: "Charity Scam",
				nerve_cost: 3,
			},
			{
				id: 299,
				name: "Spam : Tech support scam",
				nerve_cost: 8,
			},
			{
				id: 300,
				name: "Tech support Scam",
				nerve_cost: 3,
			},
			{
				id: 301,
				name: "Spam : Vacation scam",
				nerve_cost: 8,
			},
			{
				id: 302,
				name: "Vacation Scam",
				nerve_cost: 3,
			},
			{
				id: 303,
				name: "Spam : Tax scam",
				nerve_cost: 8,
			},
			{
				id: 304,
				name: "Tax Scam",
				nerve_cost: 3,
			},
			{
				id: 305,
				name: "Spam : Advance-fee scam",
				nerve_cost: 8,
			},
			{
				id: 306,
				name: "Advance-fee Scam",
				nerve_cost: 3,
			},
			{
				id: 307,
				name: "Spam : Job scam",
				nerve_cost: 8,
			},
			{
				id: 308,
				name: "Job Scam",
				nerve_cost: 3,
			},
			{
				id: 309,
				name: "Spam : Romance scam",
				nerve_cost: 8,
			},
			{
				id: 310,
				name: "Romance Scam",
				nerve_cost: 3,
			},
			{
				id: 311,
				name: "Spam : Investment scam",
				nerve_cost: 8,
			},
			{
				id: 312,
				name: "Investment Scam",
				nerve_cost: 3,
			},
		],
	},
	{
		id: 13,
		name: "Arson",
		subcrimes: [
			{
				id: 328,
				name: "Inquire",
				nerve_cost: 0,
			},
			{
				id: 329,
				name: "Make Entry",
				nerve_cost: 3,
			},
			{
				id: 330,
				name: "Plant Evidence",
				nerve_cost: 5,
			},
			{
				id: 331,
				name: "Place Combustible",
				nerve_cost: 5,
			},
			{
				id: 332,
				name: "Ignite Fire",
				nerve_cost: 5,
			},
			{
				id: 333,
				name: "Stoke Fire",
				nerve_cost: 5,
			},
			{
				id: 334,
				name: "Dampen Fire",
				nerve_cost: 5,
			},
			{
				id: 335,
				name: "Collect",
				nerve_cost: 2,
			},
		],
	},
];

export function buildCrimeRulesFromDefinitions(
	definitions: CrimeDefinitionSource[] = DEFAULT_CRIME_DEFINITIONS,
): CrimeRule[] {
	const sourceDefs =
		definitions && definitions.length > 0
			? definitions
			: DEFAULT_CRIME_DEFINITIONS;

	const defMap = new Map<number, CrimeDefinitionSource>();
	for (const def of sourceDefs) {
		const numId = Number(def.id);
		if (!Number.isNaN(numId) && numId > 0) {
			defMap.set(numId, def);
		}
	}

	// Priority order: ID 13 first (Arson & Robbery), then 1 through 12, then any other IDs
	const orderedIds = [13, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
	for (const def of sourceDefs) {
		const numId = Number(def.id);
		if (!orderedIds.includes(numId) && numId > 0) {
			orderedIds.push(numId);
		}
	}

	const rules: CrimeRule[] = [];

	for (const id of orderedIds) {
		const def = defMap.get(id);
		if (!def) continue;

		const phrases = new Set<string>();

		if (def.name && typeof def.name === "string" && def.name.trim()) {
			phrases.add(def.name.trim());
		}

		if (def.subcrimes && Array.isArray(def.subcrimes)) {
			for (const sub of def.subcrimes) {
				if (sub?.name && typeof sub.name === "string" && sub.name.trim()) {
					const rawName = sub.name.trim();
					phrases.add(rawName);

					// Check if this subcrime has known synonymous log actions (e.g. "Make Entry" -> "breach")
					const synonyms = SUBCRIME_SYNONYMS[rawName.toLowerCase()];
					if (synonyms) {
						for (const syn of synonyms) {
							phrases.add(syn);
						}
					}

					// If subcrime is a project definition (e.g. "Begin License Plate project" -> "License Plate")
					if (/^begin\s+/i.test(rawName)) {
						const projectTarget = rawName
							.replace(/^begin\s+/i, "")
							.replace(/\s+project$/i, "")
							.trim();
						if (projectTarget && projectTarget.length >= 3) {
							phrases.add(projectTarget);
						}
					}

					// If subcrime contains a hyphen or colon separator
					if (rawName.includes(" - ")) {
						const parts = rawName.split(/\s+-\s+/);
						const targetPart = parts[0]?.trim();
						const actionPart = parts[1]?.trim().toLowerCase();

						if (
							targetPart &&
							(actionPart === "case" || actionPart === "burgle")
						) {
							// For Burglary targets (e.g. "Mobile Home - Case", "Mobile Home - Burgle"):
							// Combine action verb + target so bare building names don't collide with Arson on those locations.
							if (actionPart === "case") {
								phrases.add(`case ${targetPart}`);
								phrases.add(`casing ${targetPart}`);
							} else {
								phrases.add(`burgle ${targetPart}`);
								phrases.add(`burgling ${targetPart}`);
							}
						} else {
							for (const part of parts) {
								const cleanPart = part.trim();
								if (cleanPart && cleanPart.length >= 3) {
									phrases.add(cleanPart);
								}
							}
						}
					} else if (rawName.includes(":")) {
						const parts = rawName.split(/:\s+/);
						for (const part of parts) {
							const cleanPart = part.trim();
							if (cleanPart && cleanPart.length >= 3) {
								phrases.add(cleanPart);
							}
						}
					}
				}
			}
		}

		if (def.name && typeof def.name === "string" && def.name.trim()) {
			phrases.add(def.name.trim());
		}

		if (phrases.size > 0) {
			const patterns: RegExp[] = [];
			const multiWordPatterns: RegExp[] = [];
			const singleWordPatterns: RegExp[] = [];

			for (const phrase of phrases) {
				const categorized = buildCategorizedPatternsForPhrase(phrase);
				patterns.push(...categorized.all);
				multiWordPatterns.push(...categorized.multiWord);
				singleWordPatterns.push(...categorized.singleWord);
			}

			rules.push({
				id,
				patterns,
				multiWordPatterns,
				singleWordPatterns,
			});
		}
	}

	return rules;
}

export const DEFAULT_CRIME_RULES: CrimeRule[] = buildCrimeRulesFromDefinitions(
	DEFAULT_CRIME_DEFINITIONS,
);

/**
 * Maps a crime action string to its numeric Crime ID (1-13) matching Torn Crimes 2.0.
 * Prioritizes specific multi-word phrases over generic single-word verbs.
 */
export function getCrimeIdFromAction(
	action: string,
	rules?: CrimeRule[],
): number {
	const activeRules = rules !== undefined ? rules : DEFAULT_CRIME_RULES;
	const trimmed = action.trim();
	if (!trimmed || !activeRules.length) return 0;

	// Pass 1: Match multi-word / high-specificity patterns first across all rules
	for (const rule of activeRules) {
		const patterns = rule.multiWordPatterns ?? rule.patterns;
		if (patterns.some((pattern) => pattern.test(trimmed))) {
			return rule.id;
		}
	}

	// Pass 2: Fall back to single-word / broad patterns in priority order
	for (const rule of activeRules) {
		const patterns = rule.singleWordPatterns ?? [];
		if (patterns.some((pattern) => pattern.test(trimmed))) {
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
 * Extracts the market value from a Torn item payload.
 * Supports top-level `market_value`, top-level `market_price`, or nested `value.market_price`.
 */
export function extractItemMarketPrice(data: unknown): number {
	if (!data || typeof data !== "object") return 0;
	const obj = data as Record<string, unknown>;

	if (typeof obj.market_value === "number") return obj.market_value;
	if (typeof obj.market_price === "number") return obj.market_price;
	if (
		obj.value &&
		typeof obj.value === "object" &&
		typeof (obj.value as Record<string, unknown>).market_price === "number"
	) {
		return (obj.value as Record<string, unknown>).market_price as number;
	}

	return 0;
}

/**
 * Calculates net monetary value gained/lost in a crime event payload.
 * Optionally resolves item prices from an item price Map or dictionary.
 */
export function calculateCrimeLogValue(
	data: unknown,
	itemPrices?:
		| ReadonlyMap<string | number, number>
		| Readonly<Record<string | number, number>>,
): number {
	if (!data || typeof data !== "object") return 0;
	const obj = data as Record<string, unknown>;
	let total = 0;

	if (obj.money_gained) total += Number(obj.money_gained);
	if (obj.money_lost) total -= Number(obj.money_lost);

	const getItemPrice = (itemId: string | number): number => {
		if (!itemPrices) return 0;
		if (itemPrices instanceof Map) {
			return (
				itemPrices.get(itemId) ??
				itemPrices.get(String(itemId)) ??
				itemPrices.get(Number(itemId)) ??
				0
			);
		}
		const record = itemPrices as Record<string | number, number>;
		return (
			record[itemId] ?? record[String(itemId)] ?? record[Number(itemId)] ?? 0
		);
	};

	if (obj.items_gained && typeof obj.items_gained === "object") {
		for (const [itemId, qty] of Object.entries(obj.items_gained)) {
			const price = getItemPrice(itemId);
			total += Number(qty || 0) * price;
		}
	}

	if (obj.items_lost && typeof obj.items_lost === "object") {
		for (const [itemId, qty] of Object.entries(obj.items_lost)) {
			const price = getItemPrice(itemId);
			total -= Number(qty || 0) * price;
		}
	}

	return total;
}
