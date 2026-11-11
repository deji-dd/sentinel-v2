/**
 * Torn stock history backfill (operator command).
 *
 * The scheduler seeds itself on boot via the `capital:history` worker; this
 * command exists for larger one-off windows (e.g. years of minute bars), for a
 * dry run, and for anchor validation.
 *
 * USAGE
 *   bun run stocks:backfill                       # daily + hourly, full history
 *   bun run stocks:backfill --intervals=d1,h1,m1 --m1-days=365
 *   bun run stocks:backfill --stocks=TSB,TCI,LAG  # subset
 *   bun run stocks:backfill --dry-run
 *   bun run stocks:backfill --strict              # fail on anchor mismatch
 *   bun run stocks:backfill --validate-only
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
	type BackfillInterval,
	capitalHistoryReadiness,
	describeReadiness,
	fetchTornStocks,
	seedCapitalHistory,
	validateStockAnchors,
} from "../services/scheduler/src/lib/capital-history";

function resolveSetting(key: string): string | undefined {
	const fromEnv = process.env[key];
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	for (const file of [".env.development", ".env.production", ".env"]) {
		const path = resolve(process.cwd(), file);
		if (!existsSync(path)) continue;
		const match = readFileSync(path, "utf-8").match(
			new RegExp(`^${key}=["']?([^"'\\r\\n]+)["']?`, "m"),
		);
		if (match?.[1]) return match[1].trim();
	}
	return undefined;
}

const VALID_INTERVALS: BackfillInterval[] = ["d1", "h1", "m1"];

function parseArgs(argv: string[]) {
	const flags = new Map<string, string | true>();
	for (const arg of argv) {
		if (!arg.startsWith("--")) continue;
		const [rawKey, rawValue] = arg.slice(2).split("=");
		flags.set(rawKey ?? "", rawValue ?? true);
	}
	const intervalsRaw = String(flags.get("intervals") ?? "d1,h1");
	const intervals = intervalsRaw
		.split(",")
		.map((value) => value.trim())
		.filter((value): value is BackfillInterval =>
			VALID_INTERVALS.includes(value as BackfillInterval),
		);
	if (intervals.length === 0) {
		throw new Error("No valid intervals. Use d1, h1, m1.");
	}
	const m1Days = Number(flags.get("m1-days") ?? 365);
	if (!Number.isFinite(m1Days) || m1Days <= 0) {
		throw new Error("--m1-days must be a positive number.");
	}
	const from = flags.get("from");
	const stocksFlag = flags.get("stocks");
	return {
		intervals,
		m1Days,
		stocks:
			typeof stocksFlag === "string"
				? stocksFlag
						.split(",")
						.map((value) => value.trim().toUpperCase())
						.filter(Boolean)
				: null,
		fromTs:
			typeof from === "string"
				? Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000)
				: undefined,
		dryRun: flags.has("dry-run"),
		strict: flags.has("strict"),
		validateOnly: flags.has("validate-only"),
	};
}

async function main(): Promise<void> {
	const apiKey = resolveSetting("TORN_API_KEY");
	if (!apiKey) {
		throw new Error(
			"TORN_API_KEY is required (environment or .env.development). It is only used for the stock list and validation anchors.",
		);
	}
	const options = parseArgs(process.argv.slice(2));
	const allStocks = await fetchTornStocks(apiKey);
	const stocks = options.stocks
		? allStocks.filter((stock) => options.stocks?.includes(stock.acronym))
		: allStocks;

	if (options.validateOnly) {
		console.log("Validating stored daily candles against Torn anchors...\n");
		let failures = 0;
		for (const stock of stocks) {
			const result = await validateStockAnchors(apiKey, stock, options.strict);
			if (result.startsWith("MISMATCH")) failures += 1;
			console.log(`${stock.acronym.padEnd(4)} ${result}`);
		}
		console.log(
			`\n${stocks.length - failures}/${stocks.length} stocks match Torn's anchors.`,
		);
		return;
	}

	const before = await capitalHistoryReadiness();
	console.log(
		`Backfilling ${stocks.length} stocks: ${options.intervals.join(", ")}${
			options.dryRun ? " (dry run)" : ""
		}`,
	);
	console.log(`Before: ${describeReadiness(before)}\n`);

	const result = await seedCapitalHistory({
		...options,
		tornApiKey: apiKey,
		fromTs: options.fromTs,
		onProgress: (line) => console.log(line),
	});
	const after = await capitalHistoryReadiness();
	console.log(
		`\nDone in ${Math.round(result.elapsedMs / 1000)}s. ${result.inserted.toLocaleString()} rows written.`,
	);
	console.log(`After: ${describeReadiness(after)}`);
	if (result.partial)
		console.log("Partial run (deadline hit); re-run to continue.");
	if (options.dryRun) console.log("Dry run: nothing was persisted.");
}

main()
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	})
	.finally(() => process.exit(process.exitCode ?? 0));
