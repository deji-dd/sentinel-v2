export const ALLOWED_GIVEAWAY_CATEGORIES = [
	"Supply Pack",
	"Artifact",
	"Flower",
	"Booster",
	"Candy",
	"Medical",
	"Alcohol",
	"Jewelry",
	"Plushie",
	"Drug",
	"Energy Drink",
] as const;

export type AllowedGiveawayCategory =
	(typeof ALLOWED_GIVEAWAY_CATEGORIES)[number];

export const ALLOWED_GIVEAWAY_CATEGORIES_SET: ReadonlySet<string> = new Set(
	ALLOWED_GIVEAWAY_CATEGORIES,
);

/**
 * Parses human duration string into milliseconds.
 * Supports combinations like "1d", "12h", "30m", "45s", "1d 12h", "2h 30m 10s".
 * Returns null if string is invalid or yields 0ms.
 */
export function parseDuration(input: string): number | null {
	if (!input || typeof input !== "string") return null;

	const trimmed = input.trim().toLowerCase();
	if (!trimmed) return null;

	// Matches parts like "1d", "12 h", "30m", "45 s"
	const tokenRegex = /(\d+)\s*([dhms])/g;
	let totalMs = 0;
	let matchCount = 0;

	let match: RegExpExecArray | null = tokenRegex.exec(trimmed);
	while (match !== null) {
		const rawVal = match[1];
		const unit = match[2];
		if (!rawVal || !unit) return null;

		const value = Number.parseInt(rawVal, 10);
		if (Number.isNaN(value) || value < 0) return null;

		switch (unit) {
			case "d":
				totalMs += value * 86_400_000;
				break;
			case "h":
				totalMs += value * 3_600_000;
				break;
			case "m":
				totalMs += value * 60_000;
				break;
			case "s":
				totalMs += value * 1_000;
				break;
			default:
				return null;
		}

		matchCount++;
		match = tokenRegex.exec(trimmed);
	}

	// If no valid tokens were found or string contained unparsed junk
	if (matchCount === 0) return null;

	// Ensure there isn't unrecognized trailing or isolated text
	const cleaned = trimmed.replace(/(\d+)\s*([dhms])/g, "").trim();
	if (cleaned.length > 0) return null;

	return totalMs > 0 ? totalMs : null;
}

/**
 * Formats a duration in ms to human-readable string.
 */
export function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";

	const seconds = Math.floor(ms / 1000) % 60;
	const minutes = Math.floor(ms / (1000 * 60)) % 60;
	const hours = Math.floor(ms / (1000 * 60 * 60)) % 24;
	const days = Math.floor(ms / (1000 * 60 * 60 * 24));

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

	return parts.join(" ");
}

/**
 * Paginates an array of items for Discord Select Menus (max 25 items per menu).
 */
export function paginateItems<T>(
	items: T[],
	page: number,
	pageSize = 25,
): {
	items: T[];
	currentPage: number;
	totalPages: number;
	hasNext: boolean;
	hasPrev: boolean;
} {
	const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
	const currentPage = Math.min(Math.max(1, page), totalPages);
	const startIndex = (currentPage - 1) * pageSize;
	const paginatedItems = items.slice(startIndex, startIndex + pageSize);

	return {
		items: paginatedItems,
		currentPage,
		totalPages,
		hasNext: currentPage < totalPages,
		hasPrev: currentPage > 1,
	};
}

/**
 * Picks N unique random winners from an array of entries.
 */
export function pickRandomWinners<T>(entries: T[], winnerCount: number): T[] {
	if (entries.length === 0 || winnerCount <= 0) return [];
	if (entries.length <= winnerCount) {
		return [...entries];
	}

	const pool = [...entries];
	const selected: T[] = [];

	for (let i = 0; i < winnerCount && pool.length > 0; i++) {
		const randomIndex = Math.floor(Math.random() * pool.length);
		const chosen = pool[randomIndex];
		if (chosen !== undefined) {
			selected.push(chosen);
			// Swap and pop for O(1) removal
			const last = pool[pool.length - 1];
			if (last !== undefined) {
				pool[randomIndex] = last;
			}
			pool.pop();
		}
	}

	return selected;
}
