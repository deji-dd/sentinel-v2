/**
 * Formats a duration in milliseconds into a human-readable string (ms, s, m, h, d).
 * Automatically formats into ms/s/m/h/d cleanly.
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
