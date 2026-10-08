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
	StockBlock,
	StockHolding,
	StockPortfolioResponse,
	StockTerm,
} from "../types";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

/**
 * The Stocks tab: what the portfolio is worth, what it has paid out, and which
 * block is worth buying next.
 *
 * THE FOUR NUMBERS, AND WHY THEY ARE SEPARATE
 *
 * 1. INVESTED (TERM) is cash spent on buys since the position was last opened —
 *    the denominator of ROI, not what the position is worth today.
 *
 * 2. DIVIDEND INCOME is flat money actually received: cash dividends, plus items
 *    and points at their market price. It deliberately excludes share-price
 *    movement, so "profit gained from stocks" reads as income, not as a paper
 *    gain the account has not banked.
 *
 * 3. MARKET VALUE and its unrealised movement are the paper side: what the shares
 *    would fetch today against what they cost.
 *
 * 4. TERM ROI is the total return — income, realised sales and market movement —
 *    over invested, and it is claimed ONLY for positions that can earn: one
 *    complete benefit block, a payout with a dollar figure, and a known cost
 *    basis. A passive block and a holding below its block size accrue nothing, so
 *    a "ROI" for them would describe a return the stock never made; they show a
 *    dash and the reason instead.
 *
 * A DASH IS AN ANSWER
 *
 * Stock benefits pay in money, items, energy, nerve, happiness, points, ammo
 * packs, random properties, or nothing at all. Money, items and points have a
 * market price; the rest do not, and they show a dash plus the reason rather than
 * a zero that would read as "this stock pays nothing".
 *
 * INCREMENTS ARE CUMULATIVE
 *
 * Every increment costs twice the last ON TOP of it, so block three of a stock
 * needs 4× the first block's shares on top of the 3× already held. The block table
 * lists the block being worked toward — and the next couple after it — and ranks
 * them by the return on the cash still outstanding, so a block that is 90% bought
 * outranks a marginally better block that has not been started.
 */

type HoldingSortKey = "value" | "income" | "unrealized" | "roi" | "term";
type BlockFilter = "all" | "active" | "passive" | "buyable" | "held";
type BlockSortKey = "next" | "apr" | "pays" | "cost" | "progress" | "shares";
/** Which APR the block table's minimum threshold is measured against. */
type AprBasis = "block" | "next";

/** A block row plus the one thing the payload leaves to the reader: is it next? */
interface BlockRow extends StockBlock {
	/** The increment a purchase would advance right now: the next unbought block. */
	actionable: boolean;
}

const HOLDING_SORT_KEYS: readonly HoldingSortKey[] = [
	"value",
	"income",
	"unrealized",
	"roi",
	"term",
];

const BLOCK_SORT_KEYS: readonly BlockSortKey[] = [
	"next",
	"apr",
	"pays",
	"cost",
	"progress",
	"shares",
];

const BLOCK_FILTERS: readonly BlockFilter[] = [
	"all",
	"active",
	"passive",
	"buyable",
	"held",
];

const PAGE_SIZES: readonly number[] = [10, 25, 50];

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

const FILTER_LABELS: Record<BlockFilter, string> = {
	all: "All",
	active: "Active",
	passive: "Passive",
	buyable: "Buyable",
	held: "Held",
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

/** A dash with the reason attached, so an unknown figure is never read as zero. */
function dash(reason: string | undefined): string {
	const title = reason ? ` title="${escapeHtml(reason)}"` : "";
	return `<span class="stock-dash"${title}>—</span>`;
}

/**
 * Whether a cached payload is one this build can render.
 *
 * The stock payload changed shape when income was split from ROI and the flat
 * catalogue became per-increment blocks, so a payload from the previous build has
 * to be recognised and thrown away rather than rendered.
 */
function isCurrentShape(portfolio: StockPortfolioResponse): boolean {
	return (
		Array.isArray(portfolio.blocks) &&
		typeof portfolio.totals?.income === "number" &&
		Array.isArray(portfolio.holdings)
	);
}

/** Groups block rows by stock, so "the next unbought increment" can be found. */
function markActionable(blocks: readonly StockBlock[]): BlockRow[] {
	const seenNext = new Set<number>();
	return blocks.map((block) => {
		const actionable = !block.held && !seenNext.has(block.stockId);
		if (actionable) seenNext.add(block.stockId);
		return { ...block, actionable };
	});
}

export class StocksTab {
	private container: HTMLElement;
	private portfolio: StockPortfolioResponse | null = null;
	private holdingLedger: string | null = null;
	private onOpenSettings: () => void;
	private sortKey: HoldingSortKey = "value";
	private filter: BlockFilter = "all";
	private blockSort: BlockSortKey = "next";
	private page = 1;
	private pageSize = 10;
	/** APR floor for the block table, in percent. 0 hides nothing. */
	private minApr = 0;
	/** The threshold input's raw text, so a half-typed "12." is not reformatted. */
	private minAprRaw = "";
	private aprBasis: AprBasis = "block";
	/** Set when a re-render was triggered by the APR input, to put the caret back. */
	private restoreAprFocus = false;
	private expanded = new Set<number>();
	private syncing = false;
	private lastFetchedAt = 0;
	private errorMessage: string | null = null;

	constructor(container: HTMLElement, onOpenSettings: () => void) {
		this.container = container;
		this.onOpenSettings = onOpenSettings;

		// Values written by older builds are migrated rather than trusted: "profit"
		// and "dividends" no longer exist as columns, and the old "unowned" filter
		// meant something different before increments were modelled.
		const storedSort = GM_getValue<string>(STORAGE_KEYS.stockSort, "value");
		this.sortKey = HOLDING_SORT_KEYS.includes(storedSort as HoldingSortKey)
			? (storedSort as HoldingSortKey)
			: storedSort === "dividends"
				? "income"
				: "value";
		const storedFilter = GM_getValue<string>(STORAGE_KEYS.stockFilter, "all");
		this.filter = BLOCK_FILTERS.includes(storedFilter as BlockFilter)
			? (storedFilter as BlockFilter)
			: "all";
		const storedPageSize = GM_getValue<number>(STORAGE_KEYS.stockPageSize, 10);
		this.pageSize = PAGE_SIZES.includes(storedPageSize) ? storedPageSize : 10;
		const storedBlockSort = GM_getValue<string>(
			STORAGE_KEYS.stockBlockSort,
			"next",
		);
		this.blockSort = BLOCK_SORT_KEYS.includes(storedBlockSort as BlockSortKey)
			? (storedBlockSort as BlockSortKey)
			: "next";

		const storedMinApr = GM_getValue<number>(STORAGE_KEYS.stockMinApr, 0);
		this.minApr =
			Number.isFinite(storedMinApr) && storedMinApr > 0 ? storedMinApr : 0;
		this.minAprRaw = this.minApr > 0 ? String(this.minApr) : "";
		this.aprBasis =
			GM_getValue<string>(STORAGE_KEYS.stockAprBasis, "block") === "next"
				? "next"
				: "block";
	}

	public async init(): Promise<void> {
		const cached = apiClient.getCachedStockPortfolio();
		// A payload cached by an older build (catalogue rows and reader-supplied
		// resource rates) has none of the fields this tab now renders, so it is
		// discarded rather than painted as a wall of blanks until the fetch lands.
		this.portfolio = cached && isCurrentShape(cached) ? cached : null;
		this.render();
		await this.refresh(true);
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
				apiClient.getStockPortfolio(),
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
			this.portfolio = await apiClient.syncStockPortfolio();
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
			${this.renderBlocks(portfolio)}
			${this.renderWarnings(portfolio)}
		`;

		this.bindEvents();
		this.restoreAprFocusIfNeeded();
	}

	/**
	 * Puts the caret back in the APR floor input after it re-rendered the table.
	 *
	 * The whole tab is rebuilt from a template string on every change, which is
	 * fine for buttons but would drop focus on each keystroke of a text field.
	 */
	private restoreAprFocusIfNeeded(): void {
		if (!this.restoreAprFocus) return;
		this.restoreAprFocus = false;
		const input =
			this.container.querySelector<HTMLInputElement>("#input-min-apr");
		if (!input) return;
		input.focus();
		const end = input.value.length;
		input.setSelectionRange(end, end);
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
						${portfolio.pointsPrice > 0 ? ` · points ${formatMoney(portfolio.pointsPrice)}` : ""}
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
						Nothing is held right now. The block table below lists what every stock pays,
						what each increment costs, and the return on the shares still needed to
						complete it.
					</div>
				</div>
			`;
		}

		const nextPayout = this.nextPayout(portfolio);
		const measuredCoverage =
			t.invested > 0
				? `${formatMoney(t.measuredInvested)} of ${formatMoney(t.invested)} invested`
				: "nothing invested";
		const roiSub =
			t.roiPct === null
				? t.holdingsCount === 0
					? "no positions"
					: "no measurable position"
				: `${measuredCoverage} · ${t.measuredHoldingsCount} of ${t.holdingsCount} position${t.holdingsCount === 1 ? "" : "s"}`;

		return `
			<div class="kpi-grid kpi-grid-stocks">
				<div class="kpi-card" title="Cash spent on buys since each position was last opened. This is the ROI denominator, not what the position is worth today.">
					<div class="kpi-label">Invested (term)</div>
					<div class="kpi-value">${formatMoney(t.invested)}</div>
					<div class="kpi-sub">${formatMoney(t.costBasis)} of shares still held</div>
				</div>
				<div class="kpi-card" title="What the shares would fetch at today's price, against what they cost.">
					<div class="kpi-label">Market Value</div>
					<div class="kpi-value val-blue">${formatMoney(t.marketValue)}</div>
					<div class="kpi-sub">${t.unrealized >= 0 ? "+" : ""}${formatMoney(t.unrealized)} unrealised vs ${formatMoney(t.costBasis)} cost</div>
				</div>
				<div class="kpi-card" title="Flat income actually paid out this term: cash dividends, plus items and points at market price. Share-price movement is not counted here.">
					<div class="kpi-label">Dividend Income (term)</div>
					<div class="kpi-value val-purple">${formatMoney(t.income)}</div>
					<div class="kpi-sub">
						${t.dividendsCount} collected${t.dividendsUnpriced > 0 ? ` · ${t.dividendsUnpriced} unvalued` : ""}
					</div>
				</div>
				<div class="kpi-card" title="Total return — income, sales and market movement — over invested, for positions with a complete, priceable block and a known cost basis. Passive blocks and holdings below one block accrue nothing, so they are excluded rather than averaged in.">
					<div class="kpi-label">Term ROI</div>
					<div class="kpi-value ${t.roiPct !== null && t.roiPct >= 0 ? "val-green" : t.roiPct !== null ? "profit-neg" : ""}">
						${t.roiPct === null ? "—" : formatPercent(t.roiPct)}
					</div>
					<div class="kpi-sub">${roiSub}</div>
				</div>
				<div class="kpi-card" title="What the blocks held right now would pay over a year, at today's market prices for items and points.">
					<div class="kpi-label">Forward Income (year)</div>
					<div class="kpi-value">${formatMoney(t.forwardAnnualIncome)}</div>
					<div class="kpi-sub">
						${
							t.forwardYieldOnCostPct === null
								? "no complete, priceable block held"
								: `${formatPercent(t.forwardYieldOnCostPct)} a year on ${formatMoney(t.costBasis)} cost`
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
				case "income":
					return holding.income;
				case "unrealized":
					return holding.unrealized;
				case "roi":
					return holding.roiPct ?? Number.NEGATIVE_INFINITY;
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
			key: HoldingSortKey,
			label: string,
			align: "left" | "right" = "right",
			title?: string,
		): string => `
			<th class="text-${align} ${this.sortKey === key ? "sorted" : ""}" data-sort="${key}" role="button" tabindex="0"${title ? ` title="${escapeHtml(title)}"` : ""}>
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
								${header("unrealized", "Unreal.", "right", "Market value minus the cost of the shares still held.")}
								${header("income", "Income", "right", "Dividends actually paid out this term, at market price. Flat income, not share-price movement.")}
								${header("roi", "ROI", "right", "Total return over invested — income, sales and market movement. Dashed for passive blocks, holdings below one complete block and payouts with no dollar value.")}
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
		if (holding.increments === 0)
			flags.push(
				`<span class="stock-chip warn">${holding.nextBlockProgressPct.toFixed(0)}% to block 1</span>`,
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
				<td class="td-num ${holding.unrealized > 0 ? "profit-pos" : holding.unrealized < 0 ? "profit-neg" : ""}">
					${holding.price > 0 ? `${holding.unrealized >= 0 ? "+" : ""}${formatCompactNumber(holding.unrealized, 2)}` : "—"}
				</td>
				<td class="td-num ${holding.income > 0 ? "val-purple" : ""}">
					${holding.income > 0 ? formatCompactNumber(holding.income, 2) : "—"}
				</td>
				<td class="td-num ${roiClass}">
					${
						holding.roiPct === null
							? dash(holding.roiNote)
							: formatPercent(holding.roiPct)
					}
				</td>
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
					${this.detailStat("Cost basis held", formatMoney(term.costBasis))}
					${this.detailStat("Income (term)", formatMoney(term.dividendsValue))}
					${this.detailStat("Realised sales", formatMoney(term.realized))}
					${this.detailStat("Unrealised", formatMoney(holding.unrealized))}
					${this.detailStat("Annualised ROI", holding.annualizedRoiPct === null ? "—" : formatPercent(holding.annualizedRoiPct))}
					${this.detailStat("Next block APR", holding.nextBlockAprPct === null ? "—" : formatPercent(holding.nextBlockAprPct))}
					${this.detailStat("To next block", `${formatNumber(holding.sharesToNextBlock)} shares (${holding.nextBlockProgressPct.toFixed(0)}%)`)}
				</div>

				${
					holding.roiNote
						? `<div class="stock-detail-line" style="color: #fbbf24;">
							No term ROI: ${escapeHtml(holding.roiNote)}
						</div>`
						: ""
				}
				${
					holding.nextBlockAprPct === null && holding.nextBlockNote
						? `<div class="stock-detail-line" style="color: #94a3b8;">
							${escapeHtml(holding.nextBlockNote)}
						</div>`
						: ""
				}
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
						${benefit.valuation.priced ? `worth ${formatMoney(benefit.valuation.valuePerCycle)} a cycle` : "payout has no dollar value"}
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

	// ── Block table: every increment, ranked by what to buy next ─────────────

	/**
	 * The APR a minimum threshold is applied to.
	 *
	 * "Est. APR" is the block's own return over its whole cost. "Next to Buy" is
	 * the return on the cash the next purchase would spend, which is the same
	 * number for a block nobody has started — and for a block a purchase cannot
	 * advance (already held, or not reachable yet) it falls back to the block's own
	 * APR, exactly as the ranking does.
	 */
	/** The floor as the reader typed it: "20%", never "+20.0%". */
	private aprFloorLabel(): string {
		const value = Number.isInteger(this.minApr)
			? String(this.minApr)
			: this.minApr.toFixed(1);
		return `${value}%`;
	}

	private aprForThreshold(row: BlockRow): number | null {
		if (this.aprBasis === "next") {
			if (row.actionable) return row.nextToBuyAprPct;
			return row.annualizedAprPct;
		}
		return row.annualizedAprPct;
	}

	/**
	 * Rows in the order the table shows them.
	 *
	 * "Next to Buy" is the default and the point of the table: the one block per
	 * stock that a purchase can advance is ranked by the return on the cash still
	 * needed to complete it, so a block that is nearly bought beats a slightly
	 * better block that has not been started. Blocks already held and blocks that
	 * cannot be reached yet follow, ranked by their own APR.
	 */
	private orderedBlocks(portfolio: StockPortfolioResponse): BlockRow[] {
		const rows = markActionable(portfolio.blocks).filter((row) => {
			switch (this.filter) {
				case "active":
					return !row.passive;
				case "passive":
					return row.passive;
				case "buyable":
					return row.actionable;
				case "held":
					return row.held;
				default:
					return true;
			}
		});

		const numberOr = (value: number | null): number =>
			value ?? Number.NEGATIVE_INFINITY;

		// The APR floor. A row whose APR is unknown cannot be shown to clear the
		// threshold, so an unpriceable block is filtered out rather than kept and
		// read as "pays nothing".
		const limited =
			this.minApr > 0
				? rows.filter((row) => {
						const apr = this.aprForThreshold(row);
						return apr !== null && apr >= this.minApr;
					})
				: rows;

		const compare = (a: BlockRow, b: BlockRow): number => {
			switch (this.blockSort) {
				case "apr":
					return numberOr(b.annualizedAprPct) - numberOr(a.annualizedAprPct);
				case "pays":
					return numberOr(b.payoutValue) - numberOr(a.payoutValue);
				case "cost":
					return numberOr(b.cost) - numberOr(a.cost);
				case "progress":
					return b.progressPct - a.progressPct;
				case "shares":
					return b.shares - a.shares;
				default: {
					// Actionable blocks first — they are the only ones a purchase can
					// move — and within each group the best return first.
					if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
					const aScore = a.actionable
						? numberOr(a.nextToBuyAprPct)
						: numberOr(a.annualizedAprPct);
					const bScore = b.actionable
						? numberOr(b.nextToBuyAprPct)
						: numberOr(b.annualizedAprPct);
					if (bScore !== aScore) return bScore - aScore;
					return numberOr(b.annualizedAprPct) - numberOr(a.annualizedAprPct);
				}
			}
		};

		return limited.sort(compare);
	}

	private renderBlocks(portfolio: StockPortfolioResponse): string {
		const all = markActionable(portfolio.blocks);
		const rows = this.orderedBlocks(portfolio);

		const totalPages = Math.max(1, Math.ceil(rows.length / this.pageSize));
		if (this.page > totalPages) this.page = totalPages;
		const start = (this.page - 1) * this.pageSize;
		const pageRows = rows.slice(start, start + this.pageSize);
		const topId = rows.find((row) => row.actionable)?.stockId ?? null;

		const chips = BLOCK_FILTERS.map(
			(value) => `
				<button class="btn-pill ${this.filter === value ? "active" : ""}" data-block-filter="${value}">
					${FILTER_LABELS[value]}
				</button>
			`,
		).join("");

		const header = (key: BlockSortKey, label: string): string => `
			<th class="text-right ${this.blockSort === key ? "sorted" : ""}" data-block-sort="${key}" role="button" tabindex="0">
				${label}${this.blockSort === key ? " ▾" : ""}
			</th>
		`;

		const body =
			pageRows.length === 0
				? `<tr><td colspan="7" style="text-align: center; color: #94a3b8; padding: 18px;">${
						this.minApr > 0 && all.length > 0
							? `No block clears the ${this.aprFloorLabel()} APR floor on ${this.aprBasis === "next" ? "Next to Buy" : "Est. APR"}. Lower it to see the rest.`
							: "No blocks match this filter."
					}</td></tr>`
				: pageRows
						.map((row) => this.renderBlockRow(row, row.stockId === topId))
						.join("");

		const aprFiltered = this.minApr > 0;
		const filterCount = aprFiltered
			? `${rows.length} of ${all.length} · ≥${this.aprFloorLabel()}`
			: `${rows.length} of ${all.length}`;

		return `
			<div class="weekly-table-card" style="margin-top: 14px;">
				<div class="weekly-paginator">
					<div class="paginator-title">
						<span>Blocks to Buy</span>
						<span class="paginator-range">
							${filterCount} blocks · page ${this.page} of ${totalPages}
						</span>
					</div>
					<div class="btn-pill-group">${chips}</div>
				</div>
				<div class="stock-block-filters">
					<label class="stock-apr-filter" title="Hide every block whose annualised return is below this. A block with no priceable payout cannot clear it, so unpriceable blocks are hidden too.">
						<span>Min APR</span>
						<input
							id="input-min-apr"
							class="input-text"
							type="number"
							min="0"
							step="1"
							placeholder="0"
							value="${escapeHtml(this.minAprRaw)}"
						/>
						<span>%</span>
					</label>
					<label class="stock-apr-filter" title="Which APR the floor is measured against. Next to Buy is the return on the cash the next purchase spends — the number the table is ranked by — and a block a purchase cannot advance falls back to its own APR.">
						<span>on</span>
						<select id="sel-apr-basis" class="input-text">
							<option value="block" ${this.aprBasis === "block" ? "selected" : ""}>Est. APR</option>
							<option value="next" ${this.aprBasis === "next" ? "selected" : ""}>Next to Buy</option>
						</select>
					</label>
					${
						aprFiltered
							? `<button id="btn-apr-clear" class="btn-paginator" title="Show every block again">Clear</button>`
							: ""
					}
				</div>
				<div class="stock-catalog-note">
					Each increment costs double the last, so block 2 of a stock pays the same coupon
					for twice the shares. <strong>Next to Buy</strong> is the annualised return on the
					shares still needed to complete that block — the cash the next purchase would
					actually spend — which is why a half-built block can outrank a better one you have
					not started.
				</div>
				<div class="weekly-table-scroll">
					<table class="company-ledger-table stock-table stock-catalog-table">
						<thead>
							<tr>
								<th class="text-left">Stock</th>
								${header("shares", "Block")}
								${header("progress", "Progress")}
								${header("cost", "Cost")}
								${header("pays", "Pays")}
								${header("apr", "Est. APR")}
								${header("next", "Next to Buy")}
							</tr>
						</thead>
						<tbody>${body}</tbody>
					</table>
				</div>
				<div class="stock-block-paginator">
					<div class="paginator-controls">
						<button id="btn-block-prev" class="btn-paginator" ${this.page <= 1 ? "disabled" : ""} title="Previous page">‹ Prev</button>
						<span class="paginator-range">Page ${this.page} / ${totalPages}</span>
						<button id="btn-block-next" class="btn-paginator" ${this.page >= totalPages ? "disabled" : ""} title="Next page">Next ›</button>
					</div>
					<label class="stock-page-size">
						<span>Rows</span>
						<select id="sel-block-page-size" class="input-text">
							${PAGE_SIZES.map(
								(size) =>
									`<option value="${size}" ${size === this.pageSize ? "selected" : ""}>${size}</option>`,
							).join("")}
						</select>
					</label>
				</div>
			</div>
		`;
	}

	private renderBlockRow(row: BlockRow, isTopBuy: boolean): string {
		const flags: string[] = [];
		if (row.held) flags.push('<span class="stock-chip owned">Held</span>');
		else if (row.progressPct > 0)
			flags.push(
				`<span class="stock-chip own-partial">${row.progressPct.toFixed(0)}% bought</span>`,
			);
		if (isTopBuy && row.actionable)
			flags.push('<span class="stock-chip next-buy">① Next to buy</span>');
		if (row.passive)
			flags.push('<span class="stock-chip passive">Passive</span>');
		if (row.capped)
			flags.push('<span class="stock-chip warn">Cap reached</span>');
		if (row.payoutValue === null)
			flags.push('<span class="stock-chip warn">Unpriced</span>');

		const aprClass =
			row.annualizedAprPct === null
				? ""
				: row.annualizedAprPct >= 0
					? "profit-pos"
					: "profit-neg";
		const nextClass =
			row.nextToBuyAprPct === null
				? ""
				: row.nextToBuyAprPct >= 0
					? "profit-pos"
					: "profit-neg";

		const progressCell = row.held
			? '<span class="stock-held-mark">complete</span>'
			: `<span>${formatCompactNumber(row.sharesRemaining, 2)} left</span>
				<span class="stock-cell-sub">${row.progressPct.toFixed(0)}% of ${formatCompactNumber(row.shares, 2)}</span>`;

		const costCell =
			row.cost === null
				? dash("No share price on record for this stock.")
				: `<span>${formatMoney(row.cost)}</span>
					${row.costRemaining !== null && row.costRemaining > 0 ? `<span class="stock-cell-sub">${formatMoney(row.costRemaining)} to go</span>` : ""}`;

		const paysCell =
			row.payoutValue === null
				? dash(row.payoutNote)
				: `<span class="val-purple">${formatMoney(row.payoutValue)}</span>
					<span class="stock-cell-sub">${escapeHtml(row.payoutLabel)}${row.frequencyDays ? ` / ${row.frequencyDays}d` : ""}</span>`;

		return `
			<tr class="${row.held ? "stock-owned" : ""}">
				<td class="text-left">
					<div class="stock-name">
						<span class="stock-acronym">${escapeHtml(row.acronym)}</span>
						<span class="stock-full">${escapeHtml(row.name)}</span>
					</div>
					<div class="stock-flags">${flags.join("")}</div>
				</td>
				<td class="td-num">
					<span>${formatCompactNumber(row.shares, 2)}</span>
					<span class="stock-cell-sub">block ${row.increment}</span>
				</td>
				<td class="td-num">${progressCell}</td>
				<td class="td-num">${costCell}</td>
				<td class="td-num">${paysCell}</td>
				<td class="td-num ${aprClass}">
					${row.annualizedAprPct === null ? dash(row.payoutNote ?? "No priceable payout, so no APR.") : formatPercent(row.annualizedAprPct)}
				</td>
				<td class="td-num ${nextClass}">
					${
						row.nextToBuyAprPct === null
							? row.actionable
								? dash(
										row.payoutValue === null
											? (row.payoutNote ?? "This payout has no dollar value.")
											: "No share price on record, so the cash still needed cannot be costed.",
									)
								: '<span class="stock-dash-muted">—</span>'
							: formatPercent(row.nextToBuyAprPct)
					}
				</td>
			</tr>
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
			.querySelectorAll<HTMLButtonElement>("button[data-block-filter]")
			.forEach((button) => {
				button.addEventListener("click", () => {
					const value = button.getAttribute(
						"data-block-filter",
					) as BlockFilter | null;
					if (!value) return;
					this.filter = value;
					// A filter that shrinks the list must not leave the reader on a page
					// that no longer exists.
					this.page = 1;
					GM_setValue(STORAGE_KEYS.stockFilter, value);
					this.render();
				});
			});

		this.container
			.querySelectorAll<HTMLElement>("th[data-sort]")
			.forEach((header) => {
				const activate = () => {
					const key = header.getAttribute("data-sort") as HoldingSortKey | null;
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
			.querySelectorAll<HTMLElement>("th[data-block-sort]")
			.forEach((header) => {
				const activate = () => {
					const key = header.getAttribute(
						"data-block-sort",
					) as BlockSortKey | null;
					if (!key || !BLOCK_SORT_KEYS.includes(key)) return;
					this.blockSort = key;
					this.page = 1;
					GM_setValue(STORAGE_KEYS.stockBlockSort, key);
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
			.querySelector("#btn-block-prev")
			?.addEventListener("click", () => {
				if (this.page > 1) {
					this.page--;
					this.render();
				}
			});

		this.container
			.querySelector("#btn-block-next")
			?.addEventListener("click", () => {
				this.page++;
				this.render();
			});

		this.container
			.querySelector<HTMLSelectElement>("#sel-block-page-size")
			?.addEventListener("change", (event) => {
				const select = event.currentTarget as HTMLSelectElement;
				const size = Number.parseInt(select.value, 10);
				if (!PAGE_SIZES.includes(size)) return;
				this.pageSize = size;
				this.page = 1;
				GM_setValue(STORAGE_KEYS.stockPageSize, size);
				this.render();
			});

		this.container
			.querySelector<HTMLInputElement>("#input-min-apr")
			?.addEventListener("input", (event) => {
				const input = event.currentTarget as HTMLInputElement;
				const parsed = Number.parseFloat(input.value);
				this.minApr = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
				// The typed text is kept verbatim: rendering "12" back over a half-typed
				// "12.5" would fight the reader's keystrokes.
				this.minAprRaw = input.value;
				this.page = 1;
				GM_setValue(STORAGE_KEYS.stockMinApr, this.minApr);
				this.restoreAprFocus = true;
				this.render();
			});

		this.container
			.querySelector<HTMLSelectElement>("#sel-apr-basis")
			?.addEventListener("change", (event) => {
				const select = event.currentTarget as HTMLSelectElement;
				this.aprBasis = select.value === "next" ? "next" : "block";
				this.page = 1;
				GM_setValue(STORAGE_KEYS.stockAprBasis, this.aprBasis);
				this.render();
			});

		this.container
			.querySelector("#btn-apr-clear")
			?.addEventListener("click", () => {
				this.minApr = 0;
				this.minAprRaw = "";
				this.page = 1;
				GM_setValue(STORAGE_KEYS.stockMinApr, 0);
				this.render();
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
