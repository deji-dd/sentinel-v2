import { apiClient } from "../api";
import {
	escapeHtml,
	formatCompactNumber,
	formatMoney,
	formatNumber,
	STORAGE_KEYS,
} from "../config";
import type {
	CompanyDirectives,
	CompanyHistoryEntry,
	CompanyKPIs,
	CompanyStateResponse,
	CompanyWeeklyLogsResponse,
	WeeklyLogEntry,
} from "../types";
import { renderCompanySvgChart } from "../ui/svg-chart";
import {
	bindSortableHeaders,
	nextSortState,
	type SortAccessors,
	type SortDirection,
	type SortState,
	sortIndicator,
	sortRows,
} from "../ui/table-sort";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

type LedgerSortKey =
	| "dayOfWeek"
	| "isoDate"
	| "revenue"
	| "expenses"
	| "profit"
	| "soldBarrels"
	| "producedBarrels"
	| "barrelPrice";

const LEDGER_SORT_KEYS: LedgerSortKey[] = [
	"dayOfWeek",
	"isoDate",
	"revenue",
	"expenses",
	"profit",
	"soldBarrels",
	"producedBarrels",
	"barrelPrice",
];

/** Days read in week order; every money and volume column reads largest-first. */
const LEDGER_SORT_DEFAULT: Record<LedgerSortKey, SortDirection> = {
	dayOfWeek: "asc",
	isoDate: "asc",
	revenue: "desc",
	expenses: "desc",
	profit: "desc",
	soldBarrels: "desc",
	producedBarrels: "desc",
	barrelPrice: "desc",
};

const LEDGER_SORT_ACCESSORS: SortAccessors<WeeklyLogEntry, LedgerSortKey> = {
	// The ledger is a week, so its natural order is the day of that week, not the
	// alphabet — sorting "Friday" before "Monday" would be nonsense.
	dayOfWeek: (row) => WEEKDAY_ORDER.indexOf(row.dayOfWeek),
	isoDate: (row) => row.isoDate,
	revenue: (row) => row.revenue,
	expenses: (row) => row.expenses,
	profit: (row) => row.profit,
	soldBarrels: (row) => row.soldBarrels,
	producedBarrels: (row) => row.producedBarrels ?? 0,
	barrelPrice: (row) => row.barrelPrice,
};

const WEEKDAY_ORDER = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
];

export class CompanyTab {
	private container: HTMLElement;
	private state: CompanyStateResponse | null = null;
	private weeklyLogs: CompanyWeeklyLogsResponse | null = null;
	private history: CompanyHistoryEntry[] = [];
	private currentChartMode: "financials" | "production" = "financials";
	private currentWeekOffset = 0;
	private ledgerSort: SortState<LedgerSortKey> = {
		key: "isoDate",
		direction: "asc",
	};
	private onOpenSettings: () => void;

	constructor(container: HTMLElement, onOpenSettings: () => void) {
		this.container = container;
		this.onOpenSettings = onOpenSettings;
		this.currentChartMode = GM_getValue<"financials" | "production">(
			STORAGE_KEYS.companyChartMode,
			"financials",
		);
		this.currentWeekOffset = GM_getValue<number>(
			STORAGE_KEYS.companyWeeklyOffset,
			0,
		);

		const storedSort = GM_getValue<Partial<SortState<LedgerSortKey>>>(
			STORAGE_KEYS.companySort,
			{},
		);
		if (
			storedSort.key &&
			LEDGER_SORT_KEYS.includes(storedSort.key) &&
			(storedSort.direction === "asc" || storedSort.direction === "desc")
		) {
			this.ledgerSort = {
				key: storedSort.key,
				direction: storedSort.direction,
			};
		}
	}

	public async init(): Promise<void> {
		this.state = apiClient.getCachedCompanyState();
		this.render();
		await this.refresh();
	}

	public async refresh(): Promise<void> {
		try {
			const [stateRes, weeklyRes, historyRes] = await Promise.all([
				apiClient.getCompanyState(),
				apiClient.getCompanyWeeklyLogs(this.currentWeekOffset),
				apiClient.getCompanyHistory(30),
			]);
			this.state = stateRes;
			this.weeklyLogs = weeklyRes;
			this.history = historyRes.timeline;
			this.render();
		} catch (err) {
			console.error("[Blasted's Script] Error refreshing company data:", err);
			this.renderError(err instanceof Error ? err.message : String(err));
		}
	}

	public setChartMode(mode: "financials" | "production"): void {
		this.currentChartMode = mode;
		GM_setValue(STORAGE_KEYS.companyChartMode, mode);
		this.renderChartOnly();
	}

	public async setWeekOffset(offset: number): Promise<void> {
		this.currentWeekOffset = Math.max(0, offset);
		GM_setValue(STORAGE_KEYS.companyWeeklyOffset, this.currentWeekOffset);
		const tableBody = this.container.querySelector<HTMLElement>(
			"#company-weekly-table-container",
		);
		if (tableBody) {
			tableBody.innerHTML = `
				<div style="padding: 30px; text-align: center; color: #94a3b8; font-size: 12px; font-family: monospace;">
					Loading week records...
				</div>
			`;
		}
		try {
			const res = await apiClient.getCompanyWeeklyLogs(this.currentWeekOffset);
			this.weeklyLogs = res;
			this.renderWeeklyTableOnly();
		} catch (err) {
			console.error("[Blasted's Script] Error loading weekly logs:", err);
		}
	}

	private renderError(message: string): void {
		const isAuthError =
			message.toLowerCase().includes("unauthorized") ||
			message.toLowerCase().includes("api key");
		this.container.innerHTML = `
			<div class="kpi-card" style="border-color: #ef4444; background: rgba(239, 68, 68, 0.1);">
				<div class="kpi-label" style="color: #f87171;">Connection Alert</div>
				<div style="font-size: 13px; color: #fca5a5; margin: 6px 0;">${message}</div>
				${
					isAuthError
						? `<button id="btn-fix-key-comp" class="btn-primary" style="margin-top: 8px; width: fit-content;">Configure API Key in Settings</button>`
						: `<button id="btn-retry-comp" class="btn-primary" style="margin-top: 8px; width: fit-content;">Retry Connection</button>`
				}
			</div>
		`;

		this.container
			.querySelector("#btn-fix-key-comp")
			?.addEventListener("click", () => {
				this.onOpenSettings();
			});

		this.container
			.querySelector("#btn-retry-comp")
			?.addEventListener("click", () => {
				this.refresh();
			});
	}

	public render(): void {
		if (!this.state?.success || !this.state.kpis) {
			this.container.innerHTML = `
				<div style="padding: 40px 0; text-align: center; color: #94a3b8; font-family: monospace; font-size: 13px;">
					Loading Succession Oil Intel...
				</div>
			`;
			return;
		}

		const { kpis, directives, analysis } = this.state;

		this.container.innerHTML = `
			<!-- 1. Directives & Action Items Card -->
			${this.renderDirectivesCard(directives)}

			<!-- 1b. Data caveats behind that advice -->
			${this.renderAnalysisWarnings(analysis)}

			<!-- 2. Minimal KPI Cards -->
			${this.renderKpiCards(kpis, directives)}

			<!-- 3. Historical Chart Card -->
			<div class="chart-card" style="margin-top: 14px;">
				<div class="chart-header">
					<div class="chart-title">Historical Trends</div>
					<div class="chart-controls">
						<div class="btn-pill-group">
							<button class="btn-pill ${this.currentChartMode === "financials" ? "active" : ""}" data-chart-mode="financials">
								Financials
							</button>
							<button class="btn-pill ${this.currentChartMode === "production" ? "active" : ""}" data-chart-mode="production">
								Production
							</button>
						</div>
					</div>
				</div>

				<!-- Scrubber Status Strip -->
				<div id="company-chart-scrub-strip" class="chart-scrub-strip" role="status" aria-live="polite">
					<span>Hover or drag across chart to inspect daily breakdown</span>
				</div>

				<!-- Responsive SVG Chart Canvas -->
				<div id="company-chart-canvas-wrap" class="chart-svg-wrap"></div>
			</div>

			<!-- 4. Strictly Paginated Weekly Logs Table -->
			<div id="company-weekly-table-container" style="margin-top: 14px;">
				${this.renderWeeklyTableHtml()}
			</div>
		`;

		this.bindEvents();
		this.bindLedgerSort();
		this.renderChartOnly();
	}

	private renderDirectivesCard(directives: CompanyDirectives | null): string {
		if (!directives) return "";

		const hasTransfers = directives.roleTransfers.length > 0;
		const hasPrice = directives.pricing.isChanged;
		const hasAd = directives.adSpend.isChanged;
		const t1 = directives.rehabTiers.tier1;
		const t2 = directives.rehabTiers.tier2;
		const hasRehab = t1.length > 0 || t2.length > 0;

		// Capacity first: when the warehouse cannot clear, the roster - not price
		// or advertising - is what stands between the rig and its output.
		const rebalance = directives.capacityRebalance;
		const planState = rebalance.state;
		const regimeLabel = `${rebalance.regime.regime.replace(/_/g, " ")}${rebalance.regime.held ? ", held" : ""}`;

		// `action_required` is the ONLY capacity state that asks for a seat move.
		// A rig that already carries the sell-through weight this bottleneck calls
		// for still reports `extractionBound`, which is what the badge used to key
		// off - so it demanded a rebalance that had already been done. `holding` is
		// a steady state with an exit condition, not an alert.
		const seatChangeRequired = rebalance.actions.some(
			(action) => action.kind === "rebalance",
		);

		// The engine's holding summary ends with this exact sentence, so it is
		// lifted into its own row below rather than printed twice.
		const holdingExplanation = rebalance.summary
			.replace(rebalance.revertCondition, "")
			.trim();

		const structuralAdvice = directives.stock.structuralAdvice;
		const insight = directives.sellThrough;
		const production = directives.stock.production;

		// `allOptimal` is computed server-side and already accounts for the
		// capacity rebalance, so the tab never claims "optimal" during a storage
		// crisis. Do not re-derive it here.
		if (directives.allOptimal) {
			return `
				<div class="directives-card optimal">
					<div class="directives-header">
						<span class="directives-title">Operations Status: All Systems Optimal</span>
					</div>
					<div class="directives-body" style="font-size: 12px; color: #94a3b8; margin-top: 4px;">
						Roster is aligned with the target blueprint, extraction is matched to sell-through, pricing and advertising spend are at their targets, and all staff are healthy.
					</div>
				</div>
			`;
		}

		// Anything here is a demand on the director. A holding rebalance, an
		// optional hire and a "storage will not fix this" note are deliberately
		// not: none of them is a seat change that is outstanding.
		const hasRequiredWork =
			seatChangeRequired ||
			hasTransfers ||
			hasPrice ||
			hasAd ||
			hasRehab ||
			Boolean(structuralAdvice);

		const row = (tagClass: string, tag: string, text: string) => `
			<div class="directive-row">
				<span class="directive-tag ${tagClass}">${tag}</span>
				<span class="directive-text">${text}</span>
			</div>
		`;

		const basisLabel = (basis: string) => basis.replace(/_/g, " ");

		let itemsHtml = "";

		// 1. Capacity plan: the state first, because it is the field that says
		//    whether anything is being asked for, then the regime behind it.
		if (rebalance.extractionBound && rebalance.discardedBarrelsPerDay > 0) {
			itemsHtml += row(
				"tag-capacity",
				"Output",
				`<strong>${formatNumber(rebalance.discardedBarrelsPerDay)}</strong> bbl/day (~${formatMoney(rebalance.discardedValuePerDay)}/day) produced beyond what the rig clears and discarded while storage is full.`,
			);
		}

		if (planState === "action_required") {
			for (const action of rebalance.actions) {
				const label =
					action.kind === "rebalance"
						? "Rebalance"
						: action.kind === "hire"
							? "Hire"
							: "Storage";
				const revert = action.temporary
					? ' <em style="color: #94a3b8;">(revert once stock normalises)</em>'
					: "";
				itemsHtml += row(
					"tag-capacity",
					label,
					`${escapeHtml(action.reason)}${revert}`,
				);
			}
		} else if (planState === "holding") {
			// Neutral by design: the seats are already where they need to be, so
			// this reports the state and what would end it, never a demand.
			itemsHtml += row(
				"tag-insight",
				"Holding",
				`${holdingExplanation} <span style="color: #94a3b8;">Regime: ${regimeLabel}.</span>`,
			);
			itemsHtml += row("tag-insight", "Exit", rebalance.revertCondition);
			// Unfilled seats are still offered while holding: that is growth
			// capacity rather than a correction, and the engine words it that way.
			for (const action of rebalance.actions) {
				itemsHtml += row(
					"tag-insight",
					action.kind === "hire" ? "Optional" : "Storage",
					action.reason,
				);
			}
		} else {
			itemsHtml += row(
				"tag-insight",
				"Balanced",
				`${rebalance.summary} <span style="color: #94a3b8;">Regime: ${regimeLabel}.</span>`,
			);
		}

		// 2. Structural constraint: why price and ads cannot fix it.
		if (structuralAdvice) {
			itemsHtml += row("tag-structural", "Blocker", structuralAdvice);
		}

		// 3. Role transfers
		if (hasTransfers) {
			itemsHtml += directives.roleTransfers
				.map((t) =>
					row(
						"tag-role",
						"Role",
						`<strong>${escapeHtml(t.name)}</strong> (${escapeHtml(t.statsStr)}): ${escapeHtml(t.fromRole)} ➔ <strong>${escapeHtml(t.toRole)}</strong>`,
					),
				)
				.join("");
		}

		// 4. Price. The basis and confidence travel with the recommendation whether
		//    or not a change is being asked for: "maintain" is only worth anything
		//    if the reader can see what it rests on.
		itemsHtml += row(
			hasPrice ? "tag-price" : "tag-insight",
			hasPrice ? "Price" : "Pricing",
			`${
				hasPrice
					? `Adjust Barrel Price: <strong>${directives.pricing.formatted}</strong>`
					: directives.pricing.formatted
			} <em style="color: #94a3b8;">(basis: ${basisLabel(directives.pricing.basis)}, ${directives.pricing.confidence} confidence)</em>`,
		);

		// 5. Advertising, with what one rank step is worth, so the number can be
		//    judged rather than taken on faith.
		itemsHtml += row(
			hasAd ? "tag-ad" : "tag-insight",
			hasAd ? "Ad Spend" : "Advertising",
			`${
				hasAd
					? `Adjust Ad Budget: <strong>${directives.adSpend.formatted}</strong>`
					: directives.adSpend.formatted
			} <em style="color: #94a3b8;">(basis: ${basisLabel(directives.adSpend.basis)}; one rank step ≈ ${formatMoney(directives.adSpend.rankStepValuePerDay)}/day, cap ${formatMoney(directives.adSpend.operationalCapPerDay)}/day)</em>`,
		);

		// 6. Extraction. The figure is only actionable to the degree it could be
		//    measured, so the confidence is never shown apart from it. It is also a
		//    median over the last few measured days, NOT one day's output, so the
		//    window is named and the newest day is shown beside it - otherwise the
		//    number reads as "produced today" and contradicts the stock level.
		const latest = production.latestMeasured;
		const smoothed =
			production.samples > 1 &&
			latest !== undefined &&
			latest !== production.dailyProduced;
		itemsHtml += row(
			"tag-insight",
			"Extraction",
			`${
				production.dailyProduced !== undefined
					? `<strong>${formatNumber(production.dailyProduced)}</strong> bbl/day <em style="color: #94a3b8;">${production.samples > 1 ? `${production.samples}-day median` : "measured"}</em>`
					: "<strong>unmeasurable</strong>"
			} <em style="color: #94a3b8;">(${production.confidence} confidence, ${production.samples} measured day${production.samples === 1 ? "" : "s"})</em>${
				smoothed
					? ` <span style="color: #94a3b8;">latest day ${formatNumber(latest)} bbl/day</span>`
					: ""
			}${
				production.confidence === "low" || production.confidence === "none"
					? ` <span style="color: #94a3b8;">${production.summary}</span>`
					: ""
			}`,
		);

		// 7. Price-response insight: measured, not assumed.
		if (
			insight.verdict === "unresponsive" ||
			insight.verdict === "partially_responsive"
		) {
			itemsHtml += row("tag-insight", "Measured", insight.summary);
		}

		// 8. Swiss rehab
		if (hasRehab) {
			if (t1.length > 0) {
				const names = t1
					.map(
						(e) => `<strong>${escapeHtml(e.name)}</strong> (${e.penalty} pts)`,
					)
					.join(" • ");
				itemsHtml += row("tag-rehab", "Tier 1", `Send Today: ${names}`);
			}
			if (t2.length > 0) {
				const names = t2
					.map(
						(e) => `<strong>${escapeHtml(e.name)}</strong> (${e.penalty} pts)`,
					)
					.join(" • ");
				itemsHtml += row("tag-rehab-sub", "Tier 2", `Send Next: ${names}`);
			}
		}

		const title = hasRequiredWork
			? "Immediate Action Items"
			: planState === "holding"
				? "Operations Status: Rebalance Holding, Nothing Outstanding"
				: "Operations Status: No Change Required";

		return `
			<div class="directives-card${hasRequiredWork ? " warning" : ""}">
				<div class="directives-header">
					<span class="directives-title">${title}</span>
				</div>
				<div class="directives-list" style="margin-top: 8px;">
					${itemsHtml}
				</div>
			</div>
		`;
	}

	/**
	 * The conditions the analysis says should lower a reader's confidence in its
	 * own advice, printed rather than swallowed: they are the difference between
	 * "the rig is fine" and "the rig looks fine because the data cannot tell".
	 */
	private renderAnalysisWarnings(
		analysis: CompanyStateResponse["analysis"],
	): string {
		const warnings = analysis?.warnings ?? [];
		if (warnings.length === 0) return "";

		const rows = warnings
			.map(
				(warning) => `
			<div class="directive-row">
				<span class="directive-tag tag-insight">Caveat</span>
				<span class="directive-text" style="color: #94a3b8;">${escapeHtml(warning)}</span>
			</div>
		`,
			)
			.join("");

		return `
			<div class="directives-card" style="margin-top: 10px;">
				<div class="directives-header">
					<span class="directives-title">Data Caveats (${warnings.length})</span>
				</div>
				<div class="directives-list" style="margin-top: 8px;">
					${rows}
				</div>
			</div>
		`;
	}

	private renderKpiCards(
		kpis: CompanyKPIs,
		directives: CompanyDirectives | null,
	): string {
		const discarded = directives?.capacityRebalance.discardedBarrelsPerDay ?? 0;

		return `
			<div class="kpi-grid" style="grid-template-columns: 1fr; margin-top: 12px;">
				<!-- Stock -->
				<div class="kpi-card">
					<div class="kpi-label">Stock</div>
					<div class="kpi-value val-purple">
						${formatCompactNumber(kpis.inStock, 0)} • ${kpis.fillPct}%
					</div>
				</div>
				${
					discarded > 0
						? `
				<!-- Discarded output: barrels produced that the rig cannot clear -->
				<div class="kpi-card" style="border-color: rgba(244, 63, 94, 0.4);">
					<div class="kpi-label">Discarded Output</div>
					<div class="kpi-value negative">
						${formatCompactNumber(discarded, 0)} bbl/day
					</div>
				</div>
				`
						: ""
				}
			</div>
		`;
	}

	private renderChartOnly(): void {
		const chartWrap = this.container.querySelector<HTMLElement>(
			"#company-chart-canvas-wrap",
		);
		const scrubStrip = this.container.querySelector<HTMLElement>(
			"#company-chart-scrub-strip",
		);
		if (!chartWrap) return;

		renderCompanySvgChart(chartWrap, {
			data: this.history,
			mode: this.currentChartMode,
			width: chartWrap.clientWidth || 540,
			height: 220,
			onScrub: (item) => {
				if (!scrubStrip) return;
				if (!item) {
					scrubStrip.innerHTML = `
						<span>Hover or drag across chart to inspect daily breakdown</span>
					`;
					return;
				}

				const dateObj = new Date(
					item.isoDate.length === 10
						? `${item.isoDate}T00:00:00`
						: item.isoDate,
				);
				const dateFormatted = !Number.isNaN(dateObj.getTime())
					? dateObj.toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
							year: "numeric",
						})
					: item.isoDate;

				if (this.currentChartMode === "financials") {
					const sign = item.profit >= 0 ? "+" : "";
					scrubStrip.innerHTML = `
						<span style="color: #f8fafc; font-weight: 700;">${dateFormatted}</span>
						<span style="color: #10b981;">Rev: ${formatMoney(item.income)}</span>
						<span style="color: #f43f5e;">Exp: ${formatMoney(item.expenses)}</span>
						<span style="color: #38bdf8; font-weight: 700;">Profit: ${sign}${formatMoney(item.profit)}</span>
					`;
				} else {
					// `producedEstimated` flags a day whose figure was filled in for
					// display because extraction could not be measured from a stock
					// delta; the chart says so instead of presenting it as extraction.
					const producedLabel = item.producedEstimated
						? `Produced: ${formatNumber(item.produced)} bbl (est.)`
						: `Produced: ${formatNumber(item.produced)} bbl`;
					scrubStrip.innerHTML = `
						<span style="color: #f8fafc; font-weight: 700;">${dateFormatted}</span>
						<span style="color: #a855f7;">Stock: ${formatNumber(item.stock)} bbl</span>
						<span style="color: #f59e0b;">Sold: ${formatNumber(item.sold)} bbl</span>
						<span style="color: #38bdf8; font-weight: 700;">${producedLabel}</span>
					`;
				}
			},
		});
	}

	private renderWeeklyTableHtml(): string {
		const wtd = this.weeklyLogs;
		if (!wtd) {
			return `
				<div class="weekly-table-card">
					<div style="padding: 24px; text-align: center; color: #94a3b8; font-size: 12px; font-family: monospace;">
						Loading weekly logs...
					</div>
				</div>
			`;
		}

		const orderedEntries = sortRows(
			wtd.entries,
			this.ledgerSort,
			LEDGER_SORT_ACCESSORS,
		);

		const rowsHtml =
			wtd.entries.length === 0
				? `<tr><td colspan="8" style="text-align: center; color: #94a3b8; padding: 20px;">No snapshot entries recorded for this accounting week.</td></tr>`
				: orderedEntries
						.map((e) => {
							const profitSign = e.profit >= 0 ? "+" : "";
							const profitClass = e.profit >= 0 ? "profit-pos" : "profit-neg";
							// `producedBarrels` already arrives fully computed from
							// buildWeekToDateLogEntries; do not re-derive a fallback here.
							const prodStr = formatCompactNumber(e.producedBarrels ?? 0, 0);
							return `
								<tr>
									<td class="td-day">${e.dayOfWeek}</td>
									<td class="td-date">${e.isoDate.slice(5)}</td>
									<td class="td-num">${formatCompactNumber(e.revenue, 1)}</td>
									<td class="td-num">${formatCompactNumber(e.expenses, 1)}</td>
									<td class="td-num ${profitClass}">${profitSign}${formatCompactNumber(e.profit, 1)}</td>
									<td class="td-num">${formatCompactNumber(e.soldBarrels, 0)}</td>
									<td class="td-num">${prodStr}</td>
									<td class="td-num">$${e.barrelPrice}</td>
								</tr>
							`;
						})
						.join("");

		const totProfitSign = wtd.totals.totalProfit >= 0 ? "+" : "";
		const totProfitClass =
			wtd.totals.totalProfit >= 0 ? "profit-pos" : "profit-neg";

		return `
			<div class="weekly-table-card">
				<!-- Table Header with Accounting Week Pagination -->
				<div class="weekly-paginator">
					<div class="paginator-title">
						<span>Weekly Ledger</span>
						<span class="paginator-range">${wtd.weekLabel}</span>
					</div>
					<div class="paginator-controls">
						<button id="btn-week-prev" class="btn-paginator" ${wtd.hasPrev ? "" : "disabled"} title="Previous Week">
							<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="15 18 9 12 15 6"></polyline>
							</svg>
							<span>Prev Week</span>
						</button>
						<button id="btn-week-curr" class="btn-paginator ${wtd.offset === 0 ? "active" : ""}" title="Current Week">
							Current Week
						</button>
						<button id="btn-week-next" class="btn-paginator" ${wtd.hasNext ? "" : "disabled"} title="Next Week">
							<span>Next Week</span>
							<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
						</button>
					</div>
				</div>

				<!-- Responsive Table -->
				<div class="weekly-table-scroll">
					<table class="company-ledger-table sortable-table">
						<thead>
							<tr>
								${this.ledgerHeader("dayOfWeek", "Day")}
								${this.ledgerHeader("isoDate", "Date")}
								${this.ledgerHeader("revenue", "Revenue")}
								${this.ledgerHeader("expenses", "Expenses")}
								${this.ledgerHeader("profit", "Net Profit")}
								${this.ledgerHeader("soldBarrels", "Sold")}
								${this.ledgerHeader("producedBarrels", "Produced")}
								<th>Price</th>
							</tr>
						</thead>
						<tbody>
							${rowsHtml}
						</tbody>
						<tfoot>
							<tr class="tfoot-totals">
								<td colspan="2" class="td-total-label">Week Totals</td>
								<td class="td-num">${formatCompactNumber(wtd.totals.totalRevenue, 1)}</td>
								<td class="td-num">${formatCompactNumber(wtd.totals.totalExpenses, 1)}</td>
								<td class="td-num ${totProfitClass}">${totProfitSign}${formatCompactNumber(wtd.totals.totalProfit, 1)}</td>
								<td class="td-num">${formatCompactNumber(wtd.totals.totalSold, 0)}</td>
								<td class="td-num">${formatCompactNumber(wtd.totals.totalProduced, 0)}</td>
								<td class="td-num">$${wtd.totals.avgPrice}</td>
							</tr>
						</tfoot>
					</table>
				</div>
			</div>
		`;
	}

	private renderWeeklyTableOnly(): void {
		const tableContainer = this.container.querySelector<HTMLElement>(
			"#company-weekly-table-container",
		);
		if (!tableContainer) return;

		tableContainer.innerHTML = this.renderWeeklyTableHtml();
		this.bindPaginatorEvents();
		this.bindLedgerSort();
	}

	/** A ledger column header that sorts the week, by mouse or keyboard. */
	private ledgerHeader(key: LedgerSortKey, label: string): string {
		const active = this.ledgerSort.key === key;
		const ariaSort = active
			? this.ledgerSort.direction === "asc"
				? "ascending"
				: "descending"
			: "none";
		return `
			<th class="sortable ${active ? "sorted" : ""}" data-sort="${key}"
				tabindex="0" role="button" aria-sort="${ariaSort}"
				title="Sort by ${escapeHtml(label)}">
				${escapeHtml(label)} ${sortIndicator(active, this.ledgerSort.direction)}
			</th>
		`;
	}

	private bindLedgerSort(): void {
		const tableContainer = this.container.querySelector<HTMLElement>(
			"#company-weekly-table-container",
		);
		if (!tableContainer) return;

		bindSortableHeaders(tableContainer, LEDGER_SORT_KEYS, (key) => {
			this.ledgerSort = nextSortState(
				this.ledgerSort,
				key as LedgerSortKey,
				LEDGER_SORT_DEFAULT[key as LedgerSortKey],
			);
			GM_setValue(STORAGE_KEYS.companySort, this.ledgerSort);
			// Only the table is re-rendered, so the chart and its scrubber survive.
			this.renderWeeklyTableOnly();
		});
	}

	private bindEvents(): void {
		this.container
			.querySelectorAll<HTMLButtonElement>("button[data-chart-mode]")
			.forEach((btn) => {
				btn.addEventListener("click", () => {
					const mode = btn.getAttribute("data-chart-mode") as
						| "financials"
						| "production";
					if (mode && mode !== this.currentChartMode) {
						this.container
							.querySelectorAll<HTMLButtonElement>("button[data-chart-mode]")
							.forEach((b) => {
								b.classList.remove("active");
							});
						btn.classList.add("active");
						this.setChartMode(mode);
					}
				});
			});

		this.bindPaginatorEvents();
	}

	private bindPaginatorEvents(): void {
		this.container
			.querySelector("#btn-week-prev")
			?.addEventListener("click", () => {
				this.setWeekOffset(this.currentWeekOffset + 1);
			});

		this.container
			.querySelector("#btn-week-curr")
			?.addEventListener("click", () => {
				this.setWeekOffset(0);
			});

		this.container
			.querySelector("#btn-week-next")
			?.addEventListener("click", () => {
				if (this.currentWeekOffset > 0) {
					this.setWeekOffset(this.currentWeekOffset - 1);
				}
			});
	}
}
