import { db, oilRigSnapshots } from "../packages/database";
import { TornApiClient } from "../packages/torn-api";
import { Logger } from "../packages/utils";

const logger = new Logger("OilRigSnapshot");

async function main(): Promise<void> {
	const apiKey =
		process.env.TORN_API_KEY ||
		process.env.VITE_TORN_API_KEY ||
		process.argv[2];

	if (!apiKey) {
		logger.error("No Torn API key found in environment or arguments.");
		process.exit(1);
	}

	logger.info("Initializing TornApiClient...");
	const client = new TornApiClient();

	logger.info("Fetching company data (profile, employees, stock)...");

	try {
		// Fetching via Torn API v2 /company with selections
		const response = await client.get("/company", {
			apiKey,
			queryParams: {
				selections: ["profile", "employees", "stock"],
			},
		});

		// Parse typed structures
		interface CompanyProfile {
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

		interface Employee {
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

		interface StockItem {
			id: number;
			name: string;
			price: number;
			in_stock: number;
			sold_amount: number;
			sold_worth: number;
		}

		const typedData = response as unknown as {
			profile: CompanyProfile;
			employees: Employee[];
			stock: StockItem[];
		};

		const profile = typedData.profile;
		const employees = typedData.employees ?? [];
		const stockList = typedData.stock ?? [];
		const oilStock = stockList[0];

		const storageCapacity = profile.upgrades?.storage_capacity ?? 0;
		const inStock = oilStock?.in_stock ?? 0;
		const fillPct =
			storageCapacity > 0
				? ((inStock / storageCapacity) * 100).toFixed(1)
				: "N/A";

		logger.info("================ Succession Oil Snapshot ================");
		logger.info(
			`Company: ${profile.name} (${profile.rating}★) | Funds: $${profile.funds.toLocaleString()}`,
		);
		logger.info(
			`Daily Revenue: $${profile.income.daily.toLocaleString()} | Weekly: $${profile.income.weekly.toLocaleString()}`,
		);
		logger.info(
			`Staff: ${profile.employees.hired}/${profile.employees.capacity} | Trains Available: ${profile.trains}`,
		);
		logger.info(
			`Efficiency: ${profile.efficiency}% | Environment: ${profile.environment}% | Popularity: ${profile.popularity}%`,
		);
		logger.info(
			`Ad Budget: $${profile.advertisement_budget.toLocaleString()}/day`,
		);

		if (oilStock) {
			logger.info("-------------------- Oil Stock & Sales ------------------");
			logger.info(
				`Price: $${oilStock.price}/barrel | Daily Sold: ${oilStock.sold_amount.toLocaleString()} barrels ($${oilStock.sold_worth.toLocaleString()})`,
			);
			logger.info(
				`Current Stock: ${oilStock.in_stock.toLocaleString()} / ${storageCapacity.toLocaleString()} barrels (${fillPct}% full)`,
			);
		}

		// Check for issues (addiction, inactivity, unsettled)
		const addictionAlerts: string[] = [];
		const unsettledAlerts: string[] = [];
		let totalAddictionPenalty = 0;
		let employeesWithAddiction = 0;
		let unsettledEmployees = 0;

		for (const emp of employees) {
			if (emp.effectiveness.addiction < 0) {
				employeesWithAddiction++;
				totalAddictionPenalty += Math.abs(emp.effectiveness.addiction);
				addictionAlerts.push(
					`${emp.name} (${emp.position.name}): addiction penalty ${emp.effectiveness.addiction}%`,
				);
			}
			if (emp.effectiveness.settled_in < 10) {
				unsettledEmployees++;
				unsettledAlerts.push(
					`${emp.name} (${emp.position.name}): settled ${emp.effectiveness.settled_in}/10 days`,
				);
			}
		}

		if (addictionAlerts.length > 0) {
			logger.warn("-------------------- Addiction Alerts -------------------");
			for (const alert of addictionAlerts) {
				logger.warn(alert);
			}
		}

		if (unsettledAlerts.length > 0) {
			logger.info("-------------------- Unsettled Staff --------------------");
			for (const alert of unsettledAlerts) {
				logger.info(alert);
			}
		}

		// Persist directly to PostgreSQL database
		const now = new Date();
		const timestamp = Math.floor(now.getTime() / 1000);
		const snapshotId = `oil_rig_${profile.id}_${timestamp}`;

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
				employees: employees as unknown as Record<string, unknown>,
				stock: (oilStock ?? {}) as unknown as Record<string, unknown>,
				metrics: {
					totalAddictionPenalty,
					employeesWithAddiction,
					unsettledEmployees,
					emptyEmployeeSlots: Math.max(
						0,
						profile.employees.capacity - profile.employees.hired,
					),
				},
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
					employees: employees as unknown as Record<string, unknown>,
					stock: (oilStock ?? {}) as unknown as Record<string, unknown>,
					metrics: {
						totalAddictionPenalty,
						employeesWithAddiction,
						unsettledEmployees,
						emptyEmployeeSlots: Math.max(
							0,
							profile.employees.capacity - profile.employees.hired,
						),
					},
				},
			});

		logger.info("Snapshot successfully persisted to PostgreSQL database.");
		logger.info("=========================================================");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to fetch company snapshot: ${message}`);
		process.exit(1);
	}
}

void main();
