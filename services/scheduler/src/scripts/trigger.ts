import { asc, db, workerSchedules } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { DEFAULT_IPC_SOCKET_PATH, IpcClient } from "@sentinel/utils/ipc";

const logger = new Logger("WorkerTriggerCLI");

// ─── ANSI helpers ────────────────────────────────────────────────────────────
const ESC = "\x1b";
const CSI = `${ESC}[`;
const clrLine = `${CSI}2K\r`;
const saveCursor = `${ESC}[s`;
const restoreCursor = `${ESC}[u`;
const hideCursor = `${CSI}?25l`;
const showCursor = `${CSI}?25h`;
const reset = `${ESC}[0m`;
const bold = `${ESC}[1m`;
const dim = `${ESC}[2m`;
const cyan = `${ESC}[96m`;
const green = `${ESC}[92m`;
const yellow = `${ESC}[93m`;
const red = `${ESC}[91m`;
const white = `${ESC}[97m`;
const gray = `${ESC}[90m`;
const bgDark = `${ESC}[48;5;236m`;

function w(text: string): void {
	process.stdout.write(text);
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

function getSocketPath(): string {
	return DEFAULT_IPC_SOCKET_PATH;
}

/**
 * Sends a force_run_worker IPC message for the given worker name.
 */
async function sendTriggerIPC(workerName: string): Promise<void> {
	const client = new IpcClient(getSocketPath());
	client.send({
		action: "force_run_worker",
		data: { workerName },
	});
	await new Promise((resolve) => setTimeout(resolve, 250));
	client.close();
}

// ─── Date formatting ─────────────────────────────────────────────────────────

function formatDate(date: Date | null): string {
	if (!date) return "Never";
	return new Intl.DateTimeFormat("en-GB", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(date));
}

// ─── Multi-select TUI ────────────────────────────────────────────────────────

interface WorkerRow {
	id: string;
	cadenceSeconds: number;
	lastRunAt: Date | null;
	nextRunAt: Date | null;
}

/**
 * Renders the full interactive list + footer in-place by restoring
 * the saved cursor position before each redraw.
 */
function renderAll(
	workers: WorkerRow[],
	cursor: number,
	selected: Set<number>,
): void {
	w(restoreCursor);

	for (let i = 0; i < workers.length; i++) {
		const wk = workers[i];
		if (!wk) continue;

		const isCursor = i === cursor;
		const isSelected = selected.has(i);

		const checkbox = isSelected
			? `${green}${bold}[✓]${reset}`
			: `${gray}[ ]${reset}`;

		const cadence = `${wk.cadenceSeconds}s`.padEnd(9);
		const lastRun = formatDate(wk.lastRunAt).padEnd(17);
		const nextRun = formatDate(wk.nextRunAt).padEnd(17);
		const name = wk.id.padEnd(34);

		const line = isCursor
			? `${bgDark}  ${checkbox} ${cyan}${bold}${name}${reset}${bgDark} ${dim}${cadence}${reset}${bgDark}  ${gray}${lastRun}${reset}${bgDark}  ${gray}${nextRun}${reset}`
			: `  ${checkbox} ${name}${reset} ${dim}${cadence}${reset}  ${gray}${lastRun}${reset}  ${gray}${nextRun}${reset}`;

		w(`${clrLine}${line}\n`);
	}

	// Footer
	w(`${clrLine}${gray}${"─".repeat(80)}${reset}\n`);
	w(
		`${clrLine}  ${yellow}↑/↓${reset} navigate   ${yellow}Space${reset} toggle   ${yellow}A${reset} select all   ${yellow}Enter${reset} confirm   ${yellow}Esc/Q${reset} quit\n`,
	);
	w(`${clrLine}\n`);
}

/**
 * Opens a raw-mode interactive multi-select prompt.
 * Returns the set of selected worker indices, or null if the user aborted.
 */
async function multiSelectWorkers(
	workers: WorkerRow[],
): Promise<number[] | null> {
	return new Promise((resolve) => {
		let cursor = 0;
		const selected = new Set<number>();

		const cleanup = () => {
			process.stdin.setRawMode(false);
			process.stdin.pause();
			w(showCursor);
		};

		const render = () => renderAll(workers, cursor, selected);

		w(hideCursor);
		w(saveCursor);
		render();

		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");

		const onData = (key: string) => {
			if (key === "\x03" || key === "\x1b" || key === "q" || key === "Q") {
				// Ctrl-C / Escape / q
				cleanup();
				process.stdin.removeListener("data", onData);
				resolve(null);
				return;
			}

			if (key === "\r" || key === "\n") {
				// Enter — confirm
				cleanup();
				process.stdin.removeListener("data", onData);
				resolve([...selected]);
				return;
			}

			if (key === " ") {
				// Space — toggle selection
				if (selected.has(cursor)) {
					selected.delete(cursor);
				} else {
					selected.add(cursor);
				}
				render();
				return;
			}

			if (key === "a" || key === "A") {
				// Toggle all
				if (selected.size === workers.length) {
					selected.clear();
				} else {
					for (let i = 0; i < workers.length; i++) selected.add(i);
				}
				render();
				return;
			}

			if (key === "\x1b[A") {
				// Arrow up
				cursor = (cursor - 1 + workers.length) % workers.length;
				render();
				return;
			}

			if (key === "\x1b[B") {
				// Arrow down
				cursor = (cursor + 1) % workers.length;
				render();
				return;
			}
		};

		process.stdin.on("data", onData);
	});
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Interactive CLI script for triggering background workers.
 * Supports arrow key navigation, Space to multi-select, and Enter to confirm.
 */
async function main() {
	const directWorkerName = process.argv[2];

	// If worker name is passed directly via CLI argument, execute immediately
	if (directWorkerName) {
		logger.info(`Triggering worker '${directWorkerName}' directly...`);
		await sendTriggerIPC(directWorkerName);
		console.log(`✅ Trigger command sent for '${directWorkerName}'.`);
		process.exit(0);
	}

	// ── Header ──
	w("\n");
	w(`${cyan}${bold}${"═".repeat(60)}${reset}\n`);
	w(`${cyan}${bold}        SENTINEL V2 — WORKER TRIGGER CLI${reset}\n`);
	w(`${cyan}${bold}${"═".repeat(60)}${reset}\n\n`);

	// ── Load workers ──
	const schedules = await db.query.workerSchedules.findMany({
		orderBy: [asc(workerSchedules.id)],
	});

	if (schedules.length === 0) {
		w(
			`${yellow}⚠️  No registered worker schedules found in database.${reset}\n`,
		);
		w(`${dim}Ensure @sentinel/scheduler has booted at least once.${reset}\n\n`);
		process.exit(1);
	}

	// ── Column header ──
	w(
		`${gray}  ${"   "}  ${"Worker Name".padEnd(34)} ${"Cadence".padEnd(9)}  ${"Last Run".padEnd(17)}  ${"Next Run".padEnd(17)}${reset}\n`,
	);
	w(`${gray}${"─".repeat(80)}${reset}\n`);

	// ── Interactive multi-select ──
	const selectedIndices = await multiSelectWorkers(schedules);

	w("\n");

	if (selectedIndices === null || selectedIndices.length === 0) {
		if (selectedIndices === null) {
			w(`${gray}Aborted. No workers triggered.${reset}\n\n`);
		} else {
			w(`${yellow}No workers selected. Nothing to do.${reset}\n\n`);
		}
		process.exit(0);
	}

	// ── Fire IPC sequentially ──
	const targets = selectedIndices
		.sort((a, b) => a - b)
		.map((i) => {
			const targetSchedule = schedules[i];
			if (!targetSchedule) {
				throw new Error(`Invalid worker index ${i}`);
			}
			return targetSchedule.id;
		});

	w(`${bold}${white}Triggering ${targets.length} worker(s)...${reset}\n\n`);

	for (const workerName of targets) {
		w(
			`  ${cyan}▶${reset}  ${white}${workerName}${reset}  ${dim}sending...${reset}`,
		);
		try {
			await sendTriggerIPC(workerName);
			w(
				`\r${clrLine}  ${green}✓${reset}  ${white}${workerName}${reset}  ${green}${dim}triggered${reset}\n`,
			);
		} catch (err) {
			w(
				`\r${clrLine}  ${red}✗${reset}  ${white}${workerName}${reset}  ${red}${dim}failed${reset}\n`,
			);
			logger.error(`Failed to trigger '${workerName}':`, err);
		}
	}

	w(
		`\n${green}${bold}Done!${reset} ${dim}${targets.length} worker(s) triggered.${reset}\n\n`,
	);

	process.exit(0);
}

main().catch((err) => {
	w(showCursor);
	logger.error("Fatal error in Worker Trigger CLI:", err);
	process.exit(1);
});
