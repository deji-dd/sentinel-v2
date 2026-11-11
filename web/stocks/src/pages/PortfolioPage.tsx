import type {
	CapitalInvestorPortfolio,
	CapitalWithdrawalQuote,
} from "@sentinel/schemas";
import { Loader2, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PerformanceChart } from "../components/PerformanceChart";
import {
	Button,
	EmptyState,
	ErrorBanner,
	Input,
	PageHeader,
	PageShell,
	SectionCard,
	Select,
	Spinner,
	StatCard,
	StatusBadge,
} from "../components/ui";
import { useAuth } from "../contexts/AuthContext";
import { apiFetch, isoDate, money, pct } from "../lib/api";

export function PortfolioPage() {
	const { authenticated, loading: authLoading, loginWithDiscord } = useAuth();
	const [portfolio, setPortfolio] = useState<CapitalInvestorPortfolio | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [lotId, setLotId] = useState("");
	const [amount, setAmount] = useState("");
	const [quote, setQuote] = useState<CapitalWithdrawalQuote | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await apiFetch<CapitalInvestorPortfolio>("/v2/capital/me");
			setPortfolio(data);
			const firstActive = data.lots.find((lot) => lot.status === "active");
			if (firstActive) setLotId((current) => current || firstActive.id);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to load portfolio.",
			);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!authLoading && authenticated) void load();
		if (!authLoading && !authenticated) setLoading(false);
	}, [authLoading, authenticated, load]);

	if (authLoading || loading)
		return <Spinner label="Loading your portfolio…" />;

	if (!authenticated) {
		return (
			<PageShell>
				<PageHeader
					title="Your portfolio"
					description="Sign in with Discord to see your lots, payouts and withdrawal quotes."
					actions={
						<Button onClick={() => loginWithDiscord("/portfolio")}>
							Sign in with Discord
						</Button>
					}
				/>
				<EmptyState
					title="Sign-in required"
					description="Only you can see your position. The public fund page stays available without an account."
				/>
			</PageShell>
		);
	}

	const totals = portfolio?.totals;
	const activeLots =
		portfolio?.lots.filter((lot) => lot.status === "active") ?? [];

	const requestQuote = async () => {
		if (!lotId || !amount) return;
		setBusy(true);
		setError(null);
		try {
			const data = await apiFetch<CapitalWithdrawalQuote>(
				"/v2/capital/me/withdrawals/quote",
				{
					method: "POST",
					body: JSON.stringify({ investmentId: lotId, amount }),
				},
			);
			setQuote(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Quote failed.");
		} finally {
			setBusy(false);
		}
	};

	const submitWithdrawal = async () => {
		if (!lotId || !amount) return;
		setBusy(true);
		setError(null);
		try {
			await apiFetch("/v2/capital/me/withdrawals", {
				method: "POST",
				body: JSON.stringify({ investmentId: lotId, amount }),
			});
			setQuote(null);
			setAmount("");
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Request failed.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<PageShell>
			<PageHeader
				title="Your portfolio"
				description="Every deposit is its own lot, priced at NAV when it was recorded."
				badge={<StatusBadge tone="primary">Private</StatusBadge>}
			/>

			{error ? <ErrorBanner message={error} /> : null}

			{portfolio?.investor ? (
				<p className="mb-4 text-sm text-muted-foreground">
					Signed in as{" "}
					<span className="font-semibold text-foreground">
						{portfolio.investor.displayName}
					</span>
					{portfolio.investor.tornId
						? ` · Torn #${portfolio.investor.tornId}`
						: ""}
				</p>
			) : null}

			{totals ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<StatCard label="Principal" value={money(totals.principal)} />
					<StatCard
						label="Current value"
						value={money(totals.currentValue)}
						tone="info"
					/>
					<StatCard
						label="Total profit"
						value={money(totals.totalProfit)}
						tone={Number(totals.totalProfit) >= 0 ? "success" : "danger"}
						hint={`${pct(totals.totalReturnPct)} total return`}
					/>
					<StatCard
						label="APR (indicative)"
						value={pct(totals.aprPct)}
						hint={`${totals.daysInvested ?? "—"} days invested`}
					/>
				</div>
			) : null}

			<div className="mt-4">
				<SectionCard
					title="Fund performance"
					description="The public NAV line. Your own return includes your lots' payouts and is shown above."
				>
					<PerformanceChart points={portfolio?.performance ?? []} />
				</SectionCard>
			</div>

			<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
				<div className="space-y-4 lg:col-span-2">
					<SectionCard
						title="Lots"
						description="One lot per deposit. Payouts follow each lot's own cadence."
					>
						{activeLots.length === 0 ? (
							<EmptyState
								title="No active investment"
								description="Contact the fund manager to open a lot. Deposits are recorded manually after the in-game transfer."
							/>
						) : (
							<div className="space-y-3">
								{activeLots.map((lot) => (
									<div
										key={lot.id}
										className="rounded-lg border border-border/60 p-3"
									>
										<div className="flex flex-wrap items-center justify-between gap-2">
											<div className="flex items-center gap-2">
												<StatusBadge tone="primary">
													{lot.frequency}
												</StatusBadge>
												<span className="font-mono text-xs text-muted-foreground">
													{lot.id.slice(0, 8)}
												</span>
											</div>
											<span className="text-xs text-muted-foreground">
												Next: {isoDate(lot.nextPayoutAtIso)}
											</span>
										</div>
										<div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
											<div>
												<p className="text-xs text-muted-foreground">
													Principal
												</p>
												<p className="font-mono">{money(lot.principal)}</p>
											</div>
											<div>
												<p className="text-xs text-muted-foreground">Value</p>
												<p className="font-mono">{money(lot.currentValue)}</p>
											</div>
											<div>
												<p className="text-xs text-muted-foreground">
													Total profit
												</p>
												<p className="font-mono">{money(lot.totalProfit)}</p>
											</div>
											<div>
												<p className="text-xs text-muted-foreground">APR</p>
												<p className="font-mono">{pct(lot.aprPct)}</p>
											</div>
										</div>
									</div>
								))}
							</div>
						)}
					</SectionCard>

					<SectionCard title="Payout history">
						{portfolio?.payouts.length ? (
							<div className="overflow-x-auto">
								<table className="w-full min-w-[600px] text-left text-sm">
									<thead className="text-xs uppercase tracking-wide text-muted-foreground">
										<tr>
											<th className="pb-2">Due</th>
											<th className="pb-2">Gross</th>
											<th className="pb-2">Fee</th>
											<th className="pb-2">Net</th>
											<th className="pb-2">Status</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-border/60">
										{portfolio.payouts.map((payout) => (
											<tr key={payout.id}>
												<td className="py-2 text-xs text-muted-foreground">
													{isoDate(payout.dueAtIso)}
												</td>
												<td className="py-2 font-mono text-xs">
													{money(payout.grossAmount)}
												</td>
												<td className="py-2 font-mono text-xs">
													{money(payout.feeAmount)}
												</td>
												<td className="py-2 font-mono text-xs">
													{money(payout.netAmount)}
												</td>
												<td className="py-2">
													<StatusBadge
														tone={
															payout.status === "paid"
																? "success"
																: payout.status === "unfunded"
																	? "danger"
																	: "warning"
														}
													>
														{payout.status}
													</StatusBadge>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						) : (
							<EmptyState title="No payouts yet" />
						)}
					</SectionCard>
				</div>

				<div className="space-y-4">
					<SectionCard
						title="Request a withdrawal"
						description="A quote shows the performance fee and any loss before anything is paid."
					>
						<div className="space-y-3">
							<label className="block text-xs font-medium text-muted-foreground">
								Lot
								<Select
									className="mt-1"
									value={lotId}
									onChange={(event) => {
										setLotId(event.target.value);
										setQuote(null);
									}}
								>
									{activeLots.map((lot) => (
										<option key={lot.id} value={lot.id}>
											{lot.frequency} · {money(lot.principal)} principal
										</option>
									))}
								</Select>
							</label>
							<label className="block text-xs font-medium text-muted-foreground">
								Amount (USD)
								<Input
									className="mt-1"
									inputMode="decimal"
									placeholder="1000000"
									value={amount}
									onChange={(event) => {
										setAmount(event.target.value);
										setQuote(null);
									}}
								/>
							</label>
							<div className="flex flex-col gap-2 sm:flex-row">
								<Button
									variant="secondary"
									onClick={requestQuote}
									disabled={busy || !lotId || !amount}
								>
									{busy ? <Loader2 className="size-4 animate-spin" /> : null}
									Get quote
								</Button>
								<Button onClick={submitWithdrawal} disabled={busy || !quote}>
									<Wallet className="size-4" /> Request
								</Button>
							</div>

							{quote ? (
								<div className="space-y-1 rounded-lg border border-border/60 p-3 text-sm">
									<div className="flex justify-between gap-2">
										<span className="text-muted-foreground">Gross</span>
										<span className="font-mono">{money(quote.grossValue)}</span>
									</div>
									<div className="flex justify-between gap-2">
										<span className="text-muted-foreground">
											Performance fee
										</span>
										<span className="font-mono">
											{money(quote.performanceFee)}
										</span>
									</div>
									<div className="flex justify-between gap-2">
										<span className="text-muted-foreground">Exit fee</span>
										<span className="font-mono">{money(quote.exitFee)}</span>
									</div>
									{Number(quote.lossAmount) > 0 ? (
										<div className="flex justify-between gap-2 text-warning">
											<span>Realised loss</span>
											<span className="font-mono">
												{money(quote.lossAmount)}
											</span>
										</div>
									) : null}
									<div className="flex justify-between gap-2 border-t border-border/60 pt-1 font-semibold">
										<span>Net to you</span>
										<span className="font-mono">{money(quote.netAmount)}</span>
									</div>
									{quote.liquidityWarning ? (
										<p className="text-xs text-warning">
											{quote.liquidityWarning}
										</p>
									) : null}
								</div>
							) : null}
						</div>
					</SectionCard>

					<SectionCard title="Withdrawal requests">
						{portfolio?.withdrawals.length ? (
							<ul className="space-y-2 text-sm">
								{portfolio.withdrawals.map((request) => (
									<li
										key={request.id}
										className="flex items-center justify-between gap-2"
									>
										<span className="min-w-0 truncate text-xs text-muted-foreground">
											{isoDate(request.requestedAtIso)} ·{" "}
											{money(request.netAmount)}
										</span>
										<StatusBadge
											tone={
												request.status === "paid"
													? "success"
													: request.status === "rejected"
														? "danger"
														: "warning"
											}
										>
											{request.status}
										</StatusBadge>
									</li>
								))}
							</ul>
						) : (
							<EmptyState title="No withdrawal requests" />
						)}
					</SectionCard>
				</div>
			</div>
		</PageShell>
	);
}
