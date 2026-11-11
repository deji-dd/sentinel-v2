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
import { apiFetch, compactMoney, isoDate, money, pct } from "../lib/api";

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
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

					<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
						<div className="lg:col-span-2">
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

						<SectionCard
							title="Holdings"
							description={
								isPaper
									? "Simulated allocation — no investor names."
									: "Allocation is shown without investor names."
							}
						>
							{data?.holdings.length ? (
								<ul className="space-y-2">
									{data.holdings.map((holding) => (
										<li
											key={holding.stockId}
											className="flex items-center justify-between gap-2 text-sm"
										>
											<span className="min-w-0 truncate">
												<span className="font-mono text-xs text-muted-foreground">
													{holding.acronym}
												</span>{" "}
												{holding.name}
											</span>
											<span className="font-mono text-xs">
												{holding.weightPct.toFixed(1)}%
											</span>
										</li>
									))}
								</ul>
							) : (
								<EmptyState title="No positions yet" />
							)}
						</SectionCard>
					</div>

					<div
						className={
							isPaper ? "mt-4" : "mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2"
						}
					>
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
												<TableCell className="text-xs text-muted-foreground">
													{isoDate(trade.occurredAtIso)}
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
							<SectionCard
								title="How the fund works"
								description="Fees reward patient capital and only apply to profit paid out."
							>
								<ul className="space-y-2 text-sm text-muted-foreground">
									{data?.feeSchedule.map((fee) => (
										<li
											key={fee.frequency}
											className="flex justify-between gap-3"
										>
											<span>{fee.label} payout</span>
											<span className="font-mono text-foreground">
												{(fee.feeBps / 100).toFixed(0)}% of profit
											</span>
										</li>
									))}
									<li className="flex justify-between gap-3 border-t border-border/60 pt-2">
										<span>Principal</span>
										<span className="text-foreground">Stays invested</span>
									</li>
									<li className="flex justify-between gap-3">
										<span>NAV (Net Asset Value)</span>
										<span className="text-right text-foreground">
											Total assets ÷ units outstanding
										</span>
									</li>
									<li className="flex justify-between gap-3">
										<span>Withdrawals</span>
										<span className="text-foreground">
											Quoted before approval
										</span>
									</li>
								</ul>
								<p className="mt-4 text-xs text-muted-foreground">
									Torn City is a game. This page is informational, not financial
									advice; capital is held in-game and payouts are made manually.
								</p>
							</SectionCard>
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
