import {
	companyDailyProfits,
	db,
	getWorkerState,
	upsertWorkerState,
	WORKER_STATE_IDS,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { getPersonalKey, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { type LogIngestSource, schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { runSubscriber } from "../../lib/subscriber-health";
import type { WorkerStartOptions } from "../registry";

export const COMPANY_LOG_IDS = [6222, 6221];
const COMPANY_LOG_ID_SET = new Set<number>(COMPANY_LOG_IDS);

type UserLog = TornSchema<"UserLog">;

const logger = new Logger("Scheduler", "CompanySync");

export type CompanySyncState = {
	status: "idle" | "running" | "completed" | "error";
	lastInflow: number;
	lastOutflow: number;
	lastProfit: number;
	lastSyncTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
};

const DEFAULT_STATE: CompanySyncState = {
	status: "idle",
	lastInflow: 0,
	lastOutflow: 0,
	lastProfit: 0,
	lastSyncTimestamp: null,
	lastError: null,
	updatedAt: new Date().toISOString(),
};

let inMemoryState: CompanySyncState = { ...DEFAULT_STATE };
let isStateLoaded = false;

export type CompanyProfileData = {
	id?: number;
	name?: string;
	income?: {
		daily?: number;
		weekly?: number;
	};
	daily_income?: number;
	advertisement_budget?: number;
	[key: string]: unknown;
};

export type CompanyEmployeeData = {
	id?: number | string;
	name?: string;
	wage?: number;
	[key: string]: unknown;
};

export type CompanyApiResponse = {
	profile?: CompanyProfileData;
	employees?: CompanyEmployeeData[] | Record<string, CompanyEmployeeData>;
	[key: string]: unknown;
};

/**
 * Loads the company sync state from SQLite system_states.
 */
export async function loadCompanySyncState(): Promise<CompanySyncState> {
	try {
		const record = await getWorkerState(WORKER_STATE_IDS.companySync);
		const details = (record?.details ?? {}) as Partial<CompanySyncState>;

		if (record) {
			inMemoryState = {
				...DEFAULT_STATE,
				...details,
				status: (record.status as CompanySyncState["status"] | null) ?? "idle",
				lastError: record.lastError ?? null,
				lastSyncTimestamp: record.cursor,
				updatedAt: new Date().toISOString(),
			};
		} else {
			inMemoryState = { ...DEFAULT_STATE };
		}
		isStateLoaded = true;
	} catch (error) {
		logger.error("Failed to load Company Sync state:", error);
		inMemoryState = { ...DEFAULT_STATE };
	}
	return { ...inMemoryState };
}

/**
 * Returns the current in-memory company sync state.
 */
export function getCompanySyncState(): CompanySyncState {
	return { ...inMemoryState };
}

/**
 * Resets the in-memory company sync state to defaults (mainly for testing/diagnostics).
 */
export function resetCompanySyncState(): void {
	inMemoryState = { ...DEFAULT_STATE, updatedAt: new Date().toISOString() };
	isStateLoaded = false;
}

/**
 * Persists the company sync state to SQLite system_states atomically and broadcasts via IPC.
 */
export async function persistCompanySyncState(
	state: CompanySyncState,
): Promise<void> {
	state.updatedAt = new Date().toISOString();
	try {
		// This state is pure worker plumbing — status, last error, a sync
		// watermark and three counters — so it belongs in `worker_state`, and
		// `init` keeps the same meaning the blob gave it: the sync completed.
		await upsertWorkerState({
			workerId: WORKER_STATE_IDS.companySync,
			init: state.status === "completed",
			status: state.status,
			lastError: state.lastError,
			cursor: state.lastSyncTimestamp,
			lastRunAt: new Date(),
			details: {
				lastInflow: state.lastInflow,
				lastOutflow: state.lastOutflow,
				lastProfit: state.lastProfit,
			},
		});

		inMemoryState = { ...state };

		const ipcServer = getActiveIpcServer();
		if (ipcServer) {
			ipcServer.broadcast({
				action: "company_sync_state_updated",
				data: state,
			});
		}
	} catch (error) {
		logger.error("Failed to persist Company Sync state:", error);
	}
}

/**
 * Fetches company profile & employee data, calculates daily net profit,
 * and records snapshot to CompanyDailyProfit and LedgerEvent.
 */
export async function syncCompanyDailyProfit(): Promise<{
	inflow: number;
	outflow: number;
	profit: number;
} | null> {
	const finishSync = logger.time();
	if (!isStateLoaded) {
		await loadCompanySyncState();
	}

	const state: CompanySyncState = { ...inMemoryState, status: "running" };
	await persistCompanySyncState(state);

	try {
		const keyEntry = await getPersonalKey();
		if (!keyEntry) {
			logger.warn("No personal API key found for company sync. Skipping.");
			state.status = "idle";
			await persistCompanySyncState(state);
			return null;
		}

		const rawRes = (await tornApi.getPersonal("/company", {
			queryParams: { selections: ["profile", "employees"] },
		})) as CompanyApiResponse;

		const profile = rawRes.profile;
		const employees = rawRes.employees;

		if (!profile || !employees) {
			logger.warn("Company sync response missing profile or employees data.");
			state.status = "idle";
			state.lastError = "Response missing profile or employees data.";
			await persistCompanySyncState(state);
			return null;
		}

		const inflow = profile.income?.daily ?? profile.daily_income ?? 0;
		let outflow = profile.advertisement_budget ?? 0;

		const employeeList = Array.isArray(employees)
			? employees
			: typeof employees === "object" && employees !== null
				? Object.values(employees)
				: [];

		for (const employee of employeeList) {
			const wage =
				typeof employee === "object" && employee !== null && "wage" in employee
					? Number(employee.wage ?? 0)
					: 0;
			outflow += wage;
		}

		const profit = inflow - outflow;
		const now = new Date();
		const timestampSec = Math.floor(now.getTime() / 1000);
		const timestampStr = timestampSec.toString();

		// 1. Insert snapshot into company_daily_profits
		const snapshotId = `company_daily_profit_${timestampStr}`;
		await db
			.insert(companyDailyProfits)
			.values({
				id: snapshotId,
				timestamp: now,
				inflow,
				outflow,
				profit,
				profile: profile as unknown as Record<string, unknown>,
				employees: employees as unknown as Record<string, unknown>,
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: companyDailyProfits.id,
				set: {
					timestamp: now,
					inflow,
					outflow,
					profit,
					profile: profile as unknown as Record<string, unknown>,
					employees: employees as unknown as Record<string, unknown>,
				},
			});

		// `company_daily_profits` is this worker's table and nothing else writes it.
		// A company balance earns between two API snapshots and no personal log
		// records it, so this row is the only record that the profit happened.

		state.status = "completed";
		state.lastInflow = inflow;
		state.lastOutflow = outflow;
		state.lastProfit = profit;
		state.lastSyncTimestamp = timestampSec;
		state.lastError = null;
		await persistCompanySyncState(state);

		logger.info(
			`Successfully synced daily company profit: $${profit.toLocaleString()}`,
		);
		finishSync();

		return { inflow, outflow, profit };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error("Failed to sync company data:", error);
		state.status = "error";
		state.lastError = errorMessage;
		await persistCompanySyncState(state);
		return null;
	}
}

/**
 * Starts the Company Sync event subscriber:
 * Listens for real-time `logs_inserted` stream events for log 6222 ("Company director pay")
 * and log 6221 ("Company employee pay") to immediately snapshot company profits at the exact
 * moment Torn executes the daily company tick (~18:00–18:25 TCT).
 */
export function startCompanySync(_options?: WorkerStartOptions): void {
	schedulerEvents.on("company_pay_received", () => {
		runSubscriber("company_profit", () => syncCompanyDailyProfit());
	});

	schedulerEvents.on(
		"logs_inserted",
		(logs: UserLog[], meta: { source: LogIngestSource }) => {
			// Only a *live* company pay log should trigger the immediate sync.
			// A backfill page can contain a pay log from years ago, and reacting to
			// it fetches /company twice (company + oil-rig both listen) and posts a
			// Discord director briefing describing today's company state as if that
			// historical event had just happened.
			if (meta.source !== "forward") {
				return;
			}

			const hasCompanyPayLog = logs.some((l) => {
				const logDetails = (l.details ?? {}) as { id?: number };
				const rawLogCode = (l as unknown as { log?: number }).log;
				const logTypeCode = logDetails.id ?? rawLogCode ?? 0;
				return COMPANY_LOG_ID_SET.has(logTypeCode);
			});

			if (hasCompanyPayLog) {
				logger.info(
					"Detected company pay/director log in live stream. Triggering immediate company daily profit sync...",
				);
				schedulerEvents.emit("company_pay_received");
			}
		},
	);

	logger.info("Company Sync live event listener registered.");
}

/**
 * Alias for startCompanySync for backward compatibility.
 */
export const startCompanyModule = startCompanySync;
