import type {
	CapitalAlertDeliveryStatus,
	CapitalAlertPreferences,
	CapitalInvestorPortfolio,
	CapitalWithdrawalQuote,
} from "@sentinel/schemas";
import { Loader2, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PerformanceChart } from "../components/PerformanceChart";
import {
	Button,
	CheckboxField,
	EmptyState,
	ErrorBanner,
	Label,
	NumberInput,
	PageHeader,
	PageShell,
	SectionCard,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
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
import { useCapitalLive } from "../lib/live";

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
	const [preferences, setPreferences] =
		useState<CapitalAlertPreferences | null>(null);
	const [delivery, setDelivery] = useState<CapitalAlertDeliveryStatus | null>(
		null,
	);
	const [botUserId, setBotUserId] = useState("");
	const [busy, setBusy] = useState(false);

	const { markUpdated } = useCapitalLive<CapitalInvestorPortfolio>({
		view: "portfolio",
		enabled: authenticated && !authLoading,
		onSnapshot: (data) => {
			setPortfolio(data);
			setLoading(false);
		},
	});

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await apiFetch<CapitalInvestorPortfolio>("/v2/capital/me");
			setPortfolio(data);
			const firstActive = data.lots.find((lot) => lot.status === "active");
			if (firstActive) setLotId((current) => current || firstActive.id);
			markUpdated();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to load portfolio.",
			);
		} finally {
			setLoading(false);
		}
	}, [markUpdated]);

	useEffect(() => {
		if (!authLoading && authenticated) void load();
		if (!authLoading && !authenticated) setLoading(false);
	}, [authLoading, authenticated, load]);

	useEffect(() => {
		if (authLoading || !authenticated) return;
		apiFetch<{
			success: boolean;
			preferences: CapitalAlertPreferences | null;
			delivery: CapitalAlertDeliveryStatus | null;
			botUserId: string;
		}>("/v2/capital/me/alerts")
			.then((data) => {
				setPreferences(data.preferences);
				setDelivery(data.delivery);
				setBotUserId(data.botUserId ?? "");
			})
			.catch(() => {
				setPreferences(null);
				setDelivery(null);
			});
	}, [authLoading, authenticated]);

	const toggleAlertPreference = async (
		key: "payoutsEnabled" | "aprEnabled",
		value: boolean,
	) => {
		setBusy(true);
		setError(null);
		try {
			const data = await apiFetch<{
				success: boolean;
				preferences: CapitalAlertPreferences;
			}>("/v2/capital/me/alerts", {
				method: "PUT",
				body: JSON.stringify({ [key]: value }),
			});
			setPreferences(data.preferences);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not save alerts.");
		} finally {
			setBusy(false);
		}
	};

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
				description="Every deposit is its own lot, priced at NAV (Net Asset Value) when it was recorded."
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

			{delivery?.dmClosed ? (
				<div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
					<p className="font-semibold">Your alerts aren't reaching Discord</p>
					<p className="mt-1 text-warning/90">
						Discord rejected the bot's direct message. Follow these steps — the
						warning disappears automatically once a message gets through.
					</p>
					<ol className="mt-3 list-decimal space-y-2 pl-5">
						<li>
							Open a direct message with the bot.{" "}
							{botUserId ? (
								<Button variant="outline" size="sm" asChild>
									<a
										href={`https://discord.com/channels/@me/${botUserId}`}
										target="_blank"
										rel="noreferrer"
									>
										Message the bot
									</a>
								</Button>
							) : null}
						</li>
						<li>
							In Discord, go to User Settings → Privacy &amp; Safety and turn on
							“Allow direct messages from server members”.{" "}
							<Button variant="outline" size="sm" asChild>
								<a
									href="https://discord.com/settings/privacy"
									target="_blank"
									rel="noreferrer"
								>
									Privacy settings
								</a>
							</Button>
						</li>
						<li>
							Send any message to the bot, then return here. Your payout and APR
							alerts resume on the next successful delivery.
						</li>
					</ol>
				</div>
			) : null}

			<div className="mt-4">
				<SectionCard
					title="Alerts"
					description="Personal updates are sent to your linked Discord account. Each alert links back here so you can change these any time."
				>
					{preferences ? (
						<div className="flex flex-wrap gap-6">
							<CheckboxField
								label="Payout alerts — due and paid, including reinvestments"
								checked={preferences.payoutsEnabled}
								onCheckedChange={(checked) =>
									void toggleAlertPreference("payoutsEnabled", checked)
								}
							/>
							<CheckboxField
								label="APR alerts — milestone crossings after 30 days"
								checked={preferences.aprEnabled}
								onCheckedChange={(checked) =>
									void toggleAlertPreference("aprEnabled", checked)
								}
							/>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							Link an investment to this Discord account to receive personal
							alerts.
						</p>
					)}
				</SectionCard>
			</div>

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
								description={
									<>
										Contact{" "}
										<a
											href="https://www.torn.com/profiles.php?XID=1934909"
											className="text-primary underline"
										>
											Blasted
										</a>{" "}
										to open a lot. Deposits are recorded manually after the
										in-game transfer.
									</>
								}
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
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Due</TableHead>
										<TableHead>Gross</TableHead>
										<TableHead>Fee</TableHead>
										<TableHead>Net</TableHead>
										<TableHead>Status</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{portfolio.payouts.map((payout) => (
										<TableRow key={payout.id}>
											<TableCell className="text-xs text-muted-foreground">
												{isoDate(payout.dueAtIso)}
											</TableCell>
											<TableCell className="font-mono text-xs">
												{compactMoney(payout.grossAmount)}
											</TableCell>
											<TableCell className="font-mono text-xs">
												{compactMoney(payout.feeAmount)}
											</TableCell>
											<TableCell className="font-mono text-xs">
												{compactMoney(payout.netAmount)}
											</TableCell>
											<TableCell>
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
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
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
							<div className="space-y-1">
								<Label className="text-xs text-muted-foreground">Lot</Label>
								<Select
									value={lotId}
									onValueChange={(value) => {
										setLotId(value);
										setQuote(null);
									}}
								>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="Select a lot" />
									</SelectTrigger>
									<SelectContent>
										{activeLots.map((lot) => (
											<SelectItem key={lot.id} value={lot.id}>
												{lot.frequency} · {compactMoney(lot.principal)}{" "}
												principal
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<Label className="text-xs text-muted-foreground">
									Amount (USD)
								</Label>
								<NumberInput
									decimals={2}
									placeholder="1,000,000"
									value={amount}
									onValueChange={(value) => {
										setAmount(value);
										setQuote(null);
									}}
								/>
							</div>
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
											{compactMoney(request.netAmount)}
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
