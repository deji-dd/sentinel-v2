/**
 * Train the capital meta-label model (operator command).
 *
 * The `capital:ml:train` scheduler worker retrains monthly, so this command is
 * only for an immediate run or an experiment.
 *
 * USAGE
 *   bun run capital:ml:train            # report only
 *   bun run capital:ml:train --activate # store it for shadow logging
 *   bun run capital:ml:train --l2=1 --min-auc=0.55
 */
import { closeDatabase } from "../packages/database";
import { trainCapitalMlModel } from "../services/scheduler/src/lib/capital-ml-train";

function parseFlags(argv: string[]) {
	const flags = new Map<string, string | true>();
	for (const arg of argv) {
		if (!arg.startsWith("--")) continue;
		const [key, value] = arg.slice(2).split("=");
		flags.set(key ?? "", value ?? true);
	}
	return {
		activate: flags.has("activate"),
		l2: Number(flags.get("l2") ?? 1),
		minAuc: Number(flags.get("min-auc") ?? 0.55),
		force: flags.has("force"),
	};
}

const flags = parseFlags(process.argv.slice(2));
const result = await trainCapitalMlModel({
	activate: flags.activate,
	minAuc: flags.minAuc,
	force: flags.force,
	onProgress: (line) => console.log(line),
});

console.log("\nCalibration (test):");
for (const bucket of result.metrics.calibration) {
	if (bucket.count === 0) continue;
	console.log(
		`  p ${bucket.lower.toFixed(1)}-${bucket.upper.toFixed(1)}: predicted ${(
			bucket.meanProbability * 100
		).toFixed(
			1,
		)}% observed ${(bucket.observedRate * 100).toFixed(1)}% (n=${bucket.count})`,
	);
}
console.log("\nTest-slice 20-day blocks, top-5, 0.1% fee:");
for (const [label, summary] of [
	["rule only", result.metrics.ruleOnly],
	["model    ", result.metrics.withModel],
] as const) {
	console.log(
		`  ${label}: blocks ${summary.blocks}, CAGR ${(summary.cagr * 100).toFixed(1)}%, Sharpe ${summary.sharpe.toFixed(2)}, MaxDD ${(summary.maxDrawdown * 100).toFixed(1)}%`,
	);
}
console.log("\nGates:", result.gates);
if (!flags.activate) {
	console.log(
		"\nReport only. Re-run with --activate to store the model (shadow mode).",
	);
}

await closeDatabase();
