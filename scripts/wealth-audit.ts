/**
 * Wealth Ledger Audit — a read-only classification report over real logs.
 * ----------------------------------------------------------------------
 * Replays the account's own `personal_logs` through the wealth engine and reports
 * what the classifier made of every log type. It writes nothing: this is the tool
 * that answers "is the rule table actually right?" from evidence rather than from
 * opinion.
 *
 * WHY IT EXISTS
 *
 * The rule table in `packages/utils/src/wealth-rules.ts` is derived from payloads
 * captured off the live account. Every rule that was proved that way carries an
 * `evidence` string, and the ones that could not be proved are marked
 * `priced: false` instead of being guessed at. This script is how the remainder
 * gets resolved: run it, read the three reports, and promote anything unresolved
 * into a rule with its proving log.
 *
 * USAGE
 *   Full report over every log ever recorded:
 *     bun run scripts/wealth-audit.ts
 *
 *   Just the log types with no rule:
 *     bun run scripts/wealth-audit.ts --only unknown
 *
 *   Just the amounts that could not be established:
 *     bun run scripts/wealth-audit.ts --only unpriced
 *
 *   A window, for checking a rule that only fires recently:
 *     bun run scripts/wealth-audit.ts --since 2026-09-01
 *
 *   Print one raw payload per log type, to write a new rule from:
 *     bun run scripts/wealth-audit.ts --only unknown --samples
 *
 * WHAT THE THREE REPORTS MEAN
 *
 *   1. THE TOTALS say what the ledger would hold if these rules ran over the
 *      whole history. Cash flow and net-worth change are reported separately,
 *      because a vault deposit moves the first and not the second.
 *
 *   2. UNPRICED says which events the ledger recorded but could not put a
 *      trustworthy number on, and how much movement rides on them. An event
 *      belongs here either because its rule says so (a points refill spends
 *      points, a faction transfer is logged twice) or because an item it moved
 *      has no market price.
 *
 *   3. UNKNOWN says which log types had no rule and no band. Anything listed here
 *      is a log type the ledger can only count, never value — the shortest path to
 *      a wrong total, and the one report that should always be empty.
 *
 *   4. THE SUSPECT LIST is the one that catches mistakes rather than gaps: a log
 *      type whose payload clearly carries an amount that its rule recorded as
 *      zero. That is a rule that fires and looks confident while doing nothing.
 */

import {
	and,
	closeDatabase,
	db,
	eq,
	gte,
	personalLogs,
	systemStates,
	tornItems,
} from "../packages/database";
import {
	classifyWealthLog,
	extractItemMarketPrice,
	getWealthBand,
	getWealthRule,
	readNumber,
	WEALTH_LOG_RULES,
	WEALTH_VALUE_KEYS,
	type WealthLogRow,
} from "../packages/utils";

type Args = {
	since: Date | null;
	only: "all" | "unknown" | "unpriced" | "suspect";
	samples: boolean;
};

function parseArgs(argv: string[]): Args {
	const args: Args = { since: null, only: "all", samples: false };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--since") {
			const value = argv[index + 1];
			if (value) {
				const parsed = new Date(value);
				if (!Number.isNaN(parsed.getTime())) args.since = parsed;
				index += 1;
			}
		} else if (flag === "--only") {
			const value = argv[index + 1];
			if (
				value === "unknown" ||
				value === "unpriced" ||
				value === "suspect" ||
				value === "all"
			) {
				args.only = value;
				index += 1;
			}
		} else if (flag === "--samples") {
			args.samples = true;
		}
	}
	return args;
}

function money(value: number): string {
	const sign = value < 0 ? "-" : "";
	return `${sign}$${Math.abs(Math.round(value)).toLocaleString("en-US")}`;
}

async function loadItemPrices(): Promise<Map<string, number>> {
	const rows = await db
		.select({ id: tornItems.id, data: tornItems.data })
		.from(tornItems);
	const prices = new Map<string, number>();
	for (const row of rows) {
		const price = extractItemMarketPrice(row.data);
		if (price > 0) prices.set(row.id, price);
	}
	return prices;
}

type TypeReport = {
	logType: number;
	label: string;
	category: string;
	count: number;
	walletNet: number;
	accountNet: number;
	netWorth: number;
	priced: number;
	unpriced: number;
	/** Absolute net-worth movement riding on events that are not fully priced. */
	unpricedMovement: number;
	unknownType: boolean;
	mirrored: number;
	hasRule: boolean;
	moneyLikeKeys: string[];
	sample: Record<string, unknown>;
};

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const where = args.since
		? and(gte(personalLogs.timestamp, args.since))
		: undefined;

	console.log("Loading personal logs...");
	const rows = await db
		.select({
			id: personalLogs.id,
			log: personalLogs.log,
			title: personalLogs.title,
			timestamp: personalLogs.timestamp,
			data: personalLogs.data,
		})
		.from(personalLogs)
		.where(where)
		.orderBy(personalLogs.timestamp);

	console.log(`Loaded ${rows.length.toLocaleString("en-US")} logs.`);
	if (rows.length === 0) {
		console.log("Nothing to audit.");
		await closeDatabase();
		return;
	}

	console.log("Loading item market prices...");
	const prices = await loadItemPrices();

	// The same daily figure the worker and the stocks ledger read, so the audit
	// values points exactly as the ledger will.
	const [pointsState] = await db
		.select({ data: systemStates.data })
		.from(systemStates)
		.where(eq(systemStates.id, "points_market_price"))
		.limit(1);
	const pointsPrice =
		pointsState?.data && typeof pointsState.data === "object"
			? readNumber((pointsState.data as Record<string, unknown>).price)
			: null;
	const unitRates = new Map<string, number>();
	if (pointsPrice !== null && pointsPrice > 0) {
		unitRates.set("points", pointsPrice);
	}
	console.log(
		`Points priced at ${pointsPrice !== null && pointsPrice > 0 ? `$${pointsPrice.toLocaleString("en-US")}` : "UNPRICED (no reference sync yet)"}.\n`,
	);
	console.log(
		`Priced ${prices.size} items (of ${(await db.select({ id: tornItems.id }).from(tornItems)).length}).\n`,
	);

	const byType = new Map<number, TypeReport>();
	let eventCount = 0;
	let walletNet = 0;
	let accountNet = 0;
	let netWorthTotal = 0;
	let unpricedEvents = 0;
	let unpricedNetWorth = 0;

	for (const row of rows) {
		const wealthRow: WealthLogRow = {
			id: row.id,
			log: row.log,
			title: row.title,
			timestamp: row.timestamp,
			data: row.data,
		};
		const event = classifyWealthLog(wealthRow, {
			itemPrices: prices,
			unitRates,
		});

		const report =
			byType.get(event?.logType ?? row.log) ??
			({
				logType: event?.logType ?? row.log,
				label: event?.label ?? row.title ?? "unknown",
				category: event?.category ?? "other",
				count: 0,
				walletNet: 0,
				accountNet: 0,
				netWorth: 0,
				priced: 0,
				unpriced: 0,
				unpricedMovement: 0,
				unknownType: event?.unknownType ?? true,
				mirrored: 0,
				hasRule: getWealthRule(event?.logType ?? row.log) !== null,
				moneyLikeKeys: [],
				sample: {},
			} satisfies TypeReport);

		report.count += 1;
		if (!event) {
			byType.set(row.log, report);
			continue;
		}
		if (event.mirrored) report.mirrored += 1;

		report.walletNet += event.walletDelta;
		report.accountNet += event.accountDelta;
		report.netWorth += event.netWorthDelta;
		if (event.priced) report.priced += 1;
		else {
			report.unpriced += 1;
			report.unpricedMovement += Math.abs(event.netWorthDelta);
		}

		// Remember one payload and the value-bearing fields it holds, so a rule can
		// be written from the report without going back to the database.
		if (Object.keys(report.sample).length === 0) {
			const payload = (row.data as Record<string, unknown> | null)?.data;
			if (payload && typeof payload === "object" && !Array.isArray(payload)) {
				const record = payload as Record<string, unknown>;
				report.sample = record;
				report.moneyLikeKeys = WEALTH_VALUE_KEYS.filter((key) => {
					const value = record[key];
					if (value === undefined) return false;
					// An item field counts whether or not it is numeric; a money field
					// counts when it resolves to a number.
					if (readNumber(value) !== null) return true;
					return Array.isArray(value) || typeof value === "object";
				});
			}
		}

		byType.set(event.logType, report);

		if (event.mirrored) continue;
		eventCount += 1;
		walletNet += event.walletDelta;
		accountNet += event.accountDelta;
		netWorthTotal += event.netWorthDelta;
		if (!event.priced) {
			unpricedEvents += 1;
			unpricedNetWorth += event.netWorthDelta;
		}
	}

	const reports = [...byType.values()].sort((a, b) => b.count - a.count);

	console.log("=".repeat(78));
	console.log("WEALTH LEDGER AUDIT");
	console.log("=".repeat(78));
	console.log(`Rules in the table          ${WEALTH_LOG_RULES.length}`);
	console.log(`Log types seen              ${reports.length}`);
	console.log(
		`Events classified           ${eventCount.toLocaleString("en-US")}`,
	);
	console.log(`Wallet cash flow            ${money(walletNet)}`);
	console.log(`Account movement            ${money(accountNet)}`);
	console.log(`Net worth change            ${money(netWorthTotal)}`);
	console.log(
		`Events not fully priced     ${unpricedEvents.toLocaleString("en-US")} (${money(unpricedNetWorth)} of movement)`,
	);

	const unknown = reports.filter((report) => report.unknownType);
	const unpriced = reports.filter((report) => report.unpriced > 0);

	/**
	 * A rule that names no amount at all, on a payload that clearly has one, and
	 * which nobody has yet written down a reason for.
	 *
	 * This is the report that catches mistakes rather than gaps. A rule which
	 * deliberately books nothing — a bazaar listing's aspirational `price`, a trade
	 * draft's edit, a mirrored faction row, a poker chip moving inside the table —
	 * says so in `evidence`. A rule that should move money and silently does not
	 * looks identical in the totals, and carries no evidence, which is exactly how
	 * the wallet and stash box consumables and the mugging victim's log were found.
	 */
	const suspects = reports.filter((report) => {
		if (report.moneyLikeKeys.length === 0) return false;
		const rule = getWealthRule(report.logType);
		if (!rule) return false;
		// `units` counts too: a rule that books points, tokens or ammo is moving
		// something, whether or not it touches the wallet.
		const declaresMoney =
			rule.wallet !== undefined ||
			rule.account !== undefined ||
			rule.itemsIn !== undefined ||
			rule.itemsOut !== undefined ||
			rule.units !== undefined;
		const reviewed = rule.evidence !== undefined && rule.evidence.length > 0;
		return !declaresMoney && !reviewed;
	});

	console.log(`\nLog types with no rule      ${unknown.length}`);
	if (unknown.length > 0) {
		console.log(
			"  These are counted but never valued, which is the fastest way to",
		);
		console.log("  a wrong total. Each needs a rule and a proving payload.\n");
		for (const report of unknown.slice(0, 40)) {
			console.log(
				`  ${String(report.logType).padStart(6)}  ${report.count.toLocaleString("en-US").padStart(8)}  ${report.label}`,
			);
		}
		if (unknown.length > 40) {
			console.log(`  ... and ${unknown.length - 40} more.`);
		}
	}

	if (args.only === "all" || args.only === "unpriced") {
		console.log(`\nLog types with unpriced events  ${unpriced.length}`);
		console.log(
			"  Recorded, flagged, and excluded from the totals. Either the rule says",
		);
		console.log(
			"  the amount is unprovable, or an item moved that has no market price.\n",
		);
		// Sorted by how much money is riding on the gap rather than by how many
		// events are in it: 4,000 unreadable faction notices matter less than a
		// hundred million dollars that no rule could value.
		for (const report of unpriced
			.sort((a, b) => b.unpricedMovement - a.unpricedMovement)
			.slice(0, 40)) {
			console.log(
				`  ${String(report.logType).padStart(6)}  ${money(report.unpricedMovement).padStart(16)}  ${String(report.unpriced).padStart(8)} unpriced of ${String(report.count).padStart(8)}  ${report.label}`,
			);
		}
	}

	if (args.only === "all" || args.only === "suspect") {
		console.log(
			`\nSUSPECT: fires, carries an amount, records zero  ${suspects.length}`,
		);
		if (suspects.length === 0) {
			console.log(
				"  None. Every rule with a money-shaped payload moved something.",
			);
		} else {
			console.log("  A rule that looks confident while doing nothing:\n");
			for (const report of suspects) {
				console.log(
					`  ${String(report.logType).padStart(6)}  ${report.count.toLocaleString("en-US").padStart(8)}  ${report.label}  [${report.category}]`,
				);
				console.log(
					`          keys present: ${report.moneyLikeKeys.join(", ")}`,
				);
				console.log(`          payload: ${JSON.stringify(report.sample)}`);
			}
		}
	}

	if (args.samples && unknown.length > 0) {
		console.log(`\n${"=".repeat(78)}`);
		console.log("RAW PAYLOADS FOR UNKNOWN LOG TYPES");
		console.log("=".repeat(78));
		for (const report of unknown) {
			console.log(
				`\nlog ${report.logType}  (${report.count.toLocaleString("en-US")} events)`,
			);
			console.log(
				`  band category: ${getWealthBand(report.logType)?.category ?? "none"}`,
			);
			console.log(`  payload: ${JSON.stringify(report.sample)}`);
		}
	}

	if (args.only === "all") {
		console.log(`\n${"=".repeat(78)}`);
		console.log("TOP LOG TYPES BY NET WORTH MOVEMENT");
		console.log("=".repeat(78));
		for (const report of [...reports]
			.sort((a, b) => Math.abs(b.netWorth) - Math.abs(a.netWorth))
			.slice(0, 25)) {
			console.log(
				`  ${String(report.logType).padStart(6)}  ${money(report.netWorth).padStart(22)}  ${report.count.toLocaleString("en-US").padStart(9)} events  ${report.label}`,
			);
		}
	}

	console.log("\nNo rows were written. This report is read-only.");
	await closeDatabase();
}

main().catch(async (error) => {
	console.error("Audit failed:", error);
	await closeDatabase();
	process.exit(1);
});
