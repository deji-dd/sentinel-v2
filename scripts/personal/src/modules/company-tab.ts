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

		const { kpis, directives } = this.state;

		this.container.innerHTML = `
			<!-- 1. Directives & Action Items Card -->
			${this.renderDirectivesCard(directives)}

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
		const capacityActions =
			rebalance.extractionBound && rebalance.actions.length > 0
				? rebalance.actions
				: [];
		const structuralAdvice = directives.stock.structuralAdvice;
		const insight = directives.sellThrough;

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

		const row = (tagClass: string, tag: string, text: string) => `
			<div class="directive-row">
				<span class="directive-tag ${tagClass}">${tag}</span>
				<span class="directive-text">${text}</span>
			</div>
		`;

		let itemsHtml = "";

		// 1. Capacity rebalance (roster re-arrangement)
		if (capacityActions.length > 0) {
			if (rebalance.discardedBarrelsPerDay > 0) {
				itemsHtml += row(
					"tag-capacity",
					"Output",
					`<strong>${formatNumber(rebalance.discardedBarrelsPerDay)}</strong> bbl/day (~${formatMoney(rebalance.discardedValuePerDay)}/day) produced beyond what the rig clears and discarded while storage is full.`,
				);
			}
			for (const action of capacityActions) {
				const label =
					action.kind === "rebalance"
						? "Rebalance"
						: action.kind === "hire"
							? "Hire"
							: "Storage";
				const revert = action.temporary
					? ' <em style="color: #94a3b8;">(revert once stock normalises)</em>'
					: "";
				itemsHtml += row("tag-capacity", label, `${action.reason}${revert}`);
			}
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
						`<strong>${t.name}</strong> (${t.statsStr}): ${t.fromRole} ➔ <strong>${t.toRole}</strong>`,
					),
				)
				.join("");
		}

		// 4. Price / ad
		if (hasPrice) {
			itemsHtml += row(
				"tag-price",
				"Price",
				`Adjust Barrel Price: <strong>${directives.pricing.formatted}</strong>`,
			);
		}
		if (hasAd) {
			itemsHtml += row(
				"tag-ad",
				"Ad Spend",
				`Adjust Ad Budget: <strong>${directives.adSpend.formatted}</strong>`,
			);
		}

		// 5. Price-response insight: measured, not assumed.
		if (
			insight.verdict === "unresponsive" ||
			insight.verdict === "partially_responsive"
		) {
			itemsHtml += row("tag-insight", "Measured", insight.summary);
		}

		// 6. Swiss rehab
		if (hasRehab) {
			if (t1.length > 0) {
				const names = t1
					.map((e) => `<strong>${e.name}</strong> (${e.penalty} pts)`)
					.join(" • ");
				itemsHtml += row("tag-rehab", "Tier 1", `Send Today: ${names}`);
			}
			if (t2.length > 0) {
				const names = t2
					.map((e) => `<strong>${e.name}</strong> (${e.penalty} pts)`)
					.join(" • ");
				itemsHtml += row("tag-rehab-sub", "Tier 2", `Send Next: ${names}`);
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
