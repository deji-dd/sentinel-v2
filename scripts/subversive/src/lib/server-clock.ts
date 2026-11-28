/**
 * Offset between the browser clock and the Sentinel API clock.
 *
 * Hospital / war countdowns are derived from absolute server (Torn) timestamps.
 * If a user's machine clock is skewed, every timer shifts by the same amount —
 * one user seeing all timers 30s late is exactly that. Any API response that
 * carries `serverTime` lets us measure and correct the skew.
 *
 * We use the receive time as the client reference rather than the round-trip
 * midpoint: war-events long polls are held open for up to 25s and the server
 * stamps `serverTime` when it actually emits the payload, so a midpoint would
 * introduce a much larger error than a normal sub-second request latency.
 */
let offsetMs = 0;

export function observeServerTime(serverTimeMs: number): void {
	if (!Number.isFinite(serverTimeMs)) return;
	offsetMs = serverTimeMs - Date.now();
}

/** Wall-clock time in ms, corrected to the API clock. */
export function serverNowMs(): number {
	return Date.now() + offsetMs;
}

/** Wall-clock time in whole seconds, corrected to the API clock. */
export function serverNowSec(): number {
	return Math.floor(serverNowMs() / 1000);
}
