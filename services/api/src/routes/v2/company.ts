import { db, desc, oilRigSnapshots } from "@sentinel/database";
import type {
	CompanyEmployee,
	CompanyHistoryResponse,
	CompanyStateResponse,
	CompanyWeeklyLogsResponse,
} from "@sentinel/schemas";
import {
	analyzeStockAndPricing,
	buildCompanyDirectives,
	buildTargetRoleMap,
	buildWeekToDateLogEntries,
	getMondayOfWeek,
	latestMeasuredProduction,
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

		// Only a measured extraction rate may drive the drain model; see
		// latestMeasuredProduction for why one snapshot cannot measure it.
		const dailyProduced = latestMeasuredProduction(history);

		const stockAnalysis = analyzeStockAndPricing({
			inStock,
			storageCap,
			dailySold,
			dailyProduced,
			currentPrice,
			adBudget: dailyAdBudget,
			dailyIncome: dailyRevenue,
		});

		// The stock analysis identifies the bottleneck, and that bottleneck
		// re-shapes the roster quotas, so the dashboard's lineup matches the
		// briefing rather than arguing with it.
		const rosterAnalysis = solveOptimalRoster(employeesSnapshot, {
			bottleneck: {
				extractionBound:
					stockAnalysis.isFillingUp || stockAnalysis.warehouseCritical,
			},
		});

		// Build current WTD
		const wtdSummary = buildWeekToDateLogEntries({ history });

		// One shared builder assembles every directive, so the dashboard, the
		// in-page userscript badges and the Discord briefing all read the same
		// analysis. Nothing here re-derives "is a change needed".
		const directives = buildCompanyDirectives({
			roster: rosterAnalysis,
			stock: stockAnalysis,
			history,
			currentAdBudget: dailyAdBudget,
			barrelPrice: currentPrice,
			openSeats: Math.max(
				0,
				Number(
					(profile.employees as { capacity?: number } | undefined)?.capacity ??
						21,
				) - employeesSnapshot.length,
			),
			staffCount: employeesSnapshot.length,
		});

		const t1 = rosterAnalysis.rehabTiers.tier1;
		const t2 = rosterAnalysis.rehabTiers.tier2;
		const t3 = rosterAnalysis.rehabTiers.tier3;

		// Map employees with optimal targets and rehab tiers
		const transferMap = buildTargetRoleMap(directives);

		const tierMap = new Map<string, 1 | 2 | 3>();
		for (const e of t1) tierMap.set(e.name, 1);
		for (const e of t2) tierMap.set(e.name, 2);
		for (const e of t3) tierMap.set(e.name, 3);

		const enrichedEmployees: CompanyEmployee[] = employeesSnapshot.map(
			(emp) => {
				const targetRole = transferMap.get(emp.name);
				const rehabTier = tierMap.get(emp.name);
				return {
					id: emp.id,
					name: emp.name,
					// Unnamed positions used to leak through as `undefined` and render
					// literally in the userscript; use the same label as the briefing.
					positionName: emp.position.name?.trim() || "Unassigned",
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
			},
		);

		const response: CompanyStateResponse = {
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
			directives,
			employees: enrichedEmployees,
		};

		return response;
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

			const response: CompanyWeeklyLogsResponse = {
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

			return response;
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
				const wages = h.dailyWages ?? 0;
				const adBudget = h.adBudget ?? 0;
				return {
					isoDate: h.isoDate,
					timestamp: h.timestamp,
					income: h.dailyIncome,
					wages,
					adBudget,
					expenses: wages + adBudget,
					// Older snapshots may predate stored profit; fall back to the same
					// arithmetic the week-to-date builder uses so the chart never
					// receives an undefined point.
					profit: h.dailyProfit ?? h.dailyIncome - wages - adBudget,
					sold: h.stock.soldAmount,
					produced: h.dailyProduced ?? 0,
					stock: h.stock.inStock,
					fillPct: h.stock.fillPct,
					barrelPrice: h.stock.barrelPrice,
				};
			});

			const response: CompanyHistoryResponse = {
				success: true,
				timeline,
			};

			return response;
		},
		{
			query: t.Object({
				days: t.Optional(t.String()),
			}),
		},
	);
