import { apiClient } from "../api";
import {
	formatCompactNumber,
	formatMoney,
	formatNumber,
	STORAGE_KEYS,
} from "../config";
import type {
	CompanyDirectives,
	CompanyHistoryEntry,
	CompanyKPIs,
	CompanyProfile,
	CompanyStateResponse,
	CompanyWeeklyLogsResponse,
} from "../types";
import { renderCompanySvgChart } from "../ui/svg-chart";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

export class CompanyTab {
	private container: HTMLElement;
	private state: CompanyStateResponse | null = null;
	private weeklyLogs: CompanyWeeklyLogsResponse | null = null;
	private history: CompanyHistoryEntry[] = [];
	private currentChartMode: "financials" | "production" = "financials";
	private currentWeekOffset = 0;
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

		const { profile, kpis, directives } = this.state;

		this.container.innerHTML = `
			<!-- 1. Directives & Action Items Card -->
			${this.renderDirectivesCard(directives, profile)}

			<!-- 2. Minimal KPI Cards -->
			${this.renderKpiCards(kpis)}

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
				<div id="company-chart-scrub-strip" class="chart-scrub-strip">
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
		this.renderChartOnly();
	}

	private renderDirectivesCard(
		directives: CompanyDirectives | null,
		_profile: CompanyProfile | null,
	): string {
		if (!directives) return "";

		const hasTransfers = directives.roleTransfers.length > 0;
		const hasPrice = directives.pricing.isChanged;
		const hasAd = directives.adSpend.isChanged;
		const t1 = directives.rehabTiers.tier1;
		const t2 = directives.rehabTiers.tier2;
		const hasRehab = t1.length > 0 || t2.length > 0;

		const isAllOptimal = !hasTransfers && !hasPrice && !hasAd && !hasRehab;

		if (isAllOptimal) {
			return `
				<div class="directives-card optimal">
					<div class="directives-header">
						<span class="directives-title">Operations Status: All Systems Optimal</span>
					</div>
					<div class="directives-body" style="font-size: 12px; color: #94a3b8; margin-top: 4px;">
						Roster is fully aligned with blueprint, pricing and advertising spend are at equilibrium, and all staff are healthy.
					</div>
				</div>
			`;
		}

		let itemsHtml = "";

		// Role transfers
		if (hasTransfers) {
			const transfersList = directives.roleTransfers
				.map(
					(t) => `
					<div class="directive-row">
						<span class="directive-tag tag-role">Role</span>
						<span class="directive-text"><strong>${t.name}</strong> (${t.statsStr}): ${t.fromRole} ➔ <strong>${t.toRole}</strong></span>
					</div>
				`,
				)
				.join("");
			itemsHtml += transfersList;
		}

		// Price adjustment
		if (hasPrice) {
			itemsHtml += `
				<div class="directive-row">
					<span class="directive-tag tag-price">Price</span>
					<span class="directive-text">Adjust Barrel Price: <strong>${directives.pricing.formatted}</strong></span>
				</div>
			`;
		}

		// Ad budget adjustment
		if (hasAd) {
			itemsHtml += `
				<div class="directive-row">
					<span class="directive-tag tag-ad">Ad Spend</span>
					<span class="directive-text">Adjust Ad Budget: <strong>${directives.adSpend.formatted}</strong></span>
				</div>
			`;
		}

		// Swiss rehab
		if (hasRehab) {
			if (t1.length > 0) {
				const names = t1
					.map((e) => `<strong>${e.name}</strong> (${e.penalty} pts)`)
					.join(" • ");
				itemsHtml += `
					<div class="directive-row">
						<span class="directive-tag tag-rehab">Tier 1 Rehab</span>
						<span class="directive-text">Send Today: ${names}</span>
					</div>
				`;
			}
			if (t2.length > 0) {
				const names = t2
					.map((e) => `<strong>${e.name}</strong> (${e.penalty} pts)`)
					.join(" • ");
				itemsHtml += `
					<div class="directive-row">
						<span class="directive-tag tag-rehab-sub">Tier 2 Rehab</span>
						<span class="directive-text">Send Next: ${names}</span>
					</div>
				`;
			}
		}

		return `
			<div class="directives-card warning">
				<div class="directives-header">
					<span class="directives-title">Immediate Action Items</span>
				</div>
				<div class="directives-list" style="margin-top: 8px;">
					${itemsHtml}
				</div>
			</div>
		`;
	}

	private renderKpiCards(kpis: CompanyKPIs): string {
		return `
			<div class="kpi-grid" style="grid-template-columns: 1fr; margin-top: 12px;">
				<!-- Stock -->
				<div class="kpi-card">
					<div class="kpi-label">Stock</div>
					<div class="kpi-value val-purple">
						${formatCompactNumber(kpis.inStock, 0)} • ${kpis.fillPct}%
					</div>
				</div>
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
					scrubStrip.innerHTML = `
						<span style="color: #f8fafc; font-weight: 700;">${dateFormatted}</span>
						<span style="color: #a855f7;">Stock: ${formatNumber(item.stock)} bbl</span>
						<span style="color: #f59e0b;">Sold: ${formatNumber(item.sold)} bbl</span>
						<span style="color: #38bdf8; font-weight: 700;">Produced: ${formatNumber(item.produced)} bbl</span>
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

		const rowsHtml =
			wtd.entries.length === 0
				? `<tr><td colspan="8" style="text-align: center; color: #64748b; padding: 20px;">No snapshot entries recorded for this accounting week.</td></tr>`
				: wtd.entries
						.map((e) => {
							const profitSign = e.profit >= 0 ? "+" : "";
							const profitClass = e.profit >= 0 ? "profit-pos" : "profit-neg";
							const prodVal =
								e.producedBarrels !== undefined && e.producedBarrels > 0
									? e.producedBarrels
									: e.soldBarrels > 0
										? e.soldBarrels
										: 0;
							const prodStr = formatCompactNumber(prodVal, 0);
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
					<table class="company-ledger-table">
						<thead>
							<tr>
								<th>Day</th>
								<th>Date</th>
								<th>Revenue</th>
								<th>Expenses</th>
								<th>Net Profit</th>
								<th>Sold</th>
								<th>Produced</th>
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
