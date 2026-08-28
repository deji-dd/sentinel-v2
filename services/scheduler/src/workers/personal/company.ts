import {
	companyDailyProfits,
	db,
	eq,
	ledgerEvents,
	systemStates,
} from "@sentinel/database";
import { getPersonalKey, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "personal:company_sync";
const STATE_ID = "personal:company_sync";
const CADENCE_SEC = 86400; // 24 hours daily sync check

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
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, STATE_ID),
		});

		if (record?.data && typeof record.data === "object") {
			inMemoryState = {
				...DEFAULT_STATE,
				...(record.data as Partial<CompanySyncState>),
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
		const isCompleted = state.status === "completed";
		await db
			.insert(systemStates)
			.values({
				id: STATE_ID,
				init: isCompleted,
				data: state,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					init: isCompleted,
					data: state,
					updatedAt: new Date(),
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

		// 2. Record financial transaction into ledger_events
		const eventId = `ledger_ev_company_profit_${timestampStr}`;
		await db
			.insert(ledgerEvents)
			.values({
				id: eventId,
				logId: "0",
				timestamp: now,
				type: profit >= 0 ? "injection" : "loss",
				categoryId: 9,
				transactionName: "Daily Company Profit/Loss",
				assetsAffected: [],
				cashFlow: 0,
				realizedPnl: profit,
				rawLog: null,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: ledgerEvents.id,
				set: {
					logId: "0",
					timestamp: now,
					type: profit >= 0 ? "injection" : "loss",
					categoryId: 9,
					transactionName: "Daily Company Profit/Loss",
					assetsAffected: [],
					cashFlow: 0,
					realizedPnl: profit,
					updatedAt: now,
				},
			});

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
 * Starts the Company Sync worker:
 * 1. Listens for real-time `company_pay_received` event.
 * 2. Runs daily periodic runner.
 */
export function startCompanySync(options?: WorkerStartOptions): void {
	schedulerEvents.on("company_pay_received", () => {
		syncCompanyDailyProfit().catch((err) => {
			logger.error("Error running company daily profit sync:", err);
		});
	});

	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: CADENCE_SEC,
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			await syncCompanyDailyProfit();
		},
	});
}

/**
 * Alias for startCompanySync for backward compatibility.
 */
export const startCompanyModule = startCompanySync;
