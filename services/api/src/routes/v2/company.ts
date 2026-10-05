import type {
	CompanyAnalysisMeta,
	CompanyEmployee,
	CompanyHistoryResponse,
	CompanyStateResponse,
	CompanyWeeklyLogsResponse,
} from "@sentinel/schemas";
import {
	analyzeOilRig,
	buildTargetRoleMap,
	buildWeekToDateLogEntries,
	deriveRosterBaseline,
	getMondayOfWeek,
	loadLatestRosterBaselineRow,
	loadLatestSnapshotFromDb,
	loadPreviousBriefState,
	loadRollingHistory,
	type OilRigHistoryRecord,
} from "@sentinel/utils";
import { Elysia, t } from "elysia";
import { authenticateCrimeLedgerRequest } from "./crime-ledger";

/**
 * Succession Oil's company id, matching `DEFAULT_COMPANY_ID` in
 * `oil-rig-briefing.ts`.
 *
 * The hysteresis state the analysis reads back (inventory state, capacity
 * regime) is keyed by company id when the briefing persists it, so the API has
 * to ask for the same rows the briefing writes or it would analyse a different
 * company's history.
 */
const SUCCESSION_OIL_COMPANY_ID = 90288;

/**
 * Minutes since the most recent recorded tick, for the provenance block.
 *
 * Same arithmetic as the briefing's own helper on purpose: tick age is what
 * tells a reader whether the rates behind the advice are stale, and two surfaces
 * disagreeing about how old the same tick is would be a new way to drift.
 */
function tickAgeMinutes(
	history: OilRigHistoryRecord[],
	asOfSeconds: number,
): number | undefined {
	const last = history[history.length - 1];
	if (!last) return undefined;
	return Math.max(0, Math.round((asOfSeconds - last.timestamp) / 60));
}

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
		const asOfSeconds = Math.floor(Date.now() / 1000);

		// ---- Load -----------------------------------------------------------
		const snapshot = await loadLatestSnapshotFromDb();

		if (!snapshot) {
			// Typed against the contract so the empty shape cannot drift from the
			// populated one: `analysis` is required on both.
			const emptyResponse: CompanyStateResponse = {
				success: false,
				message: "No company snapshot recorded yet.",
				profile: null,
				kpis: null,
				directives: null,
				analysis: null,
				employees: [],
			};
			return emptyResponse;
		}

		const history = await loadRollingHistory(30);

		// Hysteresis and the measured baseline, exactly as the briefing loads
		// them: the inventory state and capacity regime are read back from the
		// previous brief so this response cannot contradict it, and the roster
		// solver steers toward the same measured top-rig capture.
		const previousState = await loadPreviousBriefState(
			SUCCESSION_OIL_COMPANY_ID,
		);
		const baseline = deriveRosterBaseline(await loadLatestRosterBaselineRow(), {
			asOfSeconds,
		});

		// ---- Analyse --------------------------------------------------------
		// ONE pipeline. This handler used to re-implement the engine order
		// inline (its own analyzeStockAndPricing -> solveOptimalRoster ->
		// buildCompanyDirectives), which is how the dashboard, the in-page
		// badges and the Discord briefing came to disagree. Nothing below
		// re-derives a verdict, a target or a directive; every figure in the
		// response is read off the analysis.
		const analysis = analyzeOilRig({
			snapshot,
			history,
			dataBasis: "recorded",
			tickAgeMinutes: tickAgeMinutes(history, asOfSeconds),
			asOfSeconds,
			previousState: previousState?.inventoryState,
			previousCritical: previousState?.warehouseCritical,
			previousRegime: previousState?.regime,
			baseline,
		});

		const { directives, decision, stock } = analysis;

		// Week-to-date is the same builder the briefing prints.
		const wtdSummary = buildWeekToDateLogEntries({ history });

		// Map employees with optimal targets and rehab tiers, taken off the
		// directives so a badge and the briefing name the same move.
		const transferMap = buildTargetRoleMap(directives);

		const tierMap = new Map<string, 1 | 2 | 3>();
		for (const e of directives.rehabTiers.tier1) tierMap.set(e.name, 1);
		for (const e of directives.rehabTiers.tier2) tierMap.set(e.name, 2);
		for (const e of directives.rehabTiers.tier3) tierMap.set(e.name, 3);

		const enrichedEmployees: CompanyEmployee[] = snapshot.employees.map(
			(emp) => {
				const targetRole = transferMap.get(emp.name);
				const rehabTier = tierMap.get(emp.name);
				return {
					id: emp.id,
					name: emp.name,
					// Unnamed positions used to leak through as `undefined` and render
					// literally in the userscript; use the same label as the briefing.
					positionName: emp.position?.name?.trim() || "Unassigned",
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

		// Everything a reader needs to judge the advice, so "why does this say
		// something different from the brief?" is answerable from the payload.
		const analysisMeta: CompanyAnalysisMeta = {
			asOfIso: new Date(asOfSeconds * 1000).toISOString(),
			provenance: analysis.provenance,
			warnings: analysis.warnings,
			decision: decision as unknown as Record<
				string,
				number | string | undefined
			>,
		};

		const response: CompanyStateResponse = {
			success: true,
			profile: {
				name: snapshot.profile.name || "Succession Oil",
				rating: snapshot.profile.rating,
				funds: Number(snapshot.profile.funds ?? 0),
				efficiency: snapshot.profile.efficiency,
				environment: snapshot.profile.environment,
				popularity: snapshot.profile.popularity,
				employees: {
					// The analysed roster is the snapshot's own employee list.
					hired: decision.staffCount,
					capacity: Number(snapshot.profile.employees.capacity || 21),
				},
				storageCapacity: decision.storageCap,
			},
			kpis: {
				wtdProfit: wtdSummary.totalProfit,
				wtdRevenue: wtdSummary.totalRevenue,
				wtdExpenses: wtdSummary.totalWages + wtdSummary.totalAd,
				// Daily financials are the recorded whole-day tick - the same basis
				// the briefing quotes. A live partial day here would put the
				// dashboard and the brief on different numbers for the same day.
				dailyIncome: decision.recordedDailyRevenue,
				dailyWages: decision.recordedDailyWages,
				dailyAdBudget: decision.recordedAdBudget,
				dailyExpenses: decision.recordedDailyWages + decision.recordedAdBudget,
				dailyProfit: decision.recordedDailyProfit,
				inStock: decision.inStock,
				storageCapacity: decision.storageCap,
				fillPct: decision.fillPct,
				barrelPrice: decision.currentPrice,
				dailySold: decision.dailySold,
				dailyProduced: stock.production.dailyProduced,
				// How much the production figure above deserves to be trusted.
				dailyProducedConfidence: stock.production.confidence,
			},
			directives,
			analysis: analysisMeta,
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
					producedEstimated: e.producedEstimated,
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
					// `produced` falls back to 0, and `producedEstimated` is what
					// tells a chart whether to trust it: false means the figure was
					// derived from a real stock delta, true means a display-only fill
					// (or nothing measured at all) that must not be read as extraction.
					produced: h.dailyProduced ?? 0,
					producedEstimated: h.producedMeasured === false,
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
