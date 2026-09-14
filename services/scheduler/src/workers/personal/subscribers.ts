import { startBattlestatsLedger } from "./battlestats";
import { startCompanySync } from "./company";
import { startCrimesLedger } from "./crimes";
import { startStocksLedger } from "./stocks";

/**
 * Attaches real-time event listeners for personal log streams (crimes, battlestats, stocks, company).
 * Invoked once during scheduler startup before background workers are staggered.
 */
export function registerPersonalLogSubscribers(): void {
	startCrimesLedger();
	startBattlestatsLedger();
	startStocksLedger();
	startCompanySync();
}
