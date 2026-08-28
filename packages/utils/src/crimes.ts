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
export function buildCrimeRulesFromDefinitions(
	definitions: CrimeDefinitionSource[],
): CrimeRule[] {
	const defMap = new Map<number, CrimeDefinitionSource>();
	for (const def of definitions) {
		const numId = Number(def.id);
		if (!Number.isNaN(numId) && numId > 0) {
			defMap.set(numId, def);
		}
	}

	// Priority order: ID 13 first (Arson & Robbery), then 1 through 12, then any other IDs
	const orderedIds = [13, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
	for (const def of definitions) {
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

/**
 * Maps a crime action string to its numeric Crime ID (1-13) matching Torn Crimes 2.0.
 * Prioritizes specific multi-word phrases over generic single-word verbs.
 */
export function getCrimeIdFromAction(
	action: string,
	rules: CrimeRule[] = [],
): number {
	const trimmed = action.trim();
	if (!trimmed || !rules.length) return 0;

	// Pass 1: Match multi-word / high-specificity patterns first across all rules
	for (const rule of rules) {
		const patterns = rule.multiWordPatterns ?? rule.patterns;
		if (patterns.some((pattern) => pattern.test(trimmed))) {
			return rule.id;
		}
	}

	// Pass 2: Fall back to single-word / broad patterns in priority order
	for (const rule of rules) {
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
