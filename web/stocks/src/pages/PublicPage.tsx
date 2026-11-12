import type { CapitalPublicOverview } from "@sentinel/schemas";
import { ArrowUpRight, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";

import {
	Button,
	EmptyState,
	ErrorBanner,
	PageHeader,
	PageShell,
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
} from "../components/ui";
import { useAuth } from "../contexts/AuthContext";
import {
	apiFetch,
	compactMoney,
	exitReasonLabel,
	isoDate,
	money,
	pct,
	tctDate,
	tctTime,
} from "../lib/api";

export function PublicPage({ book = "live" }: { book?: "live" | "paper" }) {
	const [data, setData] = useState<CapitalPublicOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const { loginWithDiscord } = useAuth();
	const isPaper = book === "paper";

	useEffect(() => {
		let cancelled = false;
		apiFetch<CapitalPublicOverview>(`/v2/capital/public?book=${book}`)
			.then((overview) => {
				if (cancelled) return;
				setData(overview);
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
	}, [book]);

	if (loading)
		return (
			<Spinner
				label={isPaper ? "Loading paper results…" : "Loading the fund…"}
			/>
		);

	const summary = data?.summary;
	const chartData =
		data?.performance.map((point) => ({
			date: isoDate(point.capturedAtIso),
			nav: Number(point.navPerUnit),
			returnPct: point.returnPct,
		})) ?? [];

	return (
		<PageShell>
			<PageHeader
				title={isPaper ? "Paper results" : "Blasted Stocks"}
				description={
					isPaper
						? "Simulated Blasted Stocks results — no real funds. See how the strategy would have performed."
						: "A managed, transparent Torn City stock trading fund."
				}
				badge={
					isPaper ? <StatusBadge tone="warning">Simulated</StatusBadge> : null
				}
				actions={
					isPaper ? (
						<Button variant="outline" asChild>
							<a href="#/">View live fund</a>
						</Button>
					) : (
						<Button onClick={() => loginWithDiscord("/portfolio")}>
							View my portfolio <ArrowUpRight className="size-4" />
						</Button>
					)
				}
			/>

			{error ? <ErrorBanner message={error} /> : null}

			{data?.warnings.length ? (
				<div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
					{data.warnings.join(" ")}
				</div>
			) : null}

			{summary ? (
				<>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<StatCard
							label={
								data?.flags.showAum
									? isPaper
										? "Simulated AUM"
										: "Assets under management"
									: "AUM (private)"
							}
							value={data?.flags.showAum ? compactMoney(summary.aum) : "—"}
							hint={
								isPaper
									? "Paper test book — no real capital"
									: `${summary.investorCount} active investor${summary.investorCount === 1 ? "" : "s"}`
							}
							help="Assets Under Management: the total market value the fund manages — cash plus stock positions at current prices. AUM divided by units outstanding gives NAV per unit."
						/>
						<StatCard
							label="Capital deployed"
							value={
								data?.flags.showAum ? compactMoney(summary.positionsValue) : "—"
							}
							hint="Open positions at the last price"
							help="Market value of the fund's open stock positions. AUM is this plus available cash."
						/>
						<StatCard
							label="Available cash"
							value={data?.flags.showAum ? compactMoney(summary.cash) : "—"}
							hint="Liquid, not currently invested"
							help="Cash held by the fund and available to fund new positions or withdrawals. The engine keeps a reserve instead of putting 100% to work."
						/>
						<StatCard
							label="NAV / unit"
							value={money(summary.navPerUnit)}
							hint={`${summary.daysRunning ?? "—"} days running`}
							help="Net Asset Value: the fund's total assets divided by the units outstanding. Each deposit buys units at the NAV on that day."
						/>
						<StatCard
							label="Since inception"
							value={pct(summary.sinceInceptionReturnPct)}
							tone={
								(summary.sinceInceptionReturnPct ?? 0) >= 0
									? "success"
									: "danger"
							}
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
								title="NAV per unit"
								description={
									isPaper
										? "Simulated Net Asset Value per unit — no real funds — indexed from the paper book's daily snapshots."
										: "Net Asset Value per unit — total assets divided by units outstanding — indexed from the fund's daily snapshots."
								}
							>
								{chartData.length < 2 ? (
									<EmptyState
										title="Not enough history yet"
										description="The chart appears after the first few daily snapshots."
									/>
								) : (
									<div className="h-64 w-full">
										<ResponsiveContainer width="100%" height="100%">
											<AreaChart data={chartData}>
												<defs>
													<linearGradient
														id="navFill"
														x1="0"
														y1="0"
														x2="0"
														y2="1"
													>
														<stop
															offset="5%"
															stopColor="var(--primary)"
															stopOpacity={0.35}
														/>
														<stop
															offset="95%"
															stopColor="var(--primary)"
															stopOpacity={0}
														/>
													</linearGradient>
												</defs>
												<CartesianGrid
													stroke="var(--border)"
													strokeOpacity={0.4}
													vertical={false}
												/>
												<XAxis
													dataKey="date"
													stroke="var(--muted-foreground)"
													fontSize={11}
													tickLine={false}
													axisLine={false}
												/>
												<YAxis
													stroke="var(--muted-foreground)"
													fontSize={11}
													tickLine={false}
													axisLine={false}
													width={48}
												/>
												<Tooltip
													contentStyle={{
														background: "var(--card)",
														border: "1px solid var(--border)",
														borderRadius: 8,
														fontSize: 12,
													}}
												/>
												<Area
													type="monotone"
													dataKey="nav"
													stroke="var(--primary)"
													fill="url(#navFill)"
													strokeWidth={2}
													name="NAV / unit"
												/>
											</AreaChart>
										</ResponsiveContainer>
									</div>
								)}
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
											<TableHead>Weight</TableHead>
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
												<TableCell className="font-mono text-xs">
													{pct(position.weightPct, 1)}
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

					{isPaper ? (
						<div className="mt-4">
							<SectionCard
								title="Investors"
								description="Simulated investor results. Cadence and payout settings are not shown."
							>
								{data?.investors.length ? (
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
														Test Investor {index + 1}
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
								) : (
									<EmptyState title="No paper investors yet" />
								)}
							</SectionCard>
						</div>
					) : null}

					<div className="mt-4">
						<SectionCard
							title="Recent trades"
							description={
								isPaper ? "Simulated paper fills." : "Confirmed live fills."
							}
						>
							{data?.trades.length ? (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Stock</TableHead>
											<TableHead>Side</TableHead>
											<TableHead>Shares</TableHead>
											<TableHead>Price</TableHead>
											<TableHead>Value</TableHead>
											<TableHead>Reason</TableHead>
											<TableHead>Date</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.trades.map((trade) => (
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
												<TableCell className="text-xs">
													{trade.side === "sell"
														? exitReasonLabel(trade.exitReason)
														: "—"}
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
		</PageShell>
	);
}
