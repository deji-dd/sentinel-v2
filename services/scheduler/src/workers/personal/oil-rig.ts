import { db, oilRigSnapshots } from "@sentinel/database";
import { tornApi } from "@sentinel/torn-api";
import { generateAndSendDirectorBriefing, Logger } from "@sentinel/utils";
import { schedulerEvents } from "../../lib/events";
import type { WorkerStartOptions } from "../registry";

const logger = new Logger("Scheduler", "OilRigCollector");

export interface EmployeeRecord {
	id: number;
	name: string;
	position: { id: number; name: string };
	days_in_company: number;
	wage: number;
	stats: {
		manual_labor: number;
		intelligence: number;
		endurance: number;
	};
	effectiveness: {
		working_stats: number;
		settled_in: number;
		director_education: number;
		addiction: number;
		inactivity: number;
		total: number;
	};
}

export interface StockItemRecord {
	id: number;
	name: string;
	price: number;
	in_stock: number;
	sold_amount: number;
	sold_worth: number;
}

export interface CompanyProfileRecord {
	id: number;
	name: string;
	rating: number;
	funds: number;
	popularity: number;
	efficiency: number;
	environment: number;
	trains: number;
	advertisement_budget: number;
	income: { daily: number; weekly: number };
	customers: { daily: number; weekly: number };
	employees: { hired: number; capacity: number };
	upgrades: {
		staff_room?: string;
		storage?: string;
		storage_capacity?: number;
	};
}

export interface OilRigApiResponse {
	profile: CompanyProfileRecord;
	employees?: EmployeeRecord[];
	stock?: StockItemRecord[];
}

export interface OilRigDailyHistoryEntry {
	timestamp: number;
	isoDate: string;
	companyId: number;
	name: string;
	stars: number;
	funds: number;
	dailyIncome: number;
	weeklyIncome: number;
	dailyCustomers: number;
	weeklyCustomers: number;
	efficiency: number;
	environment: number;
	popularity: number;
	adBudget: number;
	trains: number;
	storageCapacity: number;
	stock: {
		barrelPrice: number;
		inStock: number;
		soldAmount: number;
		soldWorth: number;
		fillPct: number;
	};
	employees: {
		hired: number;
		capacity: number;
		roster: Array<{
			id: number;
			name: string;
			positionId: number;
			positionName: string;
			daysInCompany: number;
			wage: number;
			stats: {
				manualLabor: number;
				intelligence: number;
				endurance: number;
			};
			effectiveness: {
				workingStats: number;
				settledIn: number;
				directorEducation: number;
				addiction: number;
				inactivity: number;
				total: number;
			};
		}>;
	};
	metrics: {
		totalAddictionPenalty: number;
		employeesWithAddiction: number;
		unsettledEmployees: number;
		emptyEmployeeSlots: number;
	};
}

export interface RecordOilRigSnapshotOptions {
	customData?: OilRigApiResponse;
}

/**
 * Fetches company profile, employees, and stock data from Torn API,
 * logs key metrics, and persists a structured daily record directly to PostgreSQL database.
 */
export async function recordOilRigSnapshot(
	options?: RecordOilRigSnapshotOptions,
): Promise<OilRigDailyHistoryEntry | null> {
	const timer = logger.time();

	try {
		const raw =
			options?.customData ??
			((await tornApi.getPersonal("/company", {
				queryParams: { selections: ["profile", "employees", "stock"] },
			})) as unknown as OilRigApiResponse);

		if (!raw?.profile) {
			logger.warn("Oil Rig snapshot response missing profile data. Skipping.");
			return null;
		}

		const profile = raw.profile;
		const employees = raw.employees ?? [];
		const stockList = raw.stock ?? [];
		const oilStock = stockList[0];

		const now = new Date();
		const timestamp = Math.floor(now.getTime() / 1000);
		const isoDate = now.toISOString().slice(0, 10);

		const storageCapacity = profile.upgrades?.storage_capacity ?? 0;
		const inStock = oilStock?.in_stock ?? 0;
		const fillPct =
			storageCapacity > 0
				? Number(((inStock / storageCapacity) * 100).toFixed(1))
				: 0;

		let totalAddictionPenalty = 0;
		let employeesWithAddiction = 0;
		let unsettledEmployees = 0;

		const roster = employees.map((emp) => {
			const addiction = emp.effectiveness.addiction ?? 0;
			const settledIn = emp.effectiveness.settled_in ?? 0;

			if (addiction < 0) {
				totalAddictionPenalty += Math.abs(addiction);
				employeesWithAddiction++;
			}
			if (settledIn < 10) {
				unsettledEmployees++;
			}

			return {
				id: emp.id,
				name: emp.name,
				positionId: emp.position.id,
				positionName: emp.position.name,
				daysInCompany: emp.days_in_company,
				wage: emp.wage,
				stats: {
					manualLabor: emp.stats.manual_labor,
					intelligence: emp.stats.intelligence,
					endurance: emp.stats.endurance,
				},
				effectiveness: {
					workingStats: emp.effectiveness.working_stats,
					settledIn,
					directorEducation: emp.effectiveness.director_education,
					addiction,
					inactivity: emp.effectiveness.inactivity ?? 0,
					total: emp.effectiveness.total,
				},
			};
		});

		const entry: OilRigDailyHistoryEntry = {
			timestamp,
			isoDate,
			companyId: profile.id,
			name: profile.name,
			stars: profile.rating,
			funds: profile.funds,
			dailyIncome: profile.income?.daily ?? 0,
			weeklyIncome: profile.income?.weekly ?? 0,
			dailyCustomers: profile.customers?.daily ?? 0,
			weeklyCustomers: profile.customers?.weekly ?? 0,
			efficiency: profile.efficiency,
			environment: profile.environment,
			popularity: profile.popularity,
			adBudget: profile.advertisement_budget,
			trains: profile.trains,
			storageCapacity,
			stock: {
				barrelPrice: oilStock?.price ?? 0,
				inStock,
				soldAmount: oilStock?.sold_amount ?? 0,
				soldWorth: oilStock?.sold_worth ?? 0,
				fillPct,
			},
			employees: {
				hired: profile.employees.hired,
				capacity: profile.employees.capacity,
				roster,
			},
			metrics: {
				totalAddictionPenalty,
				employeesWithAddiction,
				unsettledEmployees,
				emptyEmployeeSlots: Math.max(
					0,
					profile.employees.capacity - profile.employees.hired,
				),
			},
		};

		// 1. Persist snapshot to PostgreSQL database
		const snapshotId = `oil_rig_${profile.id}_${timestamp}`;
		try {
			await db
				.insert(oilRigSnapshots)
				.values({
					id: snapshotId,
					companyId: profile.id,
					timestamp: now,
					rating: profile.rating,
					dailyRevenue: profile.income?.daily ?? 0,
					weeklyRevenue: profile.income?.weekly ?? 0,
					dailyCustomers: profile.customers?.daily ?? 0,
					weeklyCustomers: profile.customers?.weekly ?? 0,
					barrelsSold: oilStock?.sold_amount ?? 0,
					barrelsInStock: inStock,
					barrelPrice: oilStock?.price ?? 0,
					adBudget: profile.advertisement_budget ?? 0,
					storageCapacity,
					efficiency: profile.efficiency,
					environment: profile.environment,
					popularity: profile.popularity,
					trains: profile.trains,
					profile: profile as unknown as Record<string, unknown>,
					employees: roster as unknown as Record<string, unknown>,
					stock: (oilStock ?? {}) as unknown as Record<string, unknown>,
					metrics: entry.metrics as unknown as Record<string, unknown>,
					createdAt: now,
				})
				.onConflictDoUpdate({
					target: oilRigSnapshots.id,
					set: {
						timestamp: now,
						rating: profile.rating,
						dailyRevenue: profile.income?.daily ?? 0,
						weeklyRevenue: profile.income?.weekly ?? 0,
						dailyCustomers: profile.customers?.daily ?? 0,
						weeklyCustomers: profile.customers?.weekly ?? 0,
						barrelsSold: oilStock?.sold_amount ?? 0,
						barrelsInStock: inStock,
						barrelPrice: oilStock?.price ?? 0,
						adBudget: profile.advertisement_budget ?? 0,
						storageCapacity,
						efficiency: profile.efficiency,
						environment: profile.environment,
						popularity: profile.popularity,
						trains: profile.trains,
						profile: profile as unknown as Record<string, unknown>,
						employees: roster as unknown as Record<string, unknown>,
						stock: (oilStock ?? {}) as unknown as Record<string, unknown>,
						metrics: entry.metrics as unknown as Record<string, unknown>,
					},
				});
		} catch (dbError) {
			const message =
				dbError instanceof Error ? dbError.message : String(dbError);
			logger.error(`Failed to persist snapshot to database: ${message}`);
			throw dbError;
		}

		logger.info(
			`Recorded snapshot for ${profile.name} (${profile.rating}★). Revenue: $${profile.income.daily.toLocaleString()} | Barrels Sold: ${(oilStock?.sold_amount ?? 0).toLocaleString()} | Addiction Penalty: -${totalAddictionPenalty} pts across ${employeesWithAddiction} staff`,
		);

		timer();
		return entry;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Error recording Oil Rig snapshot: ${message}`);
		return null;
	}
}

/**
 * Registers real-time event listener for post-company-tick events.
 * Listens for company_pay_received (emitted when Torn log 6222/6221 is detected in stream).
 */
export function startOilRigCollector(_options?: WorkerStartOptions): void {
	schedulerEvents.on("company_pay_received", () => {
		logger.info(
			"Company pay event detected. Triggering Oil Rig daily snapshot append...",
		);
		recordOilRigSnapshot()
			.then(async (entry) => {
				if (entry) {
					logger.info(
						"Snapshot recorded. Triggering daily director briefing...",
					);
					await generateAndSendDirectorBriefing({
						useLiveData: false,
					});
				}
			})
			.catch((err) => {
				logger.error("Failed executing scheduled Oil Rig snapshot:", err);
			});
	});

	logger.info("Oil Rig daily snapshot collector listener registered.");
}
