import { apiClient } from "../api";
import {
	escapeHtml,
	formatCompactNumber,
	formatMoney,
	formatNumber,
	formatTimestamp,
	STORAGE_KEYS,
} from "../config";
import type {
	WealthAnalyticsResponse,
	WealthCategoryKey,
	WealthCategoryRow,
	WealthLedgerState,
	WealthStateResponse,
	WealthTimelinePoint,
	WealthTransaction,
} from "../types";
import { renderLineChart } from "../ui/chart-core";
import {
	bindSortableHeaders,
	nextSortState,
	type SortAccessors,
	type SortState,
	sortIndicator,
	sortRows,
} from "../ui/table-sort";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;

/**
 * The Wealth tab: where the money came from, where it went, and how much of it
 * the ledger can actually account for.
 *
 * THE FOUR THINGS THIS TAB IS FOR
 *
 * 1. CASH IS NOT PROFIT. The KPI row leads with net worth change, not cash flow,
 *    because they answer different questions. Moving money into the vault, the
 *    company, the bank or the bookie empties the pocket without costing a penny,
 *    so a panel showing only "money out" tells the reader they got poorer by
 *    saving. Every total carries both legs, and the accounts table shows where the
 *    non-pocket money is actually sitting.
 *
 * 2. A DASH IS AN ANSWER. Torn has 1170 log types and the ledger cannot put a
 *    trustworthy number on all of them: a Book has no item-market price, a points
 *    refill spends points rather than dollars, and faction transfers are written
 *    twice with no way to tell which leg touched the wallet. Those events are
 *    counted, contribute nothing to the totals, and are reported in the coverage
 *    card — which states how many events and how many dollars are missing, instead
 *    of letting a zero read as "nothing happened".
 *
 * 3. DRIFT IS THE HONESTY CHECK. Torn publishes its own net worth figure. When the
 *    tracked net worth and Torn's figure disagree, the panel says so, because that
 *    disagreement is the only mechanical signal that a classification rule is
 *    wrong. Hiding it would make the rest of the tab unverifiable.
 *
 * 4. THE ANCHOR IS 00:00 UTC. The ledger starts at midnight rather than at the
 *    moment it was installed, so the first day shown is a whole day. The header
 *    states the anchor rather than leaving the reader to work out why a figure
 *    they remember from yesterday is or is not included.
 */

type WealthSortKey =
	| "category"
	| "walletIn"
	| "walletOut"
	| "walletNet"
	| "netWorthDelta"
	| "events";

const WEALTH_SORT_KEYS: WealthSortKey[] = [
	"category",
	"walletIn",
	"walletOut",
	"walletNet",
	"netWorthDelta",
	"events",
];

const CATEGORY_SORT_ACCESSORS: SortAccessors<WealthCategoryRow, WealthSortKey> =
	{
		category: (row) => row.category,
		walletIn: (row) => row.walletIn,
		walletOut: (row) => row.walletOut,
		walletNet: (row) => row.walletNet,
		netWorthDelta: (row) => row.netWorthDelta,
		events: (row) => row.events,
	};

const CATEGORY_LABELS: Record<WealthCategoryKey, string> = {
	crime: "Crimes",
	bounty: "Bounties",
	missions: "Missions",
	hunting: "Hunting",
	bazaar: "Bazaar",
	item_market: "Item market",
	points_market: "Points market",
	shops: "Shops",
	trades: "Trades",
	auctions: "Auctions",
	display: "Display case",
	casino: "Casino",
	bookie: "Bookie",
	racing: "Racing",
	stocks: "Stocks",
	company: "Company",
	faction: "Faction",
	property: "Property",
	bank: "Bank",
	vault: "Vault",
	gym: "Gym",
	medical: "Medical",
	education: "Education",
	travel: "Travel",
	jail: "Jail & bail",
	items: "Items",
	consumables: "Consumables",
	attacks: "Attacks",
	events: "Events",
	other: "Unclassified",
};

const ACCOUNT_LABELS: Record<string, string> = {
	bookie: "Bookie",
	vault: "Vault",
	company: "Company funds",
	bank: "City bank",
	cayman: "Cayman bank",
	piggy: "Piggy bank",
};

/** A dollar figure with its direction, tinted green for gain and amber for loss. */
function signedMoney(value: number): string {
	const sign = value > 0 ? "+" : value < 0 ? "−" : "";
	const tone = value > 0 ? "val-green" : value < 0 ? "val-amber" : "";
	return `<span class="${tone}">${sign}${formatMoney(Math.abs(value))}</span>`;
}

function kpiCard(
	label: string,
	value: string,
	sub: string,
	valueClass = "",
): string {
	return `
		<div class="kpi-card">
			<div class="kpi-label">${escapeHtml(label)}</div>
			<div class="kpi-value ${valueClass}">${value}</div>
			<div class="kpi-sub">${escapeHtml(sub)}</div>
		</div>
	`;
}

export class WealthTab {
	private container: HTMLElement;
	private state: WealthLedgerState | null = null;
	private balances: WealthStateResponse["balances"] | null = null;
	private analytics: WealthAnalyticsResponse | null = null;
	private timeframe: "7d" | "30d" | "90d" | "all" = "30d";
	private chartMode: "cash" | "networth" = "cash";
	private sort: SortState<WealthSortKey> = {
		key: "netWorthDelta",
		direction: "desc",
	};
	private onOpenSettings: () => void;

	constructor(container: HTMLElement, onOpenSettings: () => void) {
		this.container = container;
		this.onOpenSettings = onOpenSettings;

		// The stored period is restored on load: without it the cached payload (of
		// whatever period was fetched last) renders under a "30D" pill.
		const storedTimeframe = GM_getValue<string>(
			STORAGE_KEYS.wealthTimeframe,
			"30d",
		);
		if (
			storedTimeframe === "7d" ||
			storedTimeframe === "30d" ||
			storedTimeframe === "90d" ||
			storedTimeframe === "all"
		) {
			this.timeframe = storedTimeframe;
		}

		const storedMode = GM_getValue<string>(
			STORAGE_KEYS.wealthChartMode,
			"cash",
		);
		if (storedMode === "cash" || storedMode === "networth") {
			this.chartMode = storedMode;
		}

		const storedSort = GM_getValue<SortState<WealthSortKey> | null>(
			STORAGE_KEYS.wealthSort,
			null,
		);
		if (storedSort?.key && WEALTH_SORT_KEYS.includes(storedSort.key)) {
			this.sort = storedSort;
		}
	}

	public async init(): Promise<void> {
		const cached = apiClient.getCachedWealthState();
		this.state = cached?.state ?? null;
		this.balances = cached?.balances ?? null;
		this.analytics = apiClient.getCachedWealthAnalytics();
		this.render();
		await this.refresh();
	}

	/** Guards against an older, slower response overwriting a newer selection. */
	private requestSeq = 0;

	public async refresh(): Promise<void> {
		const seq = ++this.requestSeq;
		try {
			const [stateRes, analyticsRes] = await Promise.all([
				apiClient.getWealthState(),
				apiClient.getWealthAnalytics(this.timeframe),
			]);
			if (seq !== this.requestSeq) return;
			this.state = stateRes.state;
			this.balances = stateRes.balances;
			this.analytics = analyticsRes;
			this.render();
		} catch (err) {
			if (seq !== this.requestSeq) return;
			console.error("[Blasted's Script] Error refreshing wealth data:", err);
			this.renderError(err instanceof Error ? err.message : String(err));
		}
	}

	private renderError(message: string): void {
		const isAuthError =
			message.toLowerCase().includes("unauthorized") ||
			message.toLowerCase().includes("api key");
		this.container.innerHTML = `
			<div class="kpi-card" style="border-color: #ef4444; background: rgba(239, 68, 68, 0.1);">
				<div class="kpi-label" style="color: #f87171;">Connection Alert</div>
				<div style="font-size: 13px; color: #fca5a5; margin: 6px 0;">${escapeHtml(message)}</div>
				${
					isAuthError
						? `<button id="btn-fix-key" class="btn-primary" style="margin-top: 8px; width: fit-content;">Configure API Key in Settings</button>`
						: `<button id="btn-retry" class="btn-primary" style="margin-top: 8px; width: fit-content;">Retry Connection</button>`
				}
			</div>
		`;

		this.container
			.querySelector("#btn-fix-key")
			?.addEventListener("click", () => this.onOpenSettings());
		this.container
			.querySelector("#btn-retry")
			?.addEventListener("click", () => void this.refresh());
	}

	public render(): void {
		if (!this.analytics && !this.state) {
			this.container.innerHTML = `
				<div style="padding: 40px 0; text-align: center; color: #94a3b8;">
					Loading Wealth Ledger...
				</div>
			`;
			return;
		}

		const analytics = this.analytics;
		const state = analytics?.state ?? this.state;
		const balances = analytics?.balances ?? this.balances;

		this.container.innerHTML = `
			${this.renderAnchorCard(state, balances)}
			${this.renderKpis(analytics)}
			${this.renderChartCard()}
			${this.renderAccounts(balances)}
			${analytics ? this.renderCategoryTable(analytics.categories) : ""}
			${analytics ? this.renderTopEvents(analytics.topEvents) : ""}
			${this.renderCoverage(state)}
		`;

		this.attachEventListeners();
		this.renderChartOnly();
	}

	/**
	 * The anchor and the reconciliation, stated rather than implied.
	 *
	 * Drift is judged relative to the size of the account: a fixed dollar
	 * threshold would be noise on one account and a red flag on another.
	 */
	private renderAnchorCard(
		state: WealthLedgerState | null,
		balances: WealthStateResponse["balances"] | null,
	): string {
		const anchor = state?.anchorDate
			? formatTimestamp(Math.floor(new Date(state.anchorDate).getTime() / 1000))
			: null;

		const statusLine =
			state?.status === "error"
				? `<span class="val-amber">${escapeHtml(state.lastError ?? "The last sync failed.")}</span>`
				: state?.initialised && anchor
					? `Ledger live since ${escapeHtml(anchor)} — the start of that UTC day, so the first day counted is a whole day.`
					: "The ledger has not been anchored yet. It is created on the scheduler's first cycle after this module starts.";

		const drift = balances?.netWorthDrift ?? null;
		const tolerance =
			balances === null
				? 0
				: Math.max(1_000_000, Math.abs(balances.trackedNetWorth) * 0.01);
		const driftTone =
			drift === null
				? ""
				: Math.abs(drift) <= tolerance
					? "val-green"
					: "val-amber";
		const driftDetail =
			drift === null
				? "Torn's own net worth figure is not available yet, so the ledger cannot be checked against it."
				: `Torn reports ${formatMoney(balances?.tornNetWorth ?? 0)}; the ledger accounts for ${formatMoney(balances?.trackedNetWorth ?? 0)}. A gap means a rule is missing something.`;

		return `
			<div class="chart-card" style="margin-bottom: 12px;">
				<div style="font-size: 12px; color: #94a3b8;">${statusLine}</div>
				<div style="font-size: 12px; margin-top: 6px; color: #94a3b8;">
					Reconciliation:
					<span class="${driftTone}">${
						drift === null
							? "unavailable"
							: `${drift >= 0 ? "+" : "−"}${formatMoney(Math.abs(drift))} drift`
					}</span>
					<span style="opacity: 0.75;">— ${escapeHtml(driftDetail)}</span>
				</div>
			</div>
		`;
	}

	private renderKpis(analytics: WealthAnalyticsResponse | null): string {
		if (!analytics) return "";
		const k = analytics.kpis;
		const window =
			analytics.timeframe.days === "all"
				? "all time"
				: `the last ${analytics.timeframe.days} days`;

		return `
			<div class="kpi-grid">
				${kpiCard(
					"Net Worth Change",
					signedMoney(k.netWorthDelta),
					"Wallet, accounts and items together",
				)}
				${kpiCard(
					"Money In",
					formatMoney(k.walletIn),
					"Received into the wallet",
					"val-green",
				)}
				${kpiCard(
					"Money Out",
					formatMoney(k.walletOut),
					"Paid out of the wallet",
					"val-amber",
				)}
				${kpiCard(
					"Cash Flow",
					signedMoney(k.walletNet),
					"Pocket movement, before account transfers",
				)}
				${kpiCard(
					"Account Movement",
					signedMoney(k.accountNet),
					"Vault, company, bank, Cayman and bookie",
				)}
				${kpiCard(
					"Items Gained",
					formatMoney(k.itemsInValue),
					`Item market value, over ${window}`,
					"val-blue",
				)}
			</div>
		`;
	}

	private renderChartCard(): string {
		return `
			<div class="chart-card">
				<div class="chart-header">
					<div class="chart-title">Cash Flow &amp; Net Worth</div>
					<div class="chart-controls">
						<div class="btn-pill-group">
							<button class="btn-pill ${this.chartMode === "cash" ? "active" : ""}" data-mode="cash">Cash</button>
							<button class="btn-pill ${this.chartMode === "networth" ? "active" : ""}" data-mode="networth">Net Worth</button>
						</div>
						<div class="btn-pill-group">
							<button class="btn-pill ${this.timeframe === "7d" ? "active" : ""}" data-tf="7d">7D</button>
							<button class="btn-pill ${this.timeframe === "30d" ? "active" : ""}" data-tf="30d">30D</button>
							<button class="btn-pill ${this.timeframe === "90d" ? "active" : ""}" data-tf="90d">90D</button>
							<button class="btn-pill ${this.timeframe === "all" ? "active" : ""}" data-tf="all">All</button>
						</div>
					</div>
				</div>

				<div id="wealth-scrub-strip" class="chart-scrub-strip" role="status" aria-live="polite">
					<span>Scrub the chart for a daily breakdown</span>
				</div>

				<div id="wealth-chart-canvas" class="chart-svg-wrap"></div>
			</div>
		`;
	}

	private renderAccounts(
		balances: WealthStateResponse["balances"] | null,
	): string {
		if (!balances) return "";

		const accountRows = Object.entries(balances.accounts)
			.filter(
				(entry): entry is [string, number] =>
					typeof entry[1] === "number" && entry[1] !== 0,
			)
			.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
			.map(
				([key, value]) => `
					<tr>
						<td>${escapeHtml(ACCOUNT_LABELS[key] ?? key)}</td>
						<td class="text-right">${formatMoney(value)}</td>
					</tr>
				`,
			)
			.join("");

		return `
			<div class="table-card">
				<div class="table-header-title">
					<span>Where The Money Is</span>
				</div>
				<div class="table-wrap">
					<table>
						<tbody>
							<tr>
								<td>Wallet</td>
								<td class="text-right">${formatMoney(balances.wallet)}</td>
							</tr>
							${accountRows}
							<tr>
								<td>Items at market value</td>
								<td class="text-right">${formatMoney(balances.itemsValue)}</td>
							</tr>
							<tr>
								<td><strong>Tracked net worth</strong></td>
								<td class="text-right"><strong>${formatMoney(balances.trackedNetWorth)}</strong></td>
							</tr>
						</tbody>
					</table>
				</div>
				<div style="font-size: 11px; color: #94a3b8; padding: 8px 14px 12px;">
					The bookie balance is reconstructed from the log — bets out, winnings in,
					withdrawals back. Torn does not report it, so it is a derived position
					rather than a quoted balance.
				</div>
			</div>
		`;
	}

	private sortableHeader(
		key: WealthSortKey,
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

	private renderCategoryRows(rows: WealthCategoryRow[]): string {
		const sorted = sortRows(rows, this.sort, CATEGORY_SORT_ACCESSORS);
		return sorted
			.map(
				(row) => `
					<tr>
						<td class="text-left">${escapeHtml(CATEGORY_LABELS[row.category] ?? row.category)}</td>
						<td class="text-right val-green">${formatMoney(row.walletIn)}</td>
						<td class="text-right val-amber">${formatMoney(row.walletOut)}</td>
						<td class="text-right">${signedMoney(row.walletNet)}</td>
						<td class="text-right">${signedMoney(row.netWorthDelta)}</td>
						<td class="text-right">${formatNumber(row.events)}${
							row.unpricedEvents > 0
								? ` <span style="color: #fbbf24;" title="${row.unpricedEvents} event(s) here could not be priced">⚠</span>`
								: ""
						}</td>
					</tr>
				`,
			)
			.join("");
	}

	private renderCategoryTable(rows: WealthCategoryRow[]): string {
		const body =
			rows.length === 0
				? `<tr><td colspan="6" style="text-align: center; color: #94a3b8;">No movements recorded in this window.</td></tr>`
				: this.renderCategoryRows(rows);

		return `
			<div class="table-card">
				<div class="table-header-title">
					<span>Category Breakdown</span>
					<span class="table-header-meta">${rows.length} categor${rows.length === 1 ? "y" : "ies"}</span>
				</div>
				<div class="table-wrap">
					<table class="sortable-table">
						<thead>
							<tr>
								${this.sortableHeader("category", "Category", "text-left")}
								${this.sortableHeader("walletIn", "In", "text-right")}
								${this.sortableHeader("walletOut", "Out", "text-right")}
								${this.sortableHeader("walletNet", "Cash Flow", "text-right")}
								${this.sortableHeader("netWorthDelta", "Net Worth", "text-right")}
								${this.sortableHeader("events", "Events", "text-right")}
							</tr>
						</thead>
						<tbody>${body}</tbody>
					</table>
				</div>
				<div style="font-size: 11px; color: #94a3b8; padding: 8px 14px 12px;">
					Cash flow is what moved through the wallet. Net worth also counts account
					transfers and items, which is why a vault deposit shows as cash out and
					zero net worth.
				</div>
			</div>
		`;
	}

	private renderTopEvents(events: WealthTransaction[]): string {
		if (events.length === 0) return "";
		const rows = events
			.map(
				(event) => `
					<tr>
						<td class="text-left" style="white-space: nowrap;">${escapeHtml(
							formatTimestamp(
								Math.floor(new Date(event.timestamp).getTime() / 1000),
							),
						)}</td>
						<td class="text-left">${escapeHtml(event.label)}</td>
						<td class="text-left">${escapeHtml(CATEGORY_LABELS[event.category] ?? event.category)}</td>
						<td class="text-right">${
							event.walletDelta === 0 ? "—" : signedMoney(event.walletDelta)
						}</td>
						<td class="text-right">${signedMoney(event.netWorthDelta)}${
							event.priced
								? ""
								: ` <span style="color: #fbbf24;" title="This event could not be fully priced">⚠</span>`
						}</td>
					</tr>
				`,
			)
			.join("");

		return `
			<div class="table-card">
				<div class="table-header-title">
					<span>Largest Movements</span>
				</div>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th class="text-left">When</th>
								<th class="text-left">What</th>
								<th class="text-left">Category</th>
								<th class="text-right">Wallet</th>
								<th class="text-right">Net Worth</th>
							</tr>
						</thead>
						<tbody>${rows}</tbody>
					</table>
				</div>
				<div style="font-size: 11px; color: #94a3b8; padding: 8px 14px 12px;">
					⚠ marks an event whose amount could not be fully established, so its
					figure is a floor rather than a measurement.
				</div>
			</div>
		`;
	}

	/**
	 * The coverage card.
	 *
	 * This is what makes the rest of the tab checkable: how many events were
	 * priced, how much movement rides on the ones that were not, and which log
	 * types the classifier did not recognise at all.
	 */
	private renderCoverage(state: WealthLedgerState | null): string {
		if (!state) return "";
		const coverage = state.coverage;
		const total = coverage.pricedEvents + coverage.unpricedEvents;
		const pricedPct = total > 0 ? (coverage.pricedEvents / total) * 100 : 100;
		const reference = coverage.totalLogTypes
			? ` of ${formatNumber(coverage.totalLogTypes)} Torn publishes`
			: "";

		const unclassified =
			coverage.unclassified.length === 0
				? `<div class="val-green" style="font-size: 12px;">Every log type seen so far was recognised.</div>`
				: `
					<div style="font-size: 12px; color: #fbbf24;">
						${coverage.unclassified.length} log type(s) have no rule yet, so their
						movements are recorded but not counted:
					</div>
					<div class="table-wrap" style="margin-top: 6px;">
						<table>
							<thead>
								<tr>
									<th class="text-right">Type</th>
									<th class="text-left">What Torn calls it</th>
									<th class="text-right">Events</th>
								</tr>
							</thead>
							<tbody>
								${coverage.unclassified
									.map(
										(entry) => `
											<tr>
												<td class="text-right">${entry.logType}</td>
												<td class="text-left">${escapeHtml(entry.title ?? entry.sample ?? "unknown")}</td>
												<td class="text-right">${formatNumber(entry.events)}</td>
											</tr>
										`,
									)
									.join("")}
							</tbody>
						</table>
					</div>
				`;

		return `
			<div class="table-card">
				<div class="table-header-title">
					<span>Coverage</span>
					<span class="table-header-meta">${pricedPct.toFixed(1)}% priced</span>
				</div>
				<div style="padding: 12px 14px; font-size: 12px; color: #cbd5e1;">
					${formatNumber(coverage.pricedEvents)} of ${formatNumber(total)} events priced ·
					${formatNumber(coverage.classifiedLogTypes)} log types classified${reference}
				</div>
				${
					coverage.unpricedEvents > 0
						? `<div style="padding: 0 14px 12px; font-size: 12px; color: #fbbf24;">
								${formatNumber(coverage.unpricedEvents)} events could not be fully priced,
								carrying ${formatMoney(coverage.unpricedAmount)} of movement. Those
								amounts are excluded from the totals rather than counted as zero.
							</div>`
						: ""
				}
				<div style="padding: 0 14px 14px;">${unclassified}</div>
			</div>
		`;
	}

	private attachEventListeners(): void {
		this.container
			.querySelectorAll<HTMLButtonElement>("[data-tf]")
			.forEach((btn) => {
				btn.addEventListener("click", () => {
					const tf = btn.getAttribute("data-tf");
					if (tf === "7d" || tf === "30d" || tf === "90d" || tf === "all") {
						this.timeframe = tf;
						GM_setValue(STORAGE_KEYS.wealthTimeframe, tf);
						void this.refresh();
					}
				});
			});

		this.container
			.querySelectorAll<HTMLButtonElement>("[data-mode]")
			.forEach((btn) => {
				btn.addEventListener("click", () => {
					const mode = btn.getAttribute("data-mode");
					if (mode === "cash" || mode === "networth") {
						this.chartMode = mode;
						GM_setValue(STORAGE_KEYS.wealthChartMode, mode);
						this.render();
					}
				});
			});

		bindSortableHeaders(this.container, WEALTH_SORT_KEYS, (key) => {
			this.sort = nextSortState(this.sort, key as WealthSortKey);
			GM_setValue(STORAGE_KEYS.wealthSort, this.sort);
			// Only the rows change, so the header the reader just clicked keeps focus.
			this.rerenderCategoryRows();
		});
	}

	/** Re-renders only the category rows, leaving the rest of the tab in place. */
	private rerenderCategoryRows(): void {
		const rows = this.analytics?.categories ?? [];
		const tbody = this.container.querySelector<HTMLElement>(
			"table.sortable-table tbody",
		);
		if (!tbody) return;
		tbody.innerHTML = this.renderCategoryRows(rows);

		// The headers carry the sort arrow, so they have to be repainted too.
		this.container
			.querySelectorAll<HTMLElement>("th[data-sort]")
			.forEach((header) => {
				const key = header.getAttribute("data-sort") as WealthSortKey | null;
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
				const label = header.textContent?.replace(/[▲▼]\s*$/, "").trim() ?? "";
				header.innerHTML = `${escapeHtml(label)} ${sortIndicator(active, this.sort.direction)}`;
			});
	}

	/** Draws the timeline. Called after the markup is in place. */
	public renderChartOnly(): void {
		const canvas = this.container.querySelector<HTMLElement>(
			"#wealth-chart-canvas",
		);
		const strip = this.container.querySelector<HTMLElement>(
			"#wealth-scrub-strip",
		);
		if (!canvas) return;

		const points: WealthTimelinePoint[] = this.analytics?.timeline ?? [];
		const isCash = this.chartMode === "cash";

		const series = isCash
			? [
					{
						key: "in",
						label: "Money in",
						color: "#34d399",
						values: points.map((p) => p.walletIn),
						area: true,
					},
					{
						key: "out",
						label: "Money out",
						color: "#fbbf24",
						values: points.map((p) => p.walletOut),
					},
				]
			: [
					{
						key: "net",
						label: "Net worth change",
						color: "#38bdf8",
						values: points.map((p) => p.netWorthDelta),
						area: true,
					},
					{
						key: "cash",
						label: "Cash flow",
						color: "#a78bfa",
						values: points.map((p) => p.walletNet),
						dashed: true,
					},
				];

		renderLineChart(canvas, {
			series,
			labels: points.map((point) => point.date.slice(5)),
			ariaLabel: isCash
				? `Daily money in and money out over ${points.length} days`
				: `Daily net worth change and cash flow over ${points.length} days`,
			emptyMessage: "No movements recorded for this timeframe.",
			formatPrimary: formatCompactNumber,
			allowNegative: !isCash,
			zeroLine: !isCash,
			stretch: true,
			onScrub: (index) => {
				if (!strip) return;
				const point = index === null ? null : (points[index] ?? null);
				strip.innerHTML = point
					? `<span>${escapeHtml(point.date)}</span>
						<span>in <span class="val-green">${formatMoney(point.walletIn)}</span> ·
						out <span class="val-amber">${formatMoney(point.walletOut)}</span> ·
						net worth ${signedMoney(point.netWorthDelta)} ·
						${formatNumber(point.events)} events</span>`
					: "<span>Scrub the chart for a daily breakdown</span>";
			},
		});
	}
}
