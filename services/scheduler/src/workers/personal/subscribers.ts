import { isOilRigEnabled, Logger } from "@sentinel/utils";

import { startCapitalFills } from "../capital/fills";
import { startCapitalPayments } from "../capital/payments";
import { startBattlestatsLedger } from "./battlestats";
import { startCompanySync } from "./company";
import { startCrimesLedger } from "./crimes";
import { startOilRigCollector } from "./oil-rig";
import { startStocksLedger } from "./stocks";

const logger = new Logger("Scheduler", "PersonalSubscribers");

/**
 * Attaches real-time event listeners for personal log streams (crimes, battlestats, stocks, company).
 * Invoked once during scheduler startup before background workers are staggered.
 *
 * The company and oil-rig collectors are gated behind `isOilRigEnabled()`: the
 * company was sold, and those subscribers would otherwise keep calling
 * /company and sending director briefings on every detected company pay tick.
 */
export function registerPersonalLogSubscribers(): void {
	startCrimesLedger();
	startBattlestatsLedger();
	startStocksLedger();
	if (isOilRigEnabled()) {
		startCompanySync();
		startOilRigCollector();
	} else {
		logger.warn(
			"Oil rig feature disabled (OIL_RIG_ENABLED unset). Skipping company sync and oil-rig collectors.",
		);
	}
	startCapitalPayments();
	startCapitalFills();
}
