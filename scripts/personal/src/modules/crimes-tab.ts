import { apiClient } from "../api";
import { formatMoney, formatNumber } from "../config";
import type {
	CrimeAnalyticsResponse,
	CrimeLedgerState,
	DailyCrimeTimeline,
} from "../types";
import { renderSvgChart } from "../ui/svg-chart";

export class CrimesTab {
	private container: HTMLElement;
	private state: CrimeLedgerState | null = null;
	private analytics: CrimeAnalyticsResponse | null = null;
	private currentTimeframe: "7d" | "30d" | "90d" | "all" = "30d";
	private currentMetricMode: "financials" | "activity" = "financials";
	private onOpenSettings: () => void;

	constructor(container: HTMLElement, onOpenSettings: () => void) {
		this.container = container;
		this.onOpenSettings = onOpenSettings;
	}

	public async init(): Promise<void> {
		this.state = apiClient.getCachedState();
		this.analytics = apiClient.getCachedAnalytics();
		this.render();
		await this.refresh();
	}

	public async refresh(): Promise<void> {
		try {
			const [stateRes, analyticsRes] = await Promise.all([
				apiClient.getCrimeLedgerState(),
				apiClient.getCrimeAnalytics(this.currentTimeframe),
			]);
			this.state = stateRes;
			this.analytics = analyticsRes;
			this.render();
		} catch (err) {
			console.error("[Blasted's Script] Error refreshing crime data:", err);
			this.renderError(err instanceof Error ? err.message : String(err));
		}
	}

	public setTimeframe(tf: "7d" | "30d" | "90d" | "all"): void {
		this.currentTimeframe = tf;
		this.refresh();
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
				<div id="chart-scrub-strip" class="chart-scrub-strip">
					<span>Scrub chart to view daily breakdown</span>
				</div>

				<!-- Responsive SVG Chart Canvas -->
				<div id="chart-canvas-wrap" class="chart-svg-wrap"></div>
			</div>

			<!-- Categories Efficiency Table -->
			<div class="table-card">
				<div class="table-header-title">
					<span>Crime Category Rankings</span>
					<span style="font-size: 11px; font-weight: normal; color: #94a3b8;">Sorted by Efficiency ($/N)</span>
				</div>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th class="text-left">Crime</th>
								<th class="text-right">Attempts</th>
								<th class="text-right">Nerve</th>
								<th class="text-right">Loot Value</th>
								<th class="text-right">ROI ($/N)</th>
								<th class="text-right">Share</th>
							</tr>
						</thead>
						<tbody>
							${this.renderCategoryRows()}
						</tbody>
					</table>
				</div>
			</div>
		`;

		this.attachEventListeners();
		this.renderChartOnly();
	}

	private renderCategoryRows(): string {
		const categories =
			this.analytics?.categories ?? this.state?.allTimeCategories ?? [];
		if (categories.length === 0) {
			return `<tr><td colspan="6" style="text-align: center; color: #64748b; padding: 20px;">No categories classified yet.</td></tr>`;
		}

		// Sort by efficiency descending
		const sorted = [...categories].sort((a, b) => b.efficiency - a.efficiency);

		return sorted
			.map((cat) => {
				return `
					<tr>
						<td class="text-left" style="font-weight: 600; color: #f1f5f9;">${cat.crimeName}</td>
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

				const dateObj = new Date(item.date);
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
