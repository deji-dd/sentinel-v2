import { ApiError, apiClient } from "../api";
import {
	escapeHtml,
	formatCompactNumber,
	formatMoney,
	formatNumber,
	formatPercent,
	formatTimestamp,
	POLLING_CONFIG,
	STORAGE_KEYS,
} from "../config";
import type {
	StockBenefit,
	StockCatalogEntry,
	StockHolding,
	StockPortfolioResponse,
	StockTerm,
	StockValuationRates,
} from "../types";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

/**
 * The Stocks tab: what the portfolio is worth, what the open term has returned,
 * and whether buying more of anything is worth doing.
 *
 * THE THREE THINGS THIS TAB IS FOR
 *
 * 1. CURRENT TERM, NOT LIFETIME. Every profit and ROI figure covers the holding
 *    period that is open right now — from the moment the position was last
 *    opened — because a lifetime total blends terms that have already been banked
 *    with the one still running.
 *
 * 2. A DASH IS AN ANSWER. Stock benefits pay in money, items, energy, nerve,
 *    happiness, points, ammo packs, random properties or nothing at all. The
 *    server marks each payout as priced or not, and this tab shows a dash plus the
 *    reason instead of a zero that would read as "this stock pays nothing". The
 *    one thing the reader can supply is what a unit of energy, nerve, happiness or
 *    a point is worth to them, which is what turns those stocks into numbers.
 *
 * 3. THE NEXT BLOCK, NOT THE LAST ONE. Each increment costs twice the previous
 *    one, so the yield of the block you would buy next is the decision-relevant
 *    number, not the blended yield of what is already held. The candidate list
 *    sorts by exactly that.
 */

type SortKey = "value" | "profit" | "roi" | "dividends" | "term";
type CatalogFilter = "all" | "active" | "passive" | "unowned";

const DEFAULT_RATES: StockValuationRates = {
	energy: 0,
	nerve: 0,
	happy: 0,
	points: 0,
};

const RESOURCE_LABELS: Record<string, string> = {
	energy: "energy",
	nerve: "nerve",
	happy: "happiness",
	points: "points",
};

const BENEFIT_KIND_LABELS: Record<string, string> = {
	cash: "Cash",
	item: "Item",
	resource: "Resource",
	ammo: "Ammo pack",
	property: "Property",
	passive: "Passive",
};

/** A compact, human label for what one payout is, e.g. "100 energy". */
export function formatBenefitLabel(benefit: StockBenefit): string {
	const { valuation } = benefit;
	if (valuation.kind === "cash" && valuation.cashPerCycle) {
		return formatMoney(valuation.cashPerCycle);
	}
	if (valuation.kind === "resource" && valuation.resourceUnit) {
		return `${formatNumber(valuation.resourceQuantity ?? 0)} ${RESOURCE_LABELS[valuation.resourceUnit] ?? valuation.resourceUnit}`;
	}
	if (valuation.kind === "item" && valuation.itemName) {
		return `${formatNumber(valuation.itemQuantity ?? 1)}× ${valuation.itemName}`;
	}
	return benefit.description;
}

/** What the benefit reads as over a year, in dollars — or why it does not. */
function formatValuePerCycle(benefit: StockBenefit): string {
	if (!benefit.valuation.priced) return "—";
	return `${formatMoney(benefit.valuation.valuePerCycle)}`;
}

export class StocksTab {
	private container: HTMLElement;
	private portfolio: StockPortfolioResponse | null = null;
	private holdingLedger: string | null = null;
	private onOpenSettings: () => void;
	private sortKey: SortKey = "value";
	private filter: CatalogFilter = "all";
	private expanded = new Set<number>();
	private rates: StockValuationRates = { ...DEFAULT_RATES };
	private ratesOpen = false;
	private syncing = false;
	private lastFetchedAt = 0;
	private errorMessage: string | null = null;

	constructor(container: HTMLElement, onOpenSettings: () => void) {
		this.container = container;
		this.onOpenSettings = onOpenSettings;
		this.sortKey = GM_getValue<SortKey>(STORAGE_KEYS.stockSort, "value");
		this.filter = GM_getValue<CatalogFilter>(STORAGE_KEYS.stockFilter, "all");
		this.rates = GM_getValue<StockValuationRates>(STORAGE_KEYS.stockRates, {
			...DEFAULT_RATES,
		});
	}

	public async init(): Promise<void> {
		this.portfolio = apiClient.getCachedStockPortfolio();
		this.render();
		await this.refresh();
	}

	/**
	 * Refreshes the portfolio, at most once every 45 seconds unless forced.
	 *
	 * The drawer polls its active tab every 15s, and this endpoint replays the
	 * whole personal log to rebuild cost bases; re-running it every poll would be
	 * four times the work for a figure that moves when a dividend lands, not when
	 * a second passes.
	 */
	public async refresh(force = false): Promise<void> {
		if (
			!force &&
			Date.now() - this.lastFetchedAt <
				POLLING_CONFIG.STOCK_PORTFOLIO_MIN_INTERVAL_MS
		) {
			return;
		}
		try {
			const [portfolio, state] = await Promise.all([
				apiClient.getStockPortfolio(this.rates),
				apiClient.getStocksLedgerState().catch(() => null),
			]);
			this.portfolio = portfolio;
			this.holdingLedger = state
				? `${formatNumber(state.totalIndexedLogs)} dividends indexed`
				: null;
			this.errorMessage = null;
			this.lastFetchedAt = Date.now();
			this.render();
		} catch (err) {
			this.renderError(err);
		}
	}

	/** Pulls the live position and prices from Torn (explicit user action). */
	private async sync(): Promise<void> {
		if (this.syncing) return;
		this.syncing = true;
		this.render();
		try {
			this.portfolio = await apiClient.syncStockPortfolio(this.rates);
			this.errorMessage = null;
			this.lastFetchedAt = Date.now();
		} catch (err) {
			this.errorMessage = err instanceof Error ? err.message : "Sync failed.";
		} finally {
			this.syncing = false;
			this.render();
		}
	}

	private renderError(err: unknown): void {
		const unauthorized = err instanceof ApiError && err.isUnauthorized;
		this.errorMessage = err instanceof Error ? err.message : String(err);
		this.container.innerHTML = `
			<div class="kpi-card" style="border-color: #ef4444; background: rgba(239, 68, 68, 0.1);">
				<div class="kpi-label" style="color: #f87171;">Connection Alert</div>
				<div style="font-size: 13px; color: #fca5a5; margin: 6px 0;">${escapeHtml(this.errorMessage)}</div>
				${
					unauthorized
						? `<button id="btn-stocks-settings" class="btn-primary" style="margin-top: 8px; width: fit-content;">Configure API Key in Settings</button>`
						: `<button id="btn-stocks-retry" class="btn-primary" style="margin-top: 8px; width: fit-content;">Retry</button>`
				}
			</div>
		`;

		this.container
			.querySelector("#btn-stocks-settings")
			?.addEventListener("click", () => this.onOpenSettings());
		this.container
			.querySelector("#btn-stocks-retry")
			?.addEventListener("click", () => {
				void this.refresh(true);
			});
	}

	public render(): void {
		const portfolio = this.portfolio;
		if (!portfolio) {
			this.container.innerHTML = `
				<div style="padding: 40px 0; text-align: center; color: #94a3b8; font-family: monospace; font-size: 13px;">
					Loading stock portfolio…
				</div>
			`;
			return;
		}

		this.container.innerHTML = `
			${this.renderToolbar(portfolio)}
			${this.renderKpis(portfolio)}
			${this.renderHoldings(portfolio)}
			${this.renderRatesCard()}
			${this.renderCandidates(portfolio)}
			${this.renderWarnings(portfolio)}
		`;

		this.bindEvents();
	}

	// ── Toolbar ──────────────────────────────────────────────────────────────

	private renderToolbar(portfolio: StockPortfolioResponse): string {
		const positionAge = this.ageLabel(portfolio.positionAsOfIso);
		const priceAge = this.ageLabel(portfolio.pricesAsOfIso);
		const held = portfolio.totals.holdingsCount;

		return `
			<div class="stock-toolbar">
				<div class="stock-toolbar-meta">
					<div class="stock-toolbar-title">Stock Portfolio</div>
					<div class="stock-toolbar-sub">
						${held} holding${held === 1 ? "" : "s"} ·
						position ${escapeHtml(positionAge)} ·
						prices ${escapeHtml(priceAge)}
						${this.holdingLedger ? ` · ${escapeHtml(this.holdingLedger)}` : ""}
					</div>
				</div>
				<button id="btn-stocks-sync" class="btn-primary btn-stocks-sync" ${this.syncing ? "disabled" : ""}>
					${this.syncing ? "Syncing…" : "Refresh from Torn"}
				</button>
			</div>
		`;
	}

	private ageLabel(iso: string | null): string {
		if (!iso) return "never";
		const at = new Date(iso).getTime();
		if (!Number.isFinite(at)) return "unknown";
		const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
		if (minutes < 2) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 36) return `${hours}h ago`;
		return `${Math.round(hours / 24)}d ago`;
	}

	// ── KPIs ─────────────────────────────────────────────────────────────────

	private renderKpis(portfolio: StockPortfolioResponse): string {
		const t = portfolio.totals;
		if (t.holdingsCount === 0) {
			return `
				<div class="kpi-card" style="margin-top: 12px;">
					<div class="kpi-label">No Positions</div>
					<div style="font-size: 12.5px; color: #cbd5e1; margin-top: 6px; line-height: 1.5;">
						Nothing is held right now. The list below shows what every stock pays and what the
						next block would cost, sorted by the yield on that next block.
					</div>
				</div>
			`;
		}

		const profitClass =
			t.profit > 0 ? "val-green" : t.profit < 0 ? "profit-neg" : "";
		const nextPayout = this.nextPayout(portfolio);

		return `
			<div class="kpi-grid kpi-grid-stocks">
				<div class="kpi-card">
					<div class="kpi-label">Invested (term)</div>
					<div class="kpi-value">${formatMoney(t.invested)}</div>
					<div class="kpi-sub">${formatMoney(t.costBasis)} still at cost</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Market Value</div>
					<div class="kpi-value val-blue">${formatMoney(t.marketValue)}</div>
					<div class="kpi-sub">${t.unrealized >= 0 ? "+" : ""}${formatMoney(t.unrealized)} unrealised</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Term Profit</div>
					<div class="kpi-value ${profitClass}">${t.profit >= 0 ? "+" : ""}${formatMoney(t.profit)}</div>
					<div class="kpi-sub">
						${formatMoney(t.realized)} realised · ${formatMoney(t.dividendsValue)} dividends
					</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Term ROI</div>
					<div class="kpi-value ${t.roiPct !== null && t.roiPct >= 0 ? "val-green" : t.roiPct !== null ? "profit-neg" : ""}">
						${t.roiPct === null ? "—" : formatPercent(t.roiPct)}
					</div>
					<div class="kpi-sub">
						${
							t.pricedRoiPct === null
								? "no priced holding"
								: `${formatPercent(t.pricedRoiPct)} on priced holdings`
						}
					</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Dividends (term)</div>
					<div class="kpi-value val-purple">${formatMoney(t.dividendsValue)}</div>
					<div class="kpi-sub">
						${t.dividendsCount} collected${t.dividendsUnpriced > 0 ? ` · ${t.dividendsUnpriced} unvalued` : ""}
					</div>
				</div>
				<div class="kpi-card">
					<div class="kpi-label">Forward Income</div>
					<div class="kpi-value">${formatMoney(t.forwardAnnualIncome)}</div>
					<div class="kpi-sub">
						${
							t.forwardYieldOnCostPct === null
								? "no priced blocks held"
								: `${formatPercent(t.forwardYieldOnCostPct)} a year on cost`
						}
					</div>
				</div>
			</div>
			${
				nextPayout
					? `<div class="stock-next-payout">
						<span class="stock-next-dot ${nextPayout.ready ? "ready" : ""}"></span>
						${escapeHtml(nextPayout.label)}
					</div>`
					: ""
			}
		`;
	}

	/** The soonest dividend across held positions, or a note that none is coming. */
	private nextPayout(
		portfolio: StockPortfolioResponse,
	): { label: string; ready: boolean } | null {
		let best: { acronym: string; daysUntil: number; ready: boolean } | null =
			null;
		for (const holding of portfolio.holdings) {
			const progress = holding.progress;
			if (!progress || progress.passiveActive !== null) continue;
			if (progress.daysUntil === null) continue;
			if (!best || progress.daysUntil < best.daysUntil) {
				best = {
					acronym: holding.acronym,
					daysUntil: progress.daysUntil,
					ready: progress.available,
				};
			}
		}
		if (!best) return null;
		if (best.ready) {
			return {
				label: `${best.acronym} dividend is ready to collect — claim it before the next midnight cron.`,
				ready: true,
			};
		}
		return {
			label: `${best.acronym} pays in ${best.daysUntil} day${best.daysUntil === 1 ? "" : "s"}.`,
			ready: false,
		};
	}

	// ── Holdings table ───────────────────────────────────────────────────────

	private sortedHoldings(portfolio: StockPortfolioResponse): StockHolding[] {
		const holdings = [...portfolio.holdings];
		const value = (holding: StockHolding): number => {
			switch (this.sortKey) {
				case "profit":
					return holding.profit;
				case "roi":
					return holding.roiPct ?? Number.NEGATIVE_INFINITY;
				case "dividends":
					return holding.term.dividendsValue;
				case "term":
					return holding.term.days ?? 0;
				default:
					return holding.marketValue;
			}
		};
		return holdings.sort((a, b) => value(b) - value(a));
	}

	private renderHoldings(portfolio: StockPortfolioResponse): string {
		if (portfolio.holdings.length === 0) return "";

		const rows = this.sortedHoldings(portfolio)
			.map((holding) => this.renderHoldingRow(holding))
			.join("");

		const header = (
			key: SortKey,
			label: string,
			align: "left" | "right" = "right",
		): string => `
			<th class="text-${align} ${this.sortKey === key ? "sorted" : ""}" data-sort="${key}" role="button" tabindex="0">
				${label}${this.sortKey === key ? " ▾" : ""}
			</th>
		`;

		return `
			<div class="weekly-table-card" style="margin-top: 14px;">
				<div class="weekly-paginator" style="border-bottom: none;">
					<div class="paginator-title">
						<span>Holdings</span>
						<span class="paginator-range">current term · tap a row for detail</span>
					</div>
				</div>
				<div class="weekly-table-scroll">
					<table class="company-ledger-table stock-table">
						<thead>
							<tr>
								<th class="text-left">Stock</th>
								<th class="text-right">Shares</th>
								<th class="text-right">Avg</th>
								<th class="text-right">Price</th>
								${header("value", "Value")}
								${header("dividends", "Divs")}
								${header("profit", "Profit")}
								${header("roi", "ROI")}
							</tr>
						</thead>
						<tbody>${rows}</tbody>
					</table>
				</div>
			</div>
		`;
	}

	private renderHoldingRow(holding: StockHolding): string {
		const isOpen = this.expanded.has(holding.stockId);
		const roiClass =
			holding.roiPct === null
				? ""
				: holding.roiPct >= 0
					? "profit-pos"
					: "profit-neg";
		const profitClass = holding.profit >= 0 ? "profit-pos" : "profit-neg";
		const progress = holding.progress;
		const progressPct =
			progress?.days !== null &&
			progress?.days !== undefined &&
			progress.frequencyDays
				? Math.max(
						0,
						Math.min(100, (progress.days / progress.frequencyDays) * 100),
					)
				: 0;

		const flags: string[] = [];
		if (holding.benefit.passive)
			flags.push('<span class="stock-chip passive">Passive</span>');
		if (holding.increments > 1)
			flags.push(
				`<span class="stock-chip">${holding.increments} blocks</span>`,
			);
		if (holding.reconciliation.source !== "logs")
			flags.push('<span class="stock-chip warn">Basis from purchases</span>');
		if (!holding.benefit.valuation.priced)
			flags.push('<span class="stock-chip warn">Unpriced</span>');
		if (progress?.available && progress.passiveActive === null)
			flags.push('<span class="stock-chip ready">Collect</span>');

		return `
			<tr class="stock-row ${isOpen ? "open" : ""}" data-stock="${holding.stockId}">
				<td class="text-left">
					<div class="stock-name">
						<span class="stock-acronym">${escapeHtml(holding.acronym)}</span>
						<span class="stock-full">${escapeHtml(holding.name)}</span>
					</div>
					<div class="stock-flags">${flags.join("")}</div>
				</td>
				<td class="td-num">${formatCompactNumber(holding.shares, 2)}</td>
				<td class="td-num">$${holding.avgCost > 0 ? holding.avgCost.toFixed(2) : "—"}</td>
				<td class="td-num">$${holding.price > 0 ? holding.price.toFixed(2) : "—"}</td>
				<td class="td-num">${holding.marketValue > 0 ? formatCompactNumber(holding.marketValue, 2) : "—"}</td>
				<td class="td-num ${holding.term.dividendsValue > 0 ? "profit-pos" : ""}">
					${holding.term.dividendsValue > 0 ? formatCompactNumber(holding.term.dividendsValue, 2) : "—"}
				</td>
				<td class="td-num ${profitClass}">${holding.profit >= 0 ? "+" : ""}${formatCompactNumber(holding.profit, 2)}</td>
				<td class="td-num ${roiClass}">${holding.roiPct === null ? "—" : formatPercent(holding.roiPct)}</td>
			</tr>
			${
				isOpen
					? `<tr class="stock-detail-row"><td colspan="8">${this.renderHoldingDetail(holding, progressPct)}</td></tr>`
					: ""
			}
		`;
	}

	private renderHoldingDetail(
		holding: StockHolding,
		progressPct: number,
	): string {
		const term = holding.term;
		const benefit = holding.benefit;
		const progress = holding.progress;

		return `
			<div class="stock-detail">
				<div class="stock-detail-grid">
					${this.detailStat("Term opened", term.start ? formatTimestamp(term.start) : "unknown")}
					${this.detailStat("Days held", term.days === null ? "—" : term.days.toFixed(1))}
					${this.detailStat("Invested", formatMoney(term.invested))}
					${this.detailStat("Cost basis", formatMoney(term.costBasis))}
					${this.detailStat("Realised", formatMoney(term.realized))}
					${this.detailStat("Unrealised", formatMoney(holding.unrealized))}
					${this.detailStat("Annualised (term)", holding.annualizedRoiPct === null ? "—" : formatPercent(holding.annualizedRoiPct))}
					${this.detailStat("Next block yield", holding.forwardYieldPct === null ? "—" : formatPercent(holding.forwardYieldPct))}
				</div>

				${
					holding.previousTerm
						? `<div class="stock-detail-line">
							Previous term: <strong>${holding.previousTerm.profit >= 0 ? "+" : ""}${formatMoney(holding.previousTerm.profit)}</strong>
							(${holding.previousTerm.roiPct === null ? "—" : formatPercent(holding.previousTerm.roiPct)})
							over ${holding.previousTerm.days.toFixed(0)} days, closed ${formatTimestamp(holding.previousTerm.end)}.
						</div>`
						: ""
				}

				<div class="stock-benefit-block">
					<div class="stock-benefit-head">
						<span class="stock-chip ${benefit.passive ? "passive" : ""}">${escapeHtml(BENEFIT_KIND_LABELS[benefit.kind] ?? benefit.kind)}</span>
						<span class="stock-benefit-desc">${escapeHtml(benefit.description)}</span>
					</div>
					<div class="stock-benefit-meta">
						${escapeHtml(formatBenefitLabel(benefit))} per
						${benefit.frequencyDays ? `${benefit.frequencyDays} days` : "hold period"} ·
						${formatNumber(benefit.requirementShares)} shares a block ·
						${benefit.increments} block${benefit.increments === 1 ? "" : "s"} ·
						worth ${formatValuePerCycle(benefit)} a cycle
						${benefit.note ? `<br><span style="color: #94a3b8;">${escapeHtml(benefit.note)}</span>` : ""}
					</div>
					${
						progress
							? `<div class="stock-progress">
									<div class="stock-progress-track">
										<div class="stock-progress-fill ${progress.available ? "ready" : ""}" style="width: ${progressPct.toFixed(1)}%"></div>
									</div>
									<div class="stock-progress-label">${escapeHtml(progress.note ?? "")}</div>
								</div>`
							: ""
					}
				</div>

				${this.renderDividendList(term)}
				${this.renderLotList(term)}
				${this.renderHoldingWarnings(holding)}
			</div>
		`;
	}

	private detailStat(label: string, value: string): string {
		return `
			<div class="stock-detail-stat">
				<div class="stock-detail-label">${escapeHtml(label)}</div>
				<div class="stock-detail-value">${escapeHtml(value)}</div>
			</div>
		`;
	}

	private renderDividendList(term: StockTerm): string {
		if (term.dividends.length === 0) {
			return `<div class="stock-detail-line" style="color: #94a3b8;">No dividends collected in this term.</div>`;
		}

		const recent = [...term.dividends].reverse().slice(0, 8);
		const rows = recent
			.map((dividend) => {
				const what =
					dividend.kind === "cash"
						? "Cash"
						: dividend.kind === "resource"
							? `${formatNumber(dividend.resourceQuantity ?? 0)} ${RESOURCE_LABELS[dividend.resourceUnit ?? ""] ?? ""}`
							: `${formatNumber(dividend.resourceQuantity ?? 1)}× ${dividend.itemName ?? `item ${dividend.itemId ?? "?"}`}`;
				return `
					<div class="stock-mini-row">
						<span>${escapeHtml(formatTimestamp(dividend.timestamp))}</span>
						<span class="stock-mini-what">${escapeHtml(what)}</span>
						<span class="${dividend.priced ? "profit-pos" : ""}">${dividend.priced ? formatMoney(dividend.value) : "unpriced"}</span>
					</div>
				`;
			})
			.join("");

		return `
			<div class="stock-detail-sub">
				Dividends this term (${term.dividends.length})
				${term.dividendsUnpriced > 0 ? ` · ${term.dividendsUnpriced} unvalued` : ""}
			</div>
			${rows}
			${term.dividends.length > recent.length ? `<div class="stock-mini-row"><span style="color: #94a3b8;">…${term.dividends.length - recent.length} older</span></div>` : ""}
		`;
	}

	private renderLotList(term: StockTerm): string {
		if (term.lots.length === 0 && term.sells.length === 0) return "";

		const lots = term.lots
			.slice(-6)
			.map(
				(lot) => `
				<div class="stock-mini-row">
					<span>${escapeHtml(formatTimestamp(lot.timestamp))}</span>
					<span class="stock-mini-what">bought ${formatNumber(lot.shares)} @ $${lot.price.toFixed(2)}</span>
					<span>${formatMoney(lot.worth)}</span>
				</div>
			`,
			)
			.join("");

		const sells = term.sells
			.slice(-4)
			.map(
				(sale) => `
				<div class="stock-mini-row">
					<span>${escapeHtml(formatTimestamp(sale.timestamp))}</span>
					<span class="stock-mini-what">sold ${formatNumber(sale.shares)}</span>
					<span class="${sale.realized >= 0 ? "profit-pos" : "profit-neg"}">${sale.realized >= 0 ? "+" : ""}${formatMoney(sale.realized)}${sale.fromLog ? "" : "*"}</span>
				</div>
			`,
			)
			.join("");

		return `
			<div class="stock-detail-sub">Purchases in this term</div>
			${lots}
			${term.sells.length > 0 ? `<div class="stock-detail-sub">Sales in this term</div>${sells}` : ""}
		`;
	}

	private renderHoldingWarnings(holding: StockHolding): string {
		if (holding.warnings.length === 0) return "";
		const items = holding.warnings
			.map((warning) => `<li>${escapeHtml(warning)}</li>`)
			.join("");
		return `
			<div class="stock-detail-sub">Caveats</div>
			<ul class="stock-warning-list">${items}</ul>
		`;
	}

	// ── Valuation assumptions ────────────────────────────────────────────────

	private renderRatesCard(): string {
		const rates = this.rates;
		const anySet =
			rates.energy > 0 ||
			rates.nerve > 0 ||
			rates.happy > 0 ||
			rates.points > 0;

		return `
			<div class="directives-card ${anySet ? "optimal" : "warning"}" style="margin-top: 14px;">
				<div class="directives-header" id="stock-rates-toggle" role="button" tabindex="0">
					<span class="status-indicator-dot ${anySet ? "dot-green" : "dot-amber"}"></span>
					<span class="directives-title">Resource Valuations ${this.ratesOpen ? "▾" : "▸"}</span>
				</div>
				${
					this.ratesOpen
						? `
					<div class="stock-rates-body">
						<div class="stock-rates-help">
							Energy, nerve, happiness and points payouts have no market price, so they are
							excluded from profit and ROI until you say what a unit is worth to you. Anything
							left at zero stays unpriced rather than counting as nothing.
						</div>
						<div class="stock-rates-grid">
							${this.rateInput("energy", "per energy", rates.energy)}
							${this.rateInput("nerve", "per nerve", rates.nerve)}
							${this.rateInput("happy", "per happiness", rates.happy)}
							${this.rateInput("points", "per point", rates.points)}
						</div>
						<button id="btn-stocks-rates-save" class="btn-primary" style="width: fit-content;">
							Save & recompute
						</button>
					</div>
				`
						: `<div class="stock-rates-summary">
							${
								anySet
									? `Energy $${formatNumber(rates.energy)} · Nerve $${formatNumber(rates.nerve)} · Happiness $${formatNumber(rates.happy)} · Points $${formatNumber(rates.points)}`
									: "No resource values set — resource payouts are excluded from every figure."
							}
						</div>`
				}
			</div>
		`;
	}

	private rateInput(unit: string, label: string, value: number): string {
		return `
			<label class="stock-rate-field">
				<span>${escapeHtml(label)}</span>
				<input class="input-text" id="rate-${unit}" type="number" min="0" step="1" value="${value > 0 ? value : ""}" placeholder="0" data-rate="${unit}" />
			</label>
		`;
	}

	// ── Candidate table ──────────────────────────────────────────────────────

	private filteredCatalog(
		portfolio: StockPortfolioResponse,
	): StockCatalogEntry[] {
		const list = portfolio.catalog.filter((entry) => {
			switch (this.filter) {
				case "active":
					return !entry.benefit.passive;
				case "passive":
					return entry.benefit.passive;
				case "unowned":
					return !entry.owned;
				default:
					return true;
			}
		});

		return list.sort((a, b) => {
			// Owned first, then by the yield of the block you would buy next; rows with
			// no yield (unpriceable benefits) sort last rather than at zero.
			if (a.owned !== b.owned) return a.owned ? -1 : 1;
			const ay = a.nextIncrementYieldPct ?? Number.NEGATIVE_INFINITY;
			const by = b.nextIncrementYieldPct ?? Number.NEGATIVE_INFINITY;
			return by - ay;
		});
	}

	private renderCandidates(portfolio: StockPortfolioResponse): string {
		const entries = this.filteredCatalog(portfolio);

		const chips = (
			[
				["all", "All"],
				["active", "Active"],
				["passive", "Passive"],
				["unowned", "Not held"],
			] as Array<[CatalogFilter, string]>
		)
			.map(
				([value, label]) => `
				<button class="btn-pill ${this.filter === value ? "active" : ""}" data-stock-filter="${value}">
					${label}
				</button>
			`,
			)
			.join("");

		const rows = entries
			.map((entry) => {
				const benefit = entry.benefit;
				const yieldClass =
					entry.nextIncrementYieldPct === null
						? ""
						: entry.nextIncrementYieldPct >= 0
							? "profit-pos"
							: "profit-neg";
				return `
					<tr class="${entry.owned ? "stock-owned" : ""}">
						<td class="text-left">
							<div class="stock-name">
								<span class="stock-acronym">${escapeHtml(entry.acronym)}</span>
								<span class="stock-full">${escapeHtml(entry.name)}</span>
							</div>
							<div class="stock-flags">
								${entry.owned ? '<span class="stock-chip owned">Held</span>' : ""}
								<span class="stock-chip ${benefit.passive ? "passive" : ""}">${escapeHtml(BENEFIT_KIND_LABELS[benefit.kind] ?? benefit.kind)}</span>
								${!benefit.valuation.priced ? '<span class="stock-chip warn">Unpriced</span>' : ""}
							</div>
						</td>
						<td class="td-num ${yieldClass}">
							${entry.nextIncrementYieldPct === null ? "—" : formatPercent(entry.nextIncrementYieldPct)}
						</td>
						<td class="td-num">${formatCompactNumber(entry.nextIncrementShares, 2)}</td>
						<td class="td-num">${entry.nextIncrementCost === null ? "—" : formatCompactNumber(entry.nextIncrementCost, 2)}</td>
						<td class="td-num">${benefit.frequencyDays ?? "—"}d</td>
						<td class="text-left stock-benefit-cell">
							${escapeHtml(formatBenefitLabel(benefit))}
							${!benefit.valuation.priced ? `<span class="stock-unpriced-note">${escapeHtml(benefit.valuation.pricingNote ?? "")}</span>` : ""}
						</td>
					</tr>
				`;
			})
			.join("");

		return `
			<div class="weekly-table-card" style="margin-top: 14px;">
				<div class="weekly-paginator">
					<div class="paginator-title">
						<span>Next Block Yield</span>
						<span class="paginator-range">${entries.length} stocks</span>
					</div>
					<div class="btn-pill-group">${chips}</div>
				</div>
				<div class="stock-catalog-note">
					Sorted by the annualised return of the block you would buy <em>next</em>: each
					increment costs double the last, so a second block of the same stock always yields
					half of the first.
				</div>
				<div class="weekly-table-scroll">
					<table class="company-ledger-table stock-table stock-catalog-table">
						<thead>
							<tr>
								<th class="text-left">Stock</th>
								<th class="text-right">Yield</th>
								<th class="text-right">Block</th>
								<th class="text-right">Cost</th>
								<th class="text-right">Cycle</th>
								<th class="text-left">Pays</th>
							</tr>
						</thead>
						<tbody>${rows}</tbody>
					</table>
				</div>
			</div>
		`;
	}

	// ── Warnings ─────────────────────────────────────────────────────────────

	private renderWarnings(portfolio: StockPortfolioResponse): string {
		const warnings = [...portfolio.warnings];
		if (this.errorMessage) warnings.unshift(this.errorMessage);
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
				<div class="directives-list" style="margin-top: 8px;">${rows}</div>
			</div>
		`;
	}

	// ── Events ───────────────────────────────────────────────────────────────

	private bindEvents(): void {
		this.container
			.querySelector("#btn-stocks-sync")
			?.addEventListener("click", () => {
				void this.sync();
			});

		this.container
			.querySelector("#stock-rates-toggle")
			?.addEventListener("click", () => {
				this.ratesOpen = !this.ratesOpen;
				this.render();
			});

		this.container
			.querySelector("#btn-stocks-rates-save")
			?.addEventListener("click", () => {
				const next: StockValuationRates = { ...DEFAULT_RATES };
				this.container
					.querySelectorAll<HTMLInputElement>("input[data-rate]")
					.forEach((input) => {
						const unit = input.getAttribute("data-rate") as
							| keyof StockValuationRates
							| null;
						if (!unit) return;
						const parsed = Number.parseFloat(input.value);
						next[unit] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
					});
				this.rates = next;
				GM_setValue(STORAGE_KEYS.stockRates, next);
				void this.refresh(true);
			});

		this.container
			.querySelectorAll<HTMLButtonElement>("button[data-stock-filter]")
			.forEach((button) => {
				button.addEventListener("click", () => {
					const value = button.getAttribute(
						"data-stock-filter",
					) as CatalogFilter | null;
					if (!value) return;
					this.filter = value;
					GM_setValue(STORAGE_KEYS.stockFilter, value);
					this.render();
				});
			});

		this.container
			.querySelectorAll<HTMLElement>("th[data-sort]")
			.forEach((header) => {
				const activate = () => {
					const key = header.getAttribute("data-sort") as SortKey | null;
					if (!key) return;
					this.sortKey = key;
					GM_setValue(STORAGE_KEYS.stockSort, key);
					this.render();
				};
				header.addEventListener("click", activate);
				header.addEventListener("keydown", (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						activate();
					}
				});
			});

		this.container
			.querySelectorAll<HTMLTableRowElement>("tr.stock-row")
			.forEach((row) => {
				row.addEventListener("click", () => {
					const id = Number(row.getAttribute("data-stock"));
					if (!Number.isFinite(id)) return;
					if (this.expanded.has(id)) {
						this.expanded.delete(id);
					} else {
						this.expanded.add(id);
					}
					this.render();
				});
			});
	}
}
