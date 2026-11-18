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
console.log(
	`\nOutcomes (test): target ${result.metrics.testOutcomes.target}, stop ${result.metrics.testOutcomes.stop}, timeout ${result.metrics.testOutcomes.timeout}; corporate actions ${result.corporateActions}`,
);
console.log("\nTest-slice 20-day blocks, top-5, net of 0.1% sale fee:");
for (const [label, summary] of [
	["rule only", result.metrics.ruleOnly],
	["model    ", result.metrics.withModel],
] as const) {
	console.log(
		`  ${label}: blocks ${summary.blocks}, CAGR ${(summary.cagr * 100).toFixed(1)}%, Sharpe ${summary.sharpe.toFixed(2)}, Sortino ${summary.sortino.toFixed(2)}, MaxDD ${(summary.maxDrawdown * 100).toFixed(1)}%, Calmar ${summary.calmar.toFixed(2)}, hit ${(summary.hitRate * 100).toFixed(1)}%, payoff ${summary.payoff.toFixed(2)}, turnover ${summary.turnover.toFixed(2)}, exposure ${(summary.exposure * 100).toFixed(0)}%`,
	);
}
console.log("\nBaselines (same dates and costs):");
for (const [label, summary] of Object.entries(result.metrics.baselines)) {
	console.log(
		`  ${label.padEnd(12)}: CAGR ${(summary.cagr * 100).toFixed(1)}%, Sharpe ${summary.sharpe.toFixed(2)}, MaxDD ${(summary.maxDrawdown * 100).toFixed(1)}%`,
	);
}
console.log("\nPer-fold rule vs model (20-day blocks):");
for (const fold of result.diagnostics.foldBacktests) {
	console.log(
		`  fold ${fold.index} (${fold.from}..${fold.to}): rule ${(fold.rule.cagr * 100).toFixed(1)}% / ${fold.rule.sharpe.toFixed(2)}, model ${(fold.model.cagr * 100).toFixed(1)}% / ${fold.model.sharpe.toFixed(2)}, reversal ${(fold.reversal.cagr * 100).toFixed(1)}%`,
	);
}
console.log("\nFeature IC (Pearson vs 20-day return):");
for (const feature of result.diagnostics.featureIc) {
	console.log(
		`  ${feature.name.padEnd(16)} full ${feature.full.toFixed(3)}  folds [${feature.folds.map((value) => value.toFixed(2)).join(", ")}]  holdout ${feature.holdout.toFixed(3)}`,
	);
}
const overlap = result.diagnostics.overlap;
console.log(
	`\nTop-5 overlap: ${overlap.avgShared.toFixed(1)}/5 shared names across ${overlap.blocks} blocks; avg returns shared ${overlap.sharedReturnPct.toFixed(2)}%, rule-only ${overlap.ruleOnlyReturnPct.toFixed(2)}%, model-only ${overlap.modelOnlyReturnPct.toFixed(2)}%`,
);
const uncertainty = result.metrics.uncertainty;
console.log(
	`\nUncertainty: model CAGR 95% CI [${(uncertainty.bootstrap.cagr.lower * 100).toFixed(1)}%, ${(uncertainty.bootstrap.cagr.upper * 100).toFixed(1)}%]; rule CAGR 95% CI [${(uncertainty.bootstrap.ruleCagr.lower * 100).toFixed(1)}%, ${(uncertainty.bootstrap.ruleCagr.upper * 100).toFixed(1)}%]; deflated Sharpe ${uncertainty.deflatedSharpe.toFixed(3)} (${uncertainty.deflatedSharpeTrials} trials); PBO ${uncertainty.pbo.pbo === null ? "n/a" : uncertainty.pbo.pbo.toFixed(3)}${uncertainty.pbo.reliable ? "" : " (thin sample)"}`,
);
console.log(
	`Pre-registered: ${result.preregistration.hash} / ${result.preregistration.family}; fold AUCs ${result.foldAucs.map((value) => value.toFixed(3)).join(", ")}; run ${result.runId ?? "n/a"}`,
);
console.log("\nGates:", result.gates);
if (!flags.activate) {
	console.log(
		"\nReport only. Re-run with --activate to store the model (shadow mode).",
	);
}

await closeDatabase();
