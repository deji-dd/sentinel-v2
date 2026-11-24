import {
	CAPITAL_APR_MIN_DAYS,
	CAPITAL_TRADES_PAGE_SIZE,
	type CapitalPublicOverview,
	type CapitalPublicTrade,
	type CapitalPublicTradesPage,
} from "@sentinel/schemas";
import { ArrowUpRight, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";

import { PerformanceChart } from "../components/PerformanceChart";
import {
	Button,
	EmptyState,
	ErrorBanner,
	PageHeader,
	PageShell,
	Pagination,
	SectionCard,
	Spinner,
	StatCard,
	StatusBadge,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../components/ui";
import { useAuth } from "../contexts/AuthContext";
import {
	apiFetch,
	compactMoney,
	money,
	pct,
	tctDate,
	tctTime,
} from "../lib/api";
import { useCapitalLive } from "../lib/live";

type Book = "live" | "paper";

export function PublicPage({ book: initialBook = "live" }: { book?: Book }) {
	const [book, setBook] = useState<Book>(initialBook);
	const { loginWithDiscord } = useAuth();
	const isPaper = book === "paper";

	return (
		<PageShell>
			<PageHeader
				title="Fund"
				description={
					isPaper
						? "Simulated, transparent Torn City stock trading fund."
						: "A managed, transparent Torn City stock trading fund."
				}
				actions={
					<Button onClick={() => loginWithDiscord("/portfolio")}>
						View my portfolio <ArrowUpRight className="size-4" />
					</Button>
				}
			/>

			<Tabs value={book} onValueChange={(value) => setBook(value as Book)}>
				<TabsList className="mb-4">
					<TabsTrigger value="live">Live</TabsTrigger>
					<TabsTrigger value="paper">Simulation</TabsTrigger>
				</TabsList>
				<TabsContent value="live">
					<BookOverview book="live" />
				</TabsContent>
				<TabsContent value="paper">
					<BookOverview book="paper" />
				</TabsContent>
			</Tabs>
		</PageShell>
	);
}

function BookOverview({ book }: { book: Book }) {
	const [data, setData] = useState<CapitalPublicOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [granularity, setGranularity] = useState<"hourly" | "daily">("daily");
	const [tradesPage, setTradesPage] = useState(1);
	const [pagedTrades, setPagedTrades] = useState<CapitalPublicTrade[] | null>(
		null,
	);
	const [tradesLoading, setTradesLoading] = useState(false);
	const isPaper = book === "paper";

	const { markUpdated } = useCapitalLive<CapitalPublicOverview>({
		view: "public",
		book,
		granularity,
		onSnapshot: (overview) => {
			setData(overview);
			setError(null);
			setLoading(false);
		},
	});

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		apiFetch<CapitalPublicOverview>(
			`/v2/capital/public?book=${book}&granularity=${granularity}`,
		)
			.then((overview) => {
				if (cancelled) return;
				setData(overview);
				markUpdated();
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "Failed to load.");
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [book, granularity, markUpdated]);

	useEffect(() => {
		setTradesPage(1);
		setPagedTrades(null);
	}, [book]);

	useEffect(() => {
		if (tradesPage <= 1) {
			setPagedTrades(null);
			return;
		}
		let cancelled = false;
		setTradesLoading(true);
		apiFetch<CapitalPublicTradesPage>(
			`/v2/capital/public/trades?book=${book}&page=${tradesPage}&pageSize=${CAPITAL_TRADES_PAGE_SIZE}`,
		)
			.then((page) => {
				if (!cancelled) setPagedTrades(page.trades);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(
						err instanceof Error ? err.message : "Failed to load trades.",
					);
				}
			})
			.finally(() => {
				if (!cancelled) setTradesLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [book, tradesPage]);

	if (loading)
		return (
			<Spinner label={isPaper ? "Loading simulation…" : "Loading the fund…"} />
		);

	const summary = data?.summary;
	const aprDaysRemaining =
		summary?.daysRunning === null || summary?.daysRunning === undefined
			? null
			: Math.max(1, CAPITAL_APR_MIN_DAYS - summary.daysRunning);
	const aprHint =
		summary?.aprSinceInceptionPct !== null &&
		summary?.aprSinceInceptionPct !== undefined
			? `Indicative · ${summary.daysRunning ?? "—"} days`
			: aprDaysRemaining !== null
				? `Calculated in ${aprDaysRemaining} day${aprDaysRemaining === 1 ? "" : "s"}`
				: `Calculated after ${CAPITAL_APR_MIN_DAYS} days`;
	const performancePoints = data?.performance ?? [];
	const tradesTotal = data?.tradesTotal ?? 0;
	const tradesPageCount = Math.ceil(tradesTotal / CAPITAL_TRADES_PAGE_SIZE);
	const trades = tradesPage === 1 ? (data?.trades ?? []) : (pagedTrades ?? []);

	return (
		<>
			{error ? <ErrorBanner message={error} /> : null}

			{data?.warnings.length ? (
				<div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
					{data.warnings.join(" ")}
				</div>
			) : null}

			{summary ? (
				<>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
						<StatCard
							label={
								data?.flags.showAum
									? isPaper
										? "Amount Invested"
										: "Assets under management"
									: "AUM (private)"
							}
							value={
								data?.flags.showAum
									? compactMoney(
											isPaper ? summary.investedCapital : summary.aum,
										)
									: "—"
							}
							hint={
								isPaper
									? "Capital deployed in the simulation"
									: `${summary.investorCount} active investor${summary.investorCount === 1 ? "" : "s"}`
							}
							help={
								isPaper
									? "Total capital deployed in the simulation — the sum of all deposits minus withdrawals."
									: "Assets Under Management: the total market value the fund manages — cash plus stock positions at current prices. AUM divided by units outstanding gives NAV per unit."
							}
						/>
						<StatCard
							label="Unit price"
							value={money(summary.navPerUnit, 4)}
							hint={`${summary.daysRunning ?? "—"} days running`}
							help="The fund's net assets divided by its units outstanding — what one unit is worth today. Each deposit buys units at this price. Also called NAV per unit."
						/>
						<StatCard
							label="ROI"
							value={pct(summary.sinceInceptionReturnPct)}
							tone={
								(summary.sinceInceptionReturnPct ?? 0) >= 0
									? "success"
									: "danger"
							}
							help="Return on investment since the fund started at $1.00 per unit. It is the change in unit price, so deposits and withdrawals do not affect it."
						/>
						<StatCard
							label="APR"
							value={pct(summary.aprSinceInceptionPct)}
							hint={aprHint}
							tone={
								(summary.aprSinceInceptionPct ?? 0) >= 0 ? "success" : "danger"
							}
							help={`Annualized ROI based on the fund's track record. Indicative: a short history exaggerates annualized figures. Calculated after ${CAPITAL_APR_MIN_DAYS} days of trading.`}
						/>
						<StatCard
							label={
								isPaper ? "Simulated distributions" : "Distributed to investors"
							}
							value={compactMoney(summary.cumulativePayouts)}
							hint={
								data?.flags.showFees
									? `${compactMoney(summary.cumulativeFees)} performance fees`
									: undefined
							}
						/>
					</div>

					<div className="mt-4">
						<div>
							<SectionCard
								title="Unit price history"
								description={
									granularity === "hourly"
										? isPaper
											? "Simulated unit price — hourly snapshots (last 7 days)."
											: "Unit price (NAV per unit) — hourly snapshots (last 7 days)."
										: isPaper
											? "Simulated unit price — no real funds — indexed from the simulation book's daily snapshots."
											: "Unit price (net assets per unit) — indexed from the fund's daily snapshots."
								}
								actions={
									<Tabs
										value={granularity}
										onValueChange={(value) =>
											setGranularity(value as "hourly" | "daily")
										}
									>
										<TabsList className="h-8">
											<TabsTrigger value="daily" className="px-3 text-xs">
												Daily
											</TabsTrigger>
											<TabsTrigger value="hourly" className="px-3 text-xs">
												Hourly (7d)
											</TabsTrigger>
										</TabsList>
									</Tabs>
								}
							>
								<PerformanceChart
									points={performancePoints}
									granularity={granularity}
								/>
							</SectionCard>
						</div>
					</div>

					<div className="mt-4">
						<SectionCard
							title="Current positions"
							description={
								isPaper
									? "Simulated open positions and marked-to-market profit/loss."
									: "Open fund positions and marked-to-market profit/loss."
							}
						>
							{data?.positions.length ? (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Stock</TableHead>
											<TableHead>Shares</TableHead>
											<TableHead>Avg cost</TableHead>
											<TableHead>Price</TableHead>
											<TableHead>Value</TableHead>
											<TableHead>Unrealized P/L</TableHead>
											<TableHead>Realized P/L</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.positions.map((position) => (
											<TableRow key={position.stockId}>
												<TableCell>
													<span className="font-mono text-xs text-muted-foreground">
														{position.acronym}
													</span>{" "}
													{position.stockName}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{position.shares.toLocaleString()}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{money(position.averageCost)}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{money(position.price)}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{compactMoney(position.marketValue)}
												</TableCell>
												<TableCell
													className={
														Number(position.unrealizedPnl) >= 0
															? "font-mono text-xs text-success"
															: "font-mono text-xs text-destructive"
													}
												>
													<span className="block">
														{compactMoney(position.unrealizedPnl)}
													</span>
													{position.unrealizedPnlPct !== null ? (
														<span className="block text-[11px]">
															{pct(position.unrealizedPnlPct)}
														</span>
													) : null}
												</TableCell>
												<TableCell
													className={
														Number(position.realizedPnl) >= 0
															? "font-mono text-xs text-success"
															: "font-mono text-xs text-destructive"
													}
												>
													{compactMoney(position.realizedPnl)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							) : (
								<EmptyState title="No open positions" />
							)}
						</SectionCard>
					</div>

					{data?.investors.length ? (
						<div className="mt-4">
							<SectionCard
								title="Investors"
								description="Investor results. Cadence and payout settings are not shown."
							>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Investor</TableHead>
											<TableHead>Principal</TableHead>
											<TableHead>Value</TableHead>
											<TableHead>Profit</TableHead>
											<TableHead>APR</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.investors.map((investor, index) => (
											<TableRow key={index}>
												<TableCell className="truncate">
													Investor {index + 1}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{compactMoney(investor.principal)}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{compactMoney(investor.currentValue)}
												</TableCell>
												<TableCell
													className={
														Number(investor.totalProfit) >= 0
															? "font-mono text-xs text-success"
															: "font-mono text-xs text-destructive"
													}
												>
													{compactMoney(investor.totalProfit)}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{pct(investor.aprPct)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</SectionCard>
						</div>
					) : null}

					<div className="mt-4">
						<SectionCard
							title="Recent trades"
							description={
								isPaper ? "Simulated fills." : "Confirmed live fills."
							}
						>
							{trades.length ? (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Stock</TableHead>
											<TableHead>Side</TableHead>
											<TableHead>Shares</TableHead>
											<TableHead>Price</TableHead>
											<TableHead>Value</TableHead>
											<TableHead>Date</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{trades.map((trade) => (
											<TableRow key={trade.id}>
												<TableCell>
													<span className="font-mono text-xs text-muted-foreground">
														{trade.acronym}
													</span>{" "}
													{trade.name}
												</TableCell>
												<TableCell>
													<StatusBadge
														tone={trade.side === "buy" ? "success" : "danger"}
													>
														{trade.side}
													</StatusBadge>
												</TableCell>
												<TableCell className="font-mono text-xs">
													{trade.shares.toLocaleString()}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{money(trade.price)}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{compactMoney(trade.notional)}
												</TableCell>
												<TableCell className="text-xs text-muted-foreground">
													<span className="block">
														{tctDate(trade.occurredAtIso)}
													</span>
													<span className="block font-mono text-[11px]">
														{tctTime(trade.occurredAtIso)}
													</span>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							) : (
								<EmptyState title="No public trades yet" />
							)}
							<Pagination
								page={tradesPage}
								pageCount={tradesPageCount}
								onPageChange={setTradesPage}
								disabled={tradesLoading}
								label={`Page ${tradesPage} of ${tradesPageCount} · ${tradesTotal.toLocaleString()} fills`}
							/>
						</SectionCard>

						{isPaper ? null : (
							<div className="mt-4">
								<SectionCard
									title="How the fund works"
									description="Only profit that is paid out attracts a fee."
								>
									<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
										{data?.feeSchedule.map((fee) => (
											<div
												key={fee.frequency}
												className="rounded-lg border border-border/60 px-3 py-2"
											>
												<p className="text-xs text-muted-foreground">
													{fee.label} payout
												</p>
												<p className="font-mono text-sm font-semibold">
													{(fee.feeBps / 100).toFixed(0)}% of profit
												</p>
											</div>
										))}
									</div>
									<p className="mt-3 text-xs text-muted-foreground">
										Principal stays invested and withdrawals are quoted before
										approval. Torn City is a game; this page is informational,
										not financial advice.
									</p>
								</SectionCard>
							</div>
						)}
					</div>
				</>
			) : null}

			<div className="mt-6 rounded-xl border border-border/60 bg-card p-4 text-xs text-muted-foreground">
				<TrendingUp className="mr-1 inline size-3.5" />
				{isPaper ? (
					<>
						These are simulated results. Want to invest in the live fund?
						Contact{" "}
						<a
							href="https://www.torn.com/profiles.php?XID=1934909"
							className="text-primary underline"
						>
							Blasted
						</a>{" "}
						for details.
					</>
				) : (
					<>
						Want to invest? Contact{" "}
						<a
							href="https://www.torn.com/profiles.php?XID=1934909"
							className="text-primary underline"
						>
							Blasted
						</a>{" "}
						for details.
					</>
				)}
			</div>
		</>
	);
}
