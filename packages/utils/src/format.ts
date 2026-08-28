/**
 * Formats a duration in milliseconds into a human-readable string (ms, s, m, h, d).
 *
 * Examples:
 * - 45 -> "45ms"
 * - 1250 -> "1s 250ms"
 * - 65000 -> "1m 5s"
 * - 3665000 -> "1h 1m"
 */
export function formatDuration(ms: number): string {
	if (Number.isNaN(ms) || ms < 0) ms = 0;
	ms = Math.round(ms);

	if (ms < 1000) {
		return `${ms}ms`;
	}

	const seconds = Math.floor(ms / 1000);
	const remainingMs = ms % 1000;

	if (seconds < 60) {
		return remainingMs > 0 ? `${seconds}s ${remainingMs}ms` : `${seconds}s`;
	}

	const minutes = Math.floor(seconds / 60);
	const remainingSec = seconds % 60;

	if (minutes < 60) {
		const secStr = remainingSec > 0 ? ` ${remainingSec}s` : "";
		return `${minutes}m${secStr}`;
	}

	const hours = Math.floor(minutes / 60);
	const remainingMin = minutes % 60;

	if (hours < 24) {
		const minStr = remainingMin > 0 ? ` ${remainingMin}m` : "";
		return `${hours}h${minStr}`;
	}

	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	const hrStr = remainingHours > 0 ? ` ${remainingHours}h` : "";
	return `${days}d${hrStr}`;
}

/**
 * Compact number formatting with B / M / k suffix.
 *
 * Examples:
 * - 1500000000 -> "1.50B"
 * - 2400000 -> "2.40M"
 * - 15200 -> "15.2k"
 * - 450 -> "450"
 */
export function formatNumber(amount: number): string {
	if (Number.isNaN(amount)) return "0";
	if (Math.abs(amount) >= 1_000_000_000) {
		return `${(amount / 1_000_000_000).toFixed(2)}B`;
	}
	if (Math.abs(amount) >= 1_000_000) {
		return `${(amount / 1_000_000).toFixed(2)}M`;
	}
	if (Math.abs(amount) >= 1_000) {
		return `${(amount / 1_000).toFixed(1)}k`;
	}
	return new Intl.NumberFormat("en-US", {
		maximumFractionDigits: 2,
	}).format(amount);
}

/**
 * Decimal number formatting with custom precision and thousands separators.
 *
 * Examples:
 * - 2834.21 -> "2,834.21"
 * - 45000 -> "45,000.00"
 */
export function formatDecimal(amount: number, decimals = 2): string {
	if (Number.isNaN(amount) || amount === null || amount === undefined) {
		return "0.00";
	}
	return new Intl.NumberFormat("en-US", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	}).format(amount);
}

/**
 * Formats a currency value with dollar sign and commas.
 *
 * Examples:
 * - 1500000 -> "$1,500,000"
 * - 45.5 -> "$45.50"
 */
export function formatCurrency(amount: number, decimals = 0): string {
	if (Number.isNaN(amount) || amount === null || amount === undefined) {
		return "$0";
	}
	return `$${new Intl.NumberFormat("en-US", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	}).format(amount)}`;
}

/**
 * Formats a timestamp / date into a human-readable relative time string.
 *
 * Examples:
 * - 5s ago -> "5s ago"
 * - 120s ago -> "2m ago"
 * - 7200s ago -> "2h ago"
 */
export function formatRelativeTime(
	dateInput: string | number | Date | null | undefined,
): string {
	if (!dateInput) return "Never";
	const timestamp =
		typeof dateInput === "number"
			? dateInput > 1e11
				? dateInput
				: dateInput * 1000
			: dateInput instanceof Date
				? dateInput.getTime()
				: new Date(dateInput).getTime();
	if (Number.isNaN(timestamp)) return "Invalid Date";

	const diffSeconds = Math.floor((Date.now() - timestamp) / 1000);
	if (diffSeconds < 5) return "Just now";
	if (diffSeconds < 60) return `${diffSeconds}s ago`;
	if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
	if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
	return `${Math.floor(diffSeconds / 86400)}d ago`;
}

/**
 * Formats a date / timestamp into a standardized UTC date-time string.
 *
 * Example:
 * - 1787272942 -> "Aug 25, 2026, 09:42:13 AM UTC"
 */
export function formatDate(
	dateInput: string | number | Date | null | undefined,
): string {
	if (!dateInput) return "N/A";
	const timestamp =
		typeof dateInput === "number"
			? dateInput > 1e11
				? dateInput
				: dateInput * 1000
			: dateInput instanceof Date
				? dateInput.getTime()
				: new Date(dateInput).getTime();
	if (Number.isNaN(timestamp)) return "N/A";

	return new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZone: "UTC",
		timeZoneName: "short",
	}).format(new Date(timestamp));
}
