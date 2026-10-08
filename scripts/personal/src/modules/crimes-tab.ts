import { apiClient } from "../api";
import {
	escapeHtml,
	formatMoney,
	formatNumber,
	parseDateOnly,
	STORAGE_KEYS,
} from "../config";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

import type {
	CrimeAnalyticsResponse,
	CrimeCategoryAnalytics,
	CrimeLedgerState,
	DailyCrimeTimeline,
} from "../types";
import { renderSvgChart } from "../ui/svg-chart";
import {
	bindSortableHeaders,
	matchesQuery,
	nextSortState,
	type SortAccessors,
	type SortDirection,
	type SortState,
	sortIndicator,
	sortRows,
} from "../ui/table-sort";

type CrimeSortKey =
	| "crimeName"
	| "count"
	| "nerve"
	| "value"
	| "efficiency"
	| "percentage";

/** Every column the category table can be ordered by. */
const CRIME_SORT_KEYS: CrimeSortKey[] = [
	"crimeName",
	"count",
	"nerve",
	"value",
	"efficiency",
	"percentage",
];

/** Columns that read best largest-first. */
const CRIME_SORT_DEFAULT: Record<CrimeSortKey, SortDirection> = {
	crimeName: "asc",
	count: "desc",
	nerve: "desc",
	value: "desc",
	efficiency: "desc",
	percentage: "desc",
};

const CRIME_SORT_ACCESSORS: SortAccessors<
	CrimeCategoryAnalytics,
	CrimeSortKey
> = {
	crimeName: (row) => row.crimeName,
	count: (row) => row.count,
	nerve: (row) => row.nerve,
	value: (row) => row.value,
	efficiency: (row) => row.efficiency,
	percentage: (row) => row.percentage,
};

export class CrimesTab {
	private container: HTMLElement;
	private state: CrimeLedgerState | null = null;
	private analytics: CrimeAnalyticsResponse | null = null;
	private currentTimeframe: "7d" | "30d" | "90d" | "all" = "30d";
	private currentMetricMode: "financials" | "activity" = "financials";
	private sort: SortState<CrimeSortKey> = {
		key: "efficiency",
		direction: "desc",
	};
	private filterQuery = "";
	private onOpenSettings: () => void;

	constructor(container: HTMLElement, onOpenSettings: () => void) {
		this.container = container;
		this.onOpenSettings = onOpenSettings;
		// The selected period is restored on load: without it the cached payload
		// (of whatever period was last fetched) rendered under a "30D" pill.
		const stored = GM_getValue<string>(STORAGE_KEYS.crimesTimeframe, "30d");
		if (
			stored === "7d" ||
			stored === "30d" ||
			stored === "90d" ||
			stored === "all"
		) {
			this.currentTimeframe = stored;
		}
	}

	public async init(): Promise<void> {
		this.state = apiClient.getCachedState();
		this.analytics = apiClient.getCachedAnalytics();
		this.render();
		await this.refresh();
	}

	/** Guards against an older, slower response overwriting a newer selection. */
	private requestSeq = 0;

	public async refresh(): Promise<void> {
		const seq = ++this.requestSeq;
		try {
			const [stateRes, analyticsRes] = await Promise.all([
				apiClient.getCrimeLedgerState(),
				apiClient.getCrimeAnalytics(this.currentTimeframe),
			]);
			if (seq !== this.requestSeq) return;
			this.state = stateRes;
			this.analytics = analyticsRes;
			this.render();
		} catch (err) {
			if (seq !== this.requestSeq) return;
			console.error("[Blasted's Script] Error refreshing crime data:", err);
			this.renderError(err instanceof Error ? err.message : String(err));
		}
	}

	public setTimeframe(tf: "7d" | "30d" | "90d" | "all"): void {
		this.currentTimeframe = tf;
		GM_setValue(STORAGE_KEYS.crimesTimeframe, tf);
		void this.refresh();
	}

	public setMetricMode(mode: "financials" | "activity"): void {
		this.currentMetricMode = mode;
		this.renderChartOnly();
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
						? `<button id="btn-fix-key" class="btn-primary" style="margin-top: 8px; width: fit-content;">Configure API Key in Settings</button>`
						: `<button id="btn-retry" class="btn-primary" style="margin-top: 8px; width: fit-content;">Retry Connection</button>`
				}
			</div>
		`;

		this.container
			.querySelector("#btn-fix-key")
			?.addEventListener("click", () => {
				this.onOpenSettings();
			});

		this.container
			.querySelector("#btn-retry")
			?.addEventListener("click", () => {
				this.refresh();
			});
	}

	public render(): void {
		if (!this.state && !this.analytics) {
			this.container.innerHTML = `
				<div style="padding: 40px 0; text-align: center; color: #94a3b8;">
					Loading Crime Ledger Analytics...
				</div>
			`;
			return;
		}

		const totalCrimes =
			this.analytics?.kpis.totalCrimes ?? this.state?.totalInDb ?? 0;
		const totalNerve =
			this.analytics?.kpis.totalNerve ?? this.state?.totalNerveSpent ?? 0;
		const totalValue =
			this.analytics?.kpis.totalValue ?? this.state?.totalLootValue ?? 0;
		const overallEfficiency =
			this.analytics?.kpis.overallEfficiency ??
			(totalNerve > 0 ? totalValue / totalNerve : 0);

		const topProfit = this.state?.topProfitCategory;
		const topEff = this.state?.topEfficientCategory;

		this.container.innerHTML = `
			<!-- KPI Grid -->
			<div class="kpi-grid">
				<div class="kpi-card">
					<div class="kpi-label">Crimes Volume</div>
					<div class="kpi-value val-blue">${formatNumber(totalCrimes)}</div>
					<div class="kpi-sub">Total recorded attempts</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Nerve Expended</div>
					<div class="kpi-value val-amber">${formatNumber(totalNerve)}</div>
					<div class="kpi-sub">Avg ${totalCrimes > 0 ? (totalNerve / totalCrimes).toFixed(1) : 0} N/crime</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Total Loot Value</div>
					<div class="kpi-value val-green">${formatMoney(totalValue)}</div>
					<div class="kpi-sub">Net payout & item valuation</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Overall ROI</div>
					<div class="kpi-value val-green">${formatMoney(overallEfficiency)}/N</div>
					<div class="kpi-sub">Average profit per nerve</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Top Profit Earner</div>
					<div class="kpi-value" style="font-size: 15px; color: #f1f5f9;">${topProfit?.crimeName ?? "N/A"}</div>
					<div class="kpi-sub">${topProfit ? formatMoney(topProfit.value) : ""}</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Most Efficient</div>
					<div class="kpi-value" style="font-size: 15px; color: #34d399;">${topEff?.crimeName ?? "N/A"}</div>
					<div class="kpi-sub">${topEff ? `${formatMoney(topEff.efficiency)}/N` : ""}</div>
				</div>
			</div>

			<!-- Timeline Chart Card -->
			<div class="chart-card">
				<div class="chart-header">
					<div class="chart-title">Historical Crime Performance</div>
					<div class="chart-controls">
						<!-- Metric Mode Pills -->
						<div class="btn-pill-group">
							<button class="btn-pill ${this.currentMetricMode === "financials" ? "active" : ""}" data-metric="financials">Financials</button>
							<button class="btn-pill ${this.currentMetricMode === "activity" ? "active" : ""}" data-metric="activity">Activity</button>
						</div>
						<!-- Timeframe Pills -->
						<div class="btn-pill-group">
							<button class="btn-pill ${this.currentTimeframe === "7d" ? "active" : ""}" data-tf="7d">7D</button>
							<button class="btn-pill ${this.currentTimeframe === "30d" ? "active" : ""}" data-tf="30d">30D</button>
							<button class="btn-pill ${this.currentTimeframe === "90d" ? "active" : ""}" data-tf="90d">90D</button>
							<button class="btn-pill ${this.currentTimeframe === "all" ? "active" : ""}" data-tf="all">All</button>
						</div>
					</div>
				</div>

				<!-- Scrubber Status Strip -->
				<div id="chart-scrub-strip" class="chart-scrub-strip" role="status" aria-live="polite">
					<span>Scrub chart to view daily breakdown</span>
				</div>

				<!-- Responsive SVG Chart Canvas -->
				<div id="chart-canvas-wrap" class="chart-svg-wrap"></div>
			</div>

			<!-- Categories Efficiency Table -->
			<div class="table-card">
				<div class="table-header-title">
					<span>Crime Category Rankings</span>
					<span id="crime-table-count" class="table-header-meta">${escapeHtml(this.tableSummary())}</span>
				</div>
				<div class="table-filter-row">
					<label class="table-filter">
						<span class="sr-only">Filter crimes by name</span>
						<input id="crime-filter" type="search" class="input-text" placeholder="Filter by crime name…" value="${escapeHtml(this.filterQuery)}" />
					</label>
				</div>
				<div class="table-wrap">
					<table class="sortable-table">
						<thead>
							<tr>
								${this.sortableHeader("crimeName", "Crime", "text-left")}
								${this.sortableHeader("count", "Attempts", "text-right")}
								${this.sortableHeader("nerve", "Nerve", "text-right")}
								${this.sortableHeader("value", "Loot Value", "text-right")}
								${this.sortableHeader("efficiency", "ROI ($/N)", "text-right")}
								${this.sortableHeader("percentage", "Share", "text-right")}
							</tr>
						</thead>
						<tbody id="crime-category-rows">
							${this.renderCategoryRows()}
						</tbody>
					</table>
				</div>
			</div>
		`;

		this.attachEventListeners();
		this.attachTableEvents();
		this.renderChartOnly();
	}

	/** A column header that sorts the table, reachable by mouse and keyboard. */
	private sortableHeader(
		key: CrimeSortKey,
		label: string,
		align: string,
	): string {
		const active = this.sort.key === key;
		const ariaSort = active
			? this.sort.direction === "asc"
				? "ascending"
				: "descending"
			: "none";
		return `
			<th class="${align} sortable ${active ? "sorted" : ""}" data-sort="${key}"
				tabindex="0" role="button" aria-sort="${ariaSort}"
				title="Sort by ${escapeHtml(label)}">
				${escapeHtml(label)} ${sortIndicator(active, this.sort.direction)}
			</th>
		`;
	}

	private attachTableEvents(): void {
		bindSortableHeaders(this.container, CRIME_SORT_KEYS, (key) => {
			this.sort = nextSortState(
				this.sort,
				key as CrimeSortKey,
				CRIME_SORT_DEFAULT[key as CrimeSortKey],
			);
			GM_setValue(STORAGE_KEYS.crimesSort, this.sort);
			this.rerenderCategoryTable();
		});

		const filterInput =
			this.container.querySelector<HTMLInputElement>("#crime-filter");
		filterInput?.addEventListener("input", () => {
			this.filterQuery = filterInput.value;
			// Only the rows and the count change, so the input keeps focus and its
			// caret while the list narrows under it.
			this.rerenderCategoryTable();
		});
	}

	private rerenderCategoryTable(): void {
		const container = this.container.querySelector<HTMLElement>(
			"#crime-category-rows",
		);
		if (container) container.innerHTML = this.renderCategoryRows();

		const countEl =
			this.container.querySelector<HTMLElement>("#crime-table-count");
		if (countEl) countEl.textContent = this.tableSummary();

		// Header state: arrows and aria-sort, without re-rendering the headers.
		this.container
			.querySelectorAll<HTMLElement>("th[data-sort]")
			.forEach((header) => {
				const key = header.getAttribute("data-sort") as CrimeSortKey | null;
				if (!key) return;
				const active = this.sort.key === key;
				header.classList.toggle("sorted", active);
				header.setAttribute(
					"aria-sort",
					active
						? this.sort.direction === "asc"
							? "ascending"
							: "descending"
						: "none",
				);
				const indicator = header.querySelector(".sort-hint, .sort-active");
				if (indicator) {
					indicator.outerHTML = sortIndicator(active, this.sort.direction);
				}
			});
	}

	private tableSummary(): string {
		const total = this.categoryRows().length;
		const shown = this.sortedCategoryRows().length;
		const column =
			this.sort.key === "crimeName"
				? "crime name"
				: this.sort.key === "count"
					? "attempts"
					: this.sort.key === "nerve"
						? "nerve"
						: this.sort.key === "value"
							? "loot value"
							: this.sort.key === "percentage"
								? "share"
								: "ROI ($/N)";
		const filtered = shown !== total ? `${shown} of ${total}` : `${total}`;
		return `${filtered} · sorted by ${column} ${this.sort.direction === "asc" ? "↑" : "↓"}`;
	}

	private categoryRows(): CrimeCategoryAnalytics[] {
		return this.analytics?.categories ?? this.state?.allTimeCategories ?? [];
	}

	private sortedCategoryRows(): CrimeCategoryAnalytics[] {
		const filtered = this.categoryRows().filter((row) =>
			matchesQuery(row.crimeName, this.filterQuery),
		);
		return sortRows(filtered, this.sort, CRIME_SORT_ACCESSORS);
	}

	private renderCategoryRows(): string {
		const categories = this.categoryRows();
		if (categories.length === 0) {
			return `<tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 20px;">No categories classified yet.</td></tr>`;
		}

		const sorted = this.sortedCategoryRows();
		if (sorted.length === 0) {
			return `<tr><td colspan="6" style="text-align: center; color: #94a3b8; padding: 20px;">No crime matches “${escapeHtml(this.filterQuery.trim())}”.</td></tr>`;
		}

		return sorted
			.map((cat) => {
				return `
					<tr>
						<td class="text-left" style="font-weight: 600; color: #f1f5f9;">${escapeHtml(cat.crimeName)}</td>
						<td class="text-right">${formatNumber(cat.count)}</td>
						<td class="text-right" style="color: #fbbf24;">${formatNumber(cat.nerve)}</td>
						<td class="text-right" style="color: #38bdf8;">${formatMoney(cat.value)}</td>
						<td class="text-right" style="font-weight: 700; color: #34d399;">${formatMoney(cat.efficiency)}/N</td>
						<td class="text-right" style="color: #94a3b8;">${cat.percentage.toFixed(1)}%</td>
					</tr>
				`;
			})
			.join("");
	}

	private renderChartOnly(): void {
		const chartWrap =
			this.container.querySelector<HTMLElement>("#chart-canvas-wrap");
		const scrubStrip =
			this.container.querySelector<HTMLElement>("#chart-scrub-strip");
		if (!chartWrap) return;

		const timelineData = this.analytics?.timeline ?? [];

		renderSvgChart(chartWrap, {
			data: timelineData,
			metricMode: this.currentMetricMode,
			width: chartWrap.clientWidth || 540,
			height: 220,
			onScrub: (item: DailyCrimeTimeline | null) => {
				if (!scrubStrip) return;
				if (!item) {
					scrubStrip.innerHTML = `
						<span>Scrub chart to view daily breakdown</span>
					`;
					return;
				}

				const dateObj = parseDateOnly(item.date);
				const dateFormatted = !Number.isNaN(dateObj.getTime())
					? dateObj.toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
							year: "numeric",
						})
					: item.date;

				if (this.currentMetricMode === "financials") {
					scrubStrip.innerHTML = `
						<span style="color: #f8fafc; font-weight: 700;">${dateFormatted}</span>
						<span style="color: #38bdf8;">Loot: ${formatMoney(item.value)}</span>
						<span style="color: #34d399; font-weight: 700;">ROI: ${formatMoney(item.efficiency)}/N</span>
						<span style="color: #fbbf24;">Nerve: ${item.nerve}</span>
					`;
				} else {
					scrubStrip.innerHTML = `
						<span style="color: #f8fafc; font-weight: 700;">${dateFormatted}</span>
						<span style="color: #38bdf8;">Volume: ${formatNumber(item.count)} attempts</span>
						<span style="color: #fbbf24; font-weight: 700;">Nerve: ${item.nerve}</span>
						<span style="color: #34d399;">Loot: ${formatMoney(item.value)}</span>
					`;
				}
			},
		});
	}

	private attachEventListeners(): void {
		// Timeframe toggles
		this.container
			.querySelectorAll<HTMLButtonElement>("button[data-tf]")
			.forEach((btn) => {
				btn.addEventListener("click", () => {
					const tf = btn.getAttribute("data-tf") as
						| "7d"
						| "30d"
						| "90d"
						| "all";
					if (tf && tf !== this.currentTimeframe) {
						this.setTimeframe(tf);
					}
				});
			});

		// Metric toggles
		this.container
			.querySelectorAll<HTMLButtonElement>("button[data-metric]")
			.forEach((btn) => {
				btn.addEventListener("click", () => {
					const metric = btn.getAttribute("data-metric") as
						| "financials"
						| "activity";
					if (metric && metric !== this.currentMetricMode) {
						this.container
							.querySelectorAll<HTMLButtonElement>("button[data-metric]")
							.forEach((b) => {
								b.classList.remove("active");
							});
						btn.classList.add("active");
						this.setMetricMode(metric);
					}
				});
			});
	}
}
