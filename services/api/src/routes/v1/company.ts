import { db, desc, oilRigSnapshots } from "@sentinel/database";
import {
	analyzeStockAndPricing,
	buildWeekToDateLogEntries,
	getMondayOfWeek,
	loadRollingHistory,
	solveOptimalRoster,
} from "@sentinel/utils";
import { Elysia, t } from "elysia";
import { authenticateCrimeLedgerRequest } from "./crime-ledger";

export const companyRoutes = new Elysia({ prefix: "/company" })
	.derive(async ({ headers, set }) => {
		const isAuthed = await authenticateCrimeLedgerRequest(headers);
		if (!isAuthed) {
			set.status = 401;
			throw new Error("Unauthorized: Invalid API key.");
		}
		return {};
	})
	.get("/state", async () => {
		const [latestRow] = await db
			.select()
			.from(oilRigSnapshots)
			.orderBy(desc(oilRigSnapshots.timestamp))
			.limit(1);

		if (!latestRow) {
			return {
				success: false,
				message: "No company snapshot recorded yet.",
				profile: null,
				kpis: null,
				directives: null,
				employees: [],
			};
		}

		// Load rolling history for calculations
		const history = await loadRollingHistory(30);

		const stockArr = Array.isArray(latestRow.stock)
			? (latestRow.stock as Array<Record<string, unknown>>)
			: [latestRow.stock as Record<string, unknown>];
		const primaryStock = stockArr[0] ?? {};

		const inStock = Number(
			primaryStock.in_stock ?? latestRow.barrelsInStock ?? 0,
		);
		const storageCap = latestRow.storageCapacity || 750_000;
		const fillPct =
			storageCap > 0 ? Number(((inStock / storageCap) * 100).toFixed(1)) : 0;
		const dailySold = Number(
			primaryStock.sold_amount ?? latestRow.barrelsSold ?? 0,
		);
		const currentPrice = Number(
			primaryStock.price ?? latestRow.barrelPrice ?? 181,
		);

		const rawEmployees = (
			Array.isArray(latestRow.employees) ? latestRow.employees : []
		) as Array<Record<string, unknown>>;

		const employeesSnapshot = rawEmployees.map((emp) => {
			const stats = (emp.stats ?? {}) as Record<string, unknown>;
			const eff = (emp.effectiveness ?? {}) as Record<string, unknown>;
			const pos = emp.position as { id?: number; name?: string } | undefined;

			return {
				id: Number(emp.id ?? 0),
				name: String(emp.name ?? ""),
				position: pos ?? {
					id: Number(emp.positionId ?? 0),
					name: String(emp.positionName ?? ""),
				},
				days_in_company: Number(emp.days_in_company ?? emp.daysInCompany ?? 0),
				wage: Number(emp.wage ?? 0),
				stats: {
					manual_labor: Number(stats.manual_labor ?? stats.manualLabor ?? 0),
					intelligence: Number(stats.intelligence ?? 0),
					endurance: Number(stats.endurance ?? 0),
				},
				effectiveness: {
					working_stats: Number(eff.working_stats ?? eff.workingStats ?? 0),
					settled_in: Number(eff.settled_in ?? eff.settledIn ?? 0),
					director_education: Number(
						eff.director_education ?? eff.directorEducation ?? 0,
					),
					addiction: Number(eff.addiction ?? 0),
					inactivity: Number(eff.inactivity ?? 0),
					total: Number(eff.total ?? 0),
				},
			};
		});

		const profile = latestRow.profile as Record<string, unknown>;
		const dailyRevenue = latestRow.dailyRevenue;
		const dailyWages = employeesSnapshot.reduce((sum, e) => sum + e.wage, 0);
		const dailyAdBudget = latestRow.adBudget;
		const dailyProfit = dailyRevenue - dailyWages - dailyAdBudget;

		// Solve lineup and stock recommendations
		const rosterAnalysis = solveOptimalRoster(employeesSnapshot);

		// Determine latest produced barrels from history
		let dailyProduced: number | undefined;
		if (history.length >= 2) {
			const latestH = history[history.length - 1];
			const prevH = history[history.length - 2];
			if (latestH && prevH && latestH.stock.soldAmount >= 0) {
				const delta = latestH.stock.inStock - prevH.stock.inStock;
				const est = delta + latestH.stock.soldAmount;
				if (est >= 0) dailyProduced = est;
			}
		}

		const stockAnalysis = analyzeStockAndPricing({
			inStock,
			storageCap,
			dailySold,
			dailyProduced,
			currentPrice,
			adBudget: dailyAdBudget,
			dailyIncome: dailyRevenue,
		});

		// Build current WTD
		const wtdSummary = buildWeekToDateLogEntries({ history });

		const hasRoleTransfers = rosterAnalysis.activeTransfers.length > 0;
		const hasPriceSuggestion =
			stockAnalysis.recommendedPrice.action !== "maintain" &&
			stockAnalysis.recommendedPrice.exact !== currentPrice;
		const hasAdSuggestion =
			stockAnalysis.recommendedAdSpend.action !== "maintain" &&
			stockAnalysis.recommendedAdSpend.amount !== dailyAdBudget;

		const t1 = rosterAnalysis.rehabTiers.tier1;
		const t2 = rosterAnalysis.rehabTiers.tier2;
		const t3 = rosterAnalysis.rehabTiers.tier3;
		const hasAddiction = t1.length > 0 || t2.length > 0 || t3.length > 0;

		const allOptimal =
			!hasRoleTransfers &&
			!hasPriceSuggestion &&
			!hasAdSuggestion &&
			!hasAddiction;

		// Map employees with optimal targets and rehab tiers
		const transferMap = new Map<string, string>();
		for (const t of rosterAnalysis.activeTransfers) {
			transferMap.set(t.name, t.toRole);
		}

		const tierMap = new Map<string, 1 | 2 | 3>();
		for (const e of t1) tierMap.set(e.name, 1);
		for (const e of t2) tierMap.set(e.name, 2);
		for (const e of t3) tierMap.set(e.name, 3);

		const enrichedEmployees = employeesSnapshot.map((emp) => {
			const targetRole = transferMap.get(emp.name);
			const rehabTier = tierMap.get(emp.name);
			return {
				id: emp.id,
				name: emp.name,
				positionName: emp.position.name,
				wage: emp.wage,
				addiction: emp.effectiveness.addiction,
				stats: {
					manualLabor: emp.stats.manual_labor,
					intelligence: emp.stats.intelligence,
					endurance: emp.stats.endurance,
				},
				targetRole,
				isOptimal: !targetRole,
				rehabTier,
			};
		});

		return {
			success: true,
			profile: {
				name: String(profile.name ?? "Succession Oil"),
				rating: latestRow.rating,
				funds: Number(profile.funds ?? 0),
				efficiency: latestRow.efficiency,
				environment: latestRow.environment,
				popularity: latestRow.popularity,
				employees: {
					hired: employeesSnapshot.length,
					capacity: Number(
						(profile.employees as { capacity?: number } | undefined)
							?.capacity ?? 21,
					),
				},
				storageCapacity: storageCap,
			},
			kpis: {
				wtdProfit: wtdSummary.totalProfit,
				wtdRevenue: wtdSummary.totalRevenue,
				wtdExpenses: wtdSummary.totalWages + wtdSummary.totalAd,
				dailyIncome: dailyRevenue,
				dailyWages,
				dailyAdBudget,
				dailyExpenses: dailyWages + dailyAdBudget,
				dailyProfit,
				inStock,
				storageCapacity: storageCap,
				fillPct,
				barrelPrice: currentPrice,
				dailySold,
				dailyProduced,
			},
			directives: {
				roleTransfers: rosterAnalysis.activeTransfers,
				adSpend: {
					action: stockAnalysis.recommendedAdSpend.action,
					amount: stockAnalysis.recommendedAdSpend.amount,
					formatted: stockAnalysis.recommendedAdSpend.formatted,
					isChanged: hasAdSuggestion,
				},
				pricing: {
					action: stockAnalysis.recommendedPrice.action,
					exact: stockAnalysis.recommendedPrice.exact,
					formatted: stockAnalysis.recommendedPrice.formatted,
					isChanged: hasPriceSuggestion,
				},
				rehabTiers: {
					tier1: t1,
					tier2: t2,
					tier3: t3,
				},
				allOptimal,
			},
			employees: enrichedEmployees,
		};
	})
	.get(
		"/weekly-logs",
		async ({ query }) => {
			const offset = Math.max(0, Number(query.offset ?? 0) || 0);

			// Calculate reference date shifted by `offset` weeks
			const now = new Date();
			const targetRefDate = new Date(
				now.getTime() - offset * 7 * 24 * 60 * 60 * 1000,
			);
			const targetMonday = getMondayOfWeek(targetRefDate);
			const mondayIso = targetMonday.toISOString().slice(0, 10);

			const targetSunday = new Date(targetMonday);
			targetSunday.setUTCDate(targetMonday.getUTCDate() + 6);
			const sundayIso = targetSunday.toISOString().slice(0, 10);

			// Load all snapshots for this period
			const history = await loadRollingHistory(90);

			// Group entries for this specific accounting week
			const wtd = buildWeekToDateLogEntries({
				history,
				referenceDate: targetRefDate,
			});

			const totalExpenses = wtd.totalWages + wtd.totalAd;
			const avgPrice =
				wtd.entries.length > 0
					? Math.round(
							wtd.entries.reduce((sum, e) => sum + e.barrelPrice, 0) /
								wtd.entries.length,
						)
					: 0;

			// Check if any snapshots exist before this week
			const hasPrev = history.some((h) => h.isoDate < mondayIso);
			const hasNext = offset > 0;

			const monthNames = [
				"Jan",
				"Feb",
				"Mar",
				"Apr",
				"May",
				"Jun",
				"Jul",
				"Aug",
				"Sep",
				"Oct",
				"Nov",
				"Dec",
			];
			const startM = monthNames[targetMonday.getUTCMonth()];
			const startD = targetMonday.getUTCDate();
			const endM = monthNames[targetSunday.getUTCMonth()];
			const endD = targetSunday.getUTCDate();
			const weekLabel = `${startM} ${startD} - ${endM} ${endD}, ${targetMonday.getUTCFullYear()}`;

			return {
				success: true,
				offset,
				hasPrev,
				hasNext,
				mondayIso,
				sundayIso,
				weekLabel,
				entries: wtd.entries.map((e) => ({
					dayOfWeek: e.dayOfWeek,
					isoDate: e.isoDate,
					revenue: e.revenue,
					wages: e.wages,
					adBudget: e.adBudget,
					expenses: e.wages + e.adBudget,
					profit: e.profit,
					soldBarrels: e.soldBarrels,
					producedBarrels: e.producedBarrels,
					barrelPrice: e.barrelPrice,
				})),
				totals: {
					totalRevenue: wtd.totalRevenue,
					totalWages: wtd.totalWages,
					totalAd: wtd.totalAd,
					totalExpenses,
					totalProfit: wtd.totalProfit,
					totalSold: wtd.totalSold,
					totalProduced: wtd.totalProduced,
					avgPrice,
				},
			};
		},
		{
			query: t.Object({
				offset: t.Optional(t.String()),
			}),
		},
	)
	.get(
		"/history",
		async ({ query }) => {
			const days = Math.min(90, Math.max(7, Number(query.days ?? 30) || 30));
			const history = await loadRollingHistory(days);

			const timeline = history.map((h) => {
				const expenses = (h.dailyWages ?? 0) + (h.adBudget ?? 0);
				return {
					isoDate: h.isoDate,
					timestamp: h.timestamp,
					income: h.dailyIncome,
					wages: h.dailyWages ?? 0,
					adBudget: h.adBudget ?? 0,
					expenses,
					profit: h.dailyProfit,
					sold: h.stock.soldAmount,
					produced: h.dailyProduced ?? 0,
					stock: h.stock.inStock,
					fillPct: h.stock.fillPct,
					barrelPrice: h.stock.barrelPrice,
				};
			});

			return {
				success: true,
				timeline,
			};
		},
		{
			query: t.Object({
				days: t.Optional(t.String()),
			}),
		},
	);
