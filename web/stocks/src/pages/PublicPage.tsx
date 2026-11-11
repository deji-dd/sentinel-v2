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
	EmptyState,
	ErrorBanner,
	PageHeader,
	PageShell,
	SectionCard,
	Spinner,
	StatCard,
	StatusBadge,
} from "../components/ui";
import { useAuth } from "../contexts/AuthContext";
import { api, compactMoney, isoDate, money, pct } from "../lib/api";

export function PublicPage() {
	const [data, setData] = useState<CapitalPublicOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const { loginWithDiscord } = useAuth();

	useEffect(() => {
		let cancelled = false;
		api.v2.capital
			.public!.get()
			.then((res) => {
				if (cancelled) return;
				if (res.data) setData(res.data as CapitalPublicOverview);
				else setError("The fund is not available yet.");
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
	}, []);

	if (loading) return <Spinner label="Loading the fund…" />;

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
				title="Sentinel Capital"
				description="A managed, transparent Torn City stock trading fund. Share-level recommendations, a public ledger, and clear risk."
				badge={<StatusBadge tone="success">Live</StatusBadge>}
				actions={
					<button
						type="button"
						onClick={() => loginWithDiscord("/portfolio")}
						className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
					>
						View my portfolio <ArrowUpRight className="size-4" />
					</button>
				}
			/>

			{error ? <ErrorBanner message={error} /> : null}

			{summary ? (
				<>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<StatCard
							label={
								data?.flags.showAum
									? "Assets under management"
									: "AUM (private)"
							}
							value={data?.flags.showAum ? compactMoney(summary.aum) : "—"}
							hint={`${summary.investorCount} active investor${summary.investorCount === 1 ? "" : "s"}`}
						/>
						<StatCard
							label="NAV / unit"
							value={money(summary.navPerUnit)}
							hint={`${summary.daysRunning ?? "—"} days running`}
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
							label="Distributed to investors"
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
								description="The public performance line, indexed from the fund's daily snapshots."
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
							description="Allocation is shown without investor names."
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

					<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
						<SectionCard
							title="Recent trades"
							description="Confirmed live fills."
						>
							{data?.trades.length ? (
								<div className="overflow-x-auto">
									<table className="w-full min-w-[520px] text-left text-sm">
										<thead className="text-xs uppercase tracking-wide text-muted-foreground">
											<tr>
												<th className="pb-2">Stock</th>
												<th className="pb-2">Side</th>
												<th className="pb-2">Shares</th>
												<th className="pb-2">Price</th>
												<th className="pb-2">Date</th>
											</tr>
										</thead>
										<tbody className="divide-y divide-border/60">
											{data.trades.map((trade) => (
												<tr key={trade.id}>
													<td className="py-2">
														<span className="font-mono text-xs text-muted-foreground">
															{trade.acronym}
														</span>{" "}
														{trade.name}
													</td>
													<td className="py-2">
														<StatusBadge
															tone={trade.side === "buy" ? "success" : "danger"}
														>
															{trade.side}
														</StatusBadge>
													</td>
													<td className="py-2 font-mono text-xs">
														{trade.shares.toLocaleString()}
													</td>
													<td className="py-2 font-mono text-xs">
														{money(trade.price)}
													</td>
													<td className="py-2 text-xs text-muted-foreground">
														{isoDate(trade.occurredAtIso)}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							) : (
								<EmptyState title="No public trades yet" />
							)}
						</SectionCard>

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
											{(fee.feeBps / 100).toFixed(2)}% of profit
										</span>
									</li>
								))}
								<li className="flex justify-between gap-3 border-t border-border/60 pt-2">
									<span>Principal</span>
									<span className="text-foreground">Stays invested</span>
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
					</div>
				</>
			) : null}

			<div className="mt-6 rounded-xl border border-border/60 bg-card p-4 text-xs text-muted-foreground">
				<TrendingUp className="mr-1 inline size-3.5" />
				Want to invest? Open your portfolio, or contact the fund manager on
				Discord. Public figures are aggregate and never include investor names.
			</div>
		</PageShell>
	);
}
