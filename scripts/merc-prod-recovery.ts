/**
 * Merc Contract System — Prod Recovery Script
 * -------------------------------------------
 * Repairs rows left in a broken state by the merc contract incident:
 *
 *   1. start_time back-dated before war_start by the "minutes before war" offset,
 *      which caused target alerts to populate before the contract started.
 *   2. Stale `merc:attack_validator:%` watermarks that were advanced past
 *      discarded attacks, preventing the current contract from back-filling.
 *   3. Contracts stuck in 'paused' with an open pause window, which would
 *      permanently exclude every subsequent hit from payout.
 *
 * Schema changes are NOT handled here — those are Drizzle migrations that run
 * during deploy. Run this AFTER the deployment containing the merc fixes.
 *
 * USAGE
 *   Preview (default, no writes):
 *     bun run merc:recover
 *
 *   Apply changes:
 *     bun run merc:recover --apply
 *
 * This uses the application's own database connection (`sqlClient`), so it
 * runs from the same environment as the services. No psql required.
 */

import { closeDatabase, sqlClient } from "../packages/database";

const APPLY = process.argv.includes("--apply");

const BACKUP_CONTRACTS = "merc_contracts_recovery_backup";
const BACKUP_STATES = "system_states_recovery_backup";

function banner(mode: "DRY RUN" | "APPLY") {
	const line = "=".repeat(64);
	console.log(`\n${line}`);
	console.log(`  Merc Contract Prod Recovery — ${mode}`);
	console.log(line);
	if (mode === "DRY RUN") {
		console.log("  No writes will be made. Re-run with --apply to execute.");
	} else {
		console.log("  This WILL modify rows in merc_contracts and system_states.");
	}
	console.log(`${line}\n`);
}

function section(title: string) {
	console.log(`\n--- ${title} ${"-".repeat(Math.max(0, 60 - title.length))}`);
}

/**
 * Prints a table only when there are rows, so empty result sets render as a
 * plain message instead of an empty grid.
 */
function printRows<T>(rows: T[], emptyMessage: string) {
	if (rows.length === 0) {
		console.log(`  ${emptyMessage}`);
		return;
	}
	console.table(rows);
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

async function diagnose() {
	section("Live / upcoming / paused contracts");
	const contracts = await sqlClient`
		SELECT id, faction_name, status, start_time, war_start,
		       start_minutes_before_war, paused_windows
		FROM merc_contracts
		WHERE status IN ('active', 'upcoming', 'paused')
		ORDER BY created_at DESC
	`;
	printRows(contracts, "None — no live contracts.");

	section("Contracts with start_time before war_start (the 5-min-early bug)");
	const backdated = await sqlClient`
		SELECT id, faction_name, status, start_time, war_start,
		       start_minutes_before_war AS lead_minutes
		FROM merc_contracts
		WHERE war_start IS NOT NULL
		  AND status IN ('active', 'upcoming')
		  AND start_time < war_start
	`;
	printRows(backdated, "None — no start times need re-anchoring.");

	section("Attack validator watermarks");
	const watermarks = await sqlClient`
		SELECT id, data
		FROM system_states
		WHERE id LIKE 'merc:attack_validator:%'
		ORDER BY id
	`;
	printRows(watermarks, "None — nothing to reset.");

	section("Contracts paused with an open (unresumed) window");
	const stalePaused = await sqlClient`
		SELECT id, faction_name, status, paused_windows
		FROM merc_contracts
		WHERE status = 'paused'
		  AND paused_windows IS NOT NULL
		  AND jsonb_array_length(paused_windows) > 0
		  AND EXISTS (
			SELECT 1
			FROM jsonb_array_elements(paused_windows) AS w
			WHERE w->>'resumedAt' IS NULL
		  )
	`;
	printRows(stalePaused, "None — no stuck pause windows.");

	return {
		backdatedCount: backdated.length,
		watermarkCount: watermarks.length,
		stalePausedCount: stalePaused.length,
	};
}

// ─── Repairs ──────────────────────────────────────────────────────────────────

async function backup() {
	section("Backup");
	await sqlClient.unsafe(
		`CREATE TABLE IF NOT EXISTS ${BACKUP_CONTRACTS} AS SELECT * FROM merc_contracts`,
	);
	await sqlClient.unsafe(
		`CREATE TABLE IF NOT EXISTS ${BACKUP_STATES} AS SELECT * FROM system_states`,
	);
	console.log(`  Backed up to ${BACKUP_CONTRACTS} and ${BACKUP_STATES}.`);
	console.log(
		`  To restore: TRUNCATE merc_contracts; INSERT INTO merc_contracts SELECT * FROM ${BACKUP_CONTRACTS};`,
	);
}

async function reanchorStartTimes() {
	section("Re-anchor start_time to war_start");
	const result = await sqlClient`
		UPDATE merc_contracts
		SET start_time = war_start, updated_at = now()
		WHERE status IN ('active', 'upcoming')
		  AND war_start IS NOT NULL
		  AND start_minutes_before_war IS NOT NULL
		  AND start_time < war_start
		RETURNING id, faction_name, start_time
	`;
	console.log(`  Updated ${result.count} contract(s).`);
	printRows(result, "  No contracts required re-anchoring.");
	return result.count;
}

async function resetWatermarks() {
	section("Reset attack validator watermarks");
	const result = await sqlClient`
		DELETE FROM system_states WHERE id LIKE 'merc:attack_validator:%'
		RETURNING id
	`;
	console.log(
		`  Deleted ${result.count} watermark row(s). The validator will rebuild these.`,
	);
	return result.count;
}

async function closeStalePauseWindows() {
	section("Close stale open pause windows");
	const result = await sqlClient`
		UPDATE merc_contracts
		SET
			status = 'active',
			paused_windows = (
				SELECT jsonb_agg(
					CASE
						WHEN w->>'resumedAt' IS NULL
							THEN jsonb_set(w, '{resumedAt}', to_jsonb(now()::text))
						ELSE w
					END
				)
				FROM jsonb_array_elements(paused_windows) AS w
			),
			updated_at = now()
		WHERE status = 'paused'
		  AND paused_windows IS NOT NULL
		  AND jsonb_array_length(paused_windows) > 0
		  AND EXISTS (
			SELECT 1
			FROM jsonb_array_elements(paused_windows) AS w
			WHERE w->>'resumedAt' IS NULL
		  )
		RETURNING id, faction_name, status
	`;
	console.log(`  Resumed ${result.count} stuck contract(s).`);
	printRows(result, "  No stuck pause windows found.");
	return result.count;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	banner(APPLY ? "APPLY" : "DRY RUN");

	try {
		const before = await diagnose();

		const needsWork =
			before.backdatedCount > 0 ||
			before.watermarkCount > 0 ||
			before.stalePausedCount > 0;

		if (!needsWork) {
			console.log("\nNothing to repair. System is already in a clean state.\n");
			return;
		}

		if (!APPLY) {
			section("Summary (dry run — nothing was written)");
			console.log(
				`  Would re-anchor        : ${before.backdatedCount} contract(s)`,
			);
			console.log(`  Would reset watermarks : ${before.watermarkCount} row(s)`);
			console.log(
				`  Would resume stuck     : ${before.stalePausedCount} contract(s)`,
			);
			console.log("\n  Re-run with --apply to execute these changes.\n");
			return;
		}

		await backup();
		const anchored = await reanchorStartTimes();
		const reset = await resetWatermarks();
		const resumed = await closeStalePauseWindows();

		console.log("\n--- Post-repair verification ---");
		const after = await diagnose();

		console.log("\n--- Result ---");
		console.log(`  Re-anchored   : ${anchored}`);
		console.log(`  Watermarks    : ${reset}`);
		console.log(`  Resumed       : ${resumed}`);
		console.log(
			`  Remaining issues: ${after.backdatedCount} backdated, ${after.watermarkCount} watermarks, ${after.stalePausedCount} stuck`,
		);
		console.log("\nDone.\n");
	} catch (err) {
		console.error("\n[merc-prod-recovery] Failed:", err);
		process.exitCode = 1;
	} finally {
		await closeDatabase();
	}
}

await main();
