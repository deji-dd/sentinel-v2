import type {
	CapitalAdminOverview,
	CapitalPayoutFrequency,
	CapitalSettings,
} from "@sentinel/schemas";
import { RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PerformanceChart } from "../components/PerformanceChart";
import {
	Button,
	CheckboxField,
	EmptyState,
	ErrorBanner,
	HelpTip,
	Input,
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

type Book = "live" | "paper";
type PayoutMode = "cash" | "reinvest";

const FREQUENCIES: Array<{ value: CapitalPayoutFrequency; label: string }> = [
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
	{ value: "monthly", label: "Monthly" },
];

const PAYOUT_MODES: Array<{ value: PayoutMode; label: string }> = [
	{ value: "cash", label: "Pay profit out" },
	{ value: "reinvest", label: "Reinvest profit" },
];

export function DeskPage({ book }: { book: Book }) {
	const { authenticated, loading: authLoading, loginWithDiscord } = useAuth();
	const [data, setData] = useState<CapitalAdminOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [settingsDraft, setSettingsDraft] = useState<CapitalSettings | null>(
		null,
	);

	const [investorName, setInvestorName] = useState("");
	const [investorTornId, setInvestorTornId] = useState("");
	const [investorKind, setInvestorKind] = useState(
		book === "paper" ? "test" : "user",
	);
	const [investorFrequency, setInvestorFrequency] =
		useState<CapitalPayoutFrequency>("weekly");
	const [investorPayoutMode, setInvestorPayoutMode] =
		useState<PayoutMode>("cash");
	const [depositInvestor, setDepositInvestor] = useState("");
	const [depositAmount, setDepositAmount] = useState("");
	const [intentInvestor, setIntentInvestor] = useState("");
	const [intentAmount, setIntentAmount] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const overview = await apiFetch<CapitalAdminOverview>(
				`/v2/capital/admin/${book}/overview`,
			);
			setData(overview);
			setSettingsDraft(overview.settings);
			const first = overview.investors[0]?.investor.id;
			if (first) setDepositInvestor((current) => current || first);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load the desk.");
		} finally {
			setLoading(false);
		}
	}, [book]);

	useEffect(() => {
		if (!authLoading && authenticated) void load();
		if (!authLoading && !authenticated) setLoading(false);
	}, [authLoading, authenticated, load]);

	useEffect(() => {
		setInvestorKind(book === "paper" ? "test" : "user");
	}, [book]);

	const runAction = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Action failed.");
		} finally {
			setBusy(false);
		}
	};

	const patchSettings = (patch: Partial<CapitalSettings>) => {
		setSettingsDraft((current) =>
			current ? { ...current, ...patch } : current,
		);
	};

	if (authLoading || loading) return <Spinner label="Loading the desk…" />;

	if (!authenticated) {
		return (
			<PageShell>
				<PageHeader
					title="Capital desk"
					description="Owner-only control surface."
					actions={
						<Button
							onClick={() =>
								loginWithDiscord(`/desk${book === "paper" ? "/paper" : ""}`)
							}
						>
							Sign in with Discord
						</Button>
					}
				/>
				<EmptyState title="Sign-in required" />
			</PageShell>
		);
	}

	const createInvestor = async () => {
		const tornId = Number(investorTornId);
		const tornIdRequired = book === "live";
		if (
			!investorName.trim() ||
			(tornIdRequired && (!Number.isInteger(tornId) || tornId <= 0))
		) {
			setError(
				tornIdRequired
					? "Display name and a valid Torn ID are required."
					: "Display name is required.",
			);
			return;
		}
		await runAction(() =>
			apiFetch(`/v2/capital/admin/${book}/investors`, {
				method: "POST",
				body: JSON.stringify({
					kind: book === "paper" ? "test" : investorKind,
					displayName: investorName.trim(),
					...(tornId > 0 ? { tornId } : {}),
					frequency: investorFrequency,
					payoutMode: investorPayoutMode,
				}),
			}),
		);
		setInvestorName("");
		setInvestorTornId("");
	};

	const updateInvestorSettings = async (
		investorId: string,
		patch: Partial<{
			frequency: CapitalPayoutFrequency;
			payoutMode: PayoutMode;
		}>,
	) => {
		setBusy(true);
		setError(null);
		try {
			await apiFetch(`/v2/capital/admin/${book}/investors/${investorId}`, {
				method: "PATCH",
				body: JSON.stringify(patch),
			});
			await load();
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Failed to update investor settings.",
			);
		} finally {
			setBusy(false);
		}
	};

	const createDeposit = async () => {
		if (!depositInvestor || !depositAmount) return;
		await runAction(() =>
			apiFetch(
				`/v2/capital/admin/${book}/investors/${depositInvestor}/deposits`,
				{
					method: "POST",
					body: JSON.stringify({ amount: depositAmount }),
				},
			),
		);
		setDepositAmount("");
	};

	const createIntent = async () => {
		const investor = data?.investors.find(
			(row) => row.investor.id === intentInvestor,
		)?.investor;
		if (!investor || !intentAmount) return;
		await runAction(() =>
			apiFetch(`/v2/capital/admin/${book}/payment-intents`, {
				method: "POST",
				body: JSON.stringify({
					kind: "deposit",
					investorId: investor.id,
					expectedAmount: intentAmount,
					counterpartyTornId: investor.tornId ?? undefined,
				}),
			}),
		);
		setIntentAmount("");
	};

	const summary = data?.summary;
	const investors = data?.investors ?? [];

	return (
		<PageShell>
			<PageHeader
				title={book === "paper" ? "Paper desk" : "Capital desk"}
				description={
					book === "paper"
						? "Simulation only. Every write is isolated from the live book."
						: "Live recommendations, investors, payouts and reconciliation."
				}
				actions={
					<Button variant="outline" onClick={() => void load()} disabled={busy}>
						<RefreshCw className="size-4" /> Refresh
					</Button>
				}
			/>

			{book === "paper" ? (
				<div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
					SIMULATION — no real funds. Paper rows never appear on the public
					page. Alerts for the paper book are not duplicated to Discord; inspect
					the transactions below.
				</div>
			) : null}

			{error ? <ErrorBanner message={error} /> : null}

			{summary ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					<StatCard
						label="AUM"
						value={compactMoney(summary.aum)}
						help="Assets Under Management: the total market value the fund manages — cash plus stock positions at current prices. AUM divided by units outstanding gives NAV per unit."
					/>
					<StatCard
						label="NAV / unit"
						value={money(summary.navPerUnit)}
						help="Net Asset Value: total fund assets divided by units outstanding. Deposits buy units at this price."
					/>
					<StatCard
						label="Cash"
						value={compactMoney(summary.cash)}
						hint={`${investors.length} investors`}
					/>
				</div>
			) : null}

			<div className="mt-4">
				<SectionCard
					title="NAV per unit"
					description="Net Asset Value per unit — total assets divided by units outstanding — recorded by the accounting worker."
				>
					<PerformanceChart points={data?.performance ?? []} />
				</SectionCard>
			</div>

			<div className="mt-4">
				<SectionCard
					title={book === "paper" ? "Create paper investor" : "Create investor"}
					description={
						book === "paper"
							? "Paper investors are test-only and do not require a Torn ID. Cadence and profit handling are investor settings; every later deposit inherits them."
							: "Live investors require a Torn ID. Test investors can only be created on the paper desk. Cadence and profit handling are investor settings; every later deposit inherits them."
					}
				>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						<div className="space-y-1">
							<Label className="text-xs text-muted-foreground">
								Display name
							</Label>
							<Input
								placeholder="Display name"
								value={investorName}
								onChange={(event) => setInvestorName(event.target.value)}
							/>
						</div>
						<div className="space-y-1">
							<Label className="text-xs text-muted-foreground">
								{book === "paper" ? "Torn ID (optional)" : "Torn ID (required)"}
							</Label>
							<NumberInput
								placeholder="e.g. 1,934,909"
								value={investorTornId}
								onValueChange={setInvestorTornId}
							/>
						</div>
						<div className="space-y-1">
							<Label className="text-xs text-muted-foreground">Kind</Label>
							{book === "paper" ? (
								<div className="flex h-9 items-center">
									<StatusBadge tone="warning">Test investor</StatusBadge>
								</div>
							) : (
								<Select value={investorKind} onValueChange={setInvestorKind}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="user">User</SelectItem>
										<SelectItem value="faction">Faction</SelectItem>
									</SelectContent>
								</Select>
							)}
						</div>
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
							<div className="space-y-1">
								<Label className="text-xs text-muted-foreground">Cadence</Label>
								<Select
									value={investorFrequency}
									onValueChange={(value) =>
										setInvestorFrequency(value as CapitalPayoutFrequency)
									}
								>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{FREQUENCIES.map((frequency) => (
											<SelectItem key={frequency.value} value={frequency.value}>
												{frequency.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<Label className="text-xs text-muted-foreground">Profit</Label>
								<Select
									value={investorPayoutMode}
									onValueChange={(value) =>
										setInvestorPayoutMode(value as PayoutMode)
									}
								>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{PAYOUT_MODES.map((mode) => (
											<SelectItem key={mode.value} value={mode.value}>
												{mode.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					</div>
					<Button
						className="mt-2"
						onClick={createInvestor}
						disabled={
							busy ||
							!investorName.trim() ||
							(book === "live" && Number(investorTornId) <= 0)
						}
					>
						<Save className="size-4" /> Create
					</Button>
				</SectionCard>
			</div>

			<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
				<SectionCard
					title="Record a deposit"
					description="Only the amount is entered here. Cadence and profit handling come from the investor's settings below."
				>
					<div className="space-y-2">
						<Select
							value={depositInvestor || undefined}
							onValueChange={setDepositInvestor}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder="Select investor…" />
							</SelectTrigger>
							<SelectContent>
								{investors.map((row) => (
									<SelectItem key={row.investor.id} value={row.investor.id}>
										{row.investor.displayName} · {compactMoney(row.principal)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<NumberInput
							decimals={2}
							placeholder="Amount"
							value={depositAmount}
							onValueChange={setDepositAmount}
						/>
						<Button
							onClick={createDeposit}
							disabled={busy || !depositInvestor || !depositAmount}
						>
							Record deposit
						</Button>
					</div>
				</SectionCard>

				<SectionCard
					title="Payouts"
					description="Mark a payout paid after the in-game transfer."
				>
					{data?.payoutsDue.length ? (
						<div className="space-y-2">
							{data.payoutsDue.map((payout) => (
								<div
									key={payout.id}
									className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 p-2 text-sm"
								>
									<div className="min-w-0">
										<p className="truncate font-medium">
											{payout.investorName}
										</p>
										<p className="text-xs text-muted-foreground">
											{compactMoney(payout.netAmount)} net · {payout.frequency}{" "}
											· {payout.status}
										</p>
									</div>
									<Button
										variant="outline"
										disabled={busy}
										onClick={() =>
											void runAction(() =>
												apiFetch(`/v2/capital/admin/${book}/payouts/pay`, {
													method: "POST",
													body: JSON.stringify({
														obligationId: payout.id,
													}),
												}),
											)
										}
									>
										Mark paid
									</Button>
								</div>
							))}
						</div>
					) : (
						<EmptyState title="No payouts due" />
					)}
				</SectionCard>
			</div>

			<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
				<SectionCard
					title="Withdrawals"
					description="Approve the quote, then record the payment."
				>
					{data?.withdrawalsPending.length ? (
						<div className="space-y-2">
							{data.withdrawalsPending.map((request) => (
								<div
									key={request.id}
									className="rounded-lg border border-border/60 p-2 text-sm"
								>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<span className="font-medium">{request.investorName}</span>
										<StatusBadge tone="warning">{request.status}</StatusBadge>
									</div>
									<p className="mt-1 text-xs text-muted-foreground">
										Gross {compactMoney(request.grossValue)} · fee{" "}
										{compactMoney(request.performanceFee)} · exit{" "}
										{compactMoney(request.exitFee)} · net{" "}
										{compactMoney(request.netAmount)}
										{Number(request.lossAmount) > 0
											? ` · loss ${compactMoney(request.lossAmount)}`
											: ""}
									</p>
									{request.liquidityWarning ? (
										<p className="text-xs text-warning">
											{request.liquidityWarning}
										</p>
									) : null}
									<div className="mt-2 flex flex-wrap gap-2">
										<Button
											variant="outline"
											disabled={busy || request.status === "approved"}
											onClick={() =>
												void runAction(() =>
													apiFetch(
														`/v2/capital/admin/${book}/withdrawals/${request.id}/approve`,
														{ method: "POST", body: "{}" },
													),
												)
											}
										>
											Approve
										</Button>
										<Button
											disabled={busy}
											onClick={() =>
												void runAction(() =>
													apiFetch(
														`/v2/capital/admin/${book}/withdrawals/${request.id}/pay`,
														{ method: "POST", body: "{}" },
													),
												)
											}
										>
											Record payment
										</Button>
									</div>
								</div>
							))}
						</div>
					) : (
						<EmptyState title="No pending withdrawals" />
					)}
				</SectionCard>

				<SectionCard title="Investors">
					{investors.length ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Investor</TableHead>
									<TableHead>Cadence</TableHead>
									<TableHead>Payout</TableHead>
									<TableHead>Principal</TableHead>
									<TableHead>Value</TableHead>
									<TableHead>Profit</TableHead>
									<TableHead>APR</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{investors.map((row) => (
									<TableRow key={row.investor.id}>
										<TableCell>
											<div className="flex items-center gap-2">
												<span className="truncate">
													{row.investor.displayName}
												</span>
												<StatusBadge tone="neutral">
													{row.investor.kind}
												</StatusBadge>
											</div>
										</TableCell>
										<TableCell>
											<Select
												value={row.investor.frequency}
												onValueChange={(value) =>
													void updateInvestorSettings(row.investor.id, {
														frequency: value as CapitalPayoutFrequency,
													})
												}
												disabled={busy}
											>
												<SelectTrigger size="sm" className="w-[104px]">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{FREQUENCIES.map((frequency) => (
														<SelectItem
															key={frequency.value}
															value={frequency.value}
														>
															{frequency.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</TableCell>
										<TableCell>
											<Select
												value={row.investor.payoutMode}
												onValueChange={(value) =>
													void updateInvestorSettings(row.investor.id, {
														payoutMode: value as PayoutMode,
													})
												}
												disabled={busy}
											>
												<SelectTrigger size="sm" className="w-[116px]">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{PAYOUT_MODES.map((mode) => (
														<SelectItem key={mode.value} value={mode.value}>
															{mode.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</TableCell>
										<TableCell className="font-mono text-xs">
											{compactMoney(row.principal)}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{compactMoney(row.currentValue)}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{compactMoney(row.totalProfit)}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{pct(row.aprPct)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : (
						<EmptyState title="No investors yet" />
					)}
				</SectionCard>
			</div>

			<div className="mt-4">
				<SectionCard
					title="Payment intents"
					description="Give the investor a DEP code to include in their Torn transfer; a matching 4810 log books the deposit automatically using the investor's cadence and profit setting."
				>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
						<Select
							value={intentInvestor || undefined}
							onValueChange={setIntentInvestor}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder="Investor…" />
							</SelectTrigger>
							<SelectContent>
								{investors.map((row) => (
									<SelectItem key={row.investor.id} value={row.investor.id}>
										{row.investor.displayName}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<NumberInput
							decimals={2}
							placeholder="Expected amount"
							value={intentAmount}
							onValueChange={setIntentAmount}
						/>
						<Button onClick={createIntent} disabled={busy || !intentInvestor}>
							Create deposit intent
						</Button>
					</div>
					{data?.paymentIntentsPending.length ? (
						<div className="mt-3">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Reference</TableHead>
										<TableHead>Kind</TableHead>
										<TableHead>Investor</TableHead>
										<TableHead>Expected</TableHead>
										<TableHead>Expires</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.paymentIntentsPending.map((intent) => (
										<TableRow key={intent.id}>
											<TableCell className="font-mono text-xs">
												{intent.referenceCode}
											</TableCell>
											<TableCell>{intent.kind}</TableCell>
											<TableCell className="truncate">
												{intent.investorName ?? "—"}
											</TableCell>
											<TableCell className="font-mono text-xs">
												{compactMoney(intent.expectedAmount)}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{isoDate(intent.expiresAtIso)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					) : (
						<EmptyState title="No pending payment intents" />
					)}
				</SectionCard>
			</div>

			<div className="mt-4">
				<SectionCard
					title={
						book === "paper" ? "Paper transactions" : "Recent transactions"
					}
					description={
						book === "paper"
							? "Every simulated fill recorded by the paper engine and reset history."
							: "Fills booked from Torn logs, manual entries and owner decisions."
					}
				>
					{data?.recentFills.length ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Date</TableHead>
									<TableHead>Stock</TableHead>
									<TableHead>Side</TableHead>
									<TableHead>Shares</TableHead>
									<TableHead>Price</TableHead>
									<TableHead>Value</TableHead>
									<TableHead>Source</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.recentFills.map((fill) => (
									<TableRow key={fill.id}>
										<TableCell className="text-xs text-muted-foreground">
											{isoDate(fill.occurredAtIso)}
										</TableCell>
										<TableCell className="truncate">{fill.stockName}</TableCell>
										<TableCell>
											<StatusBadge
												tone={fill.side === "buy" ? "success" : "danger"}
											>
												{fill.side}
											</StatusBadge>
										</TableCell>
										<TableCell className="font-mono text-xs">
											{fill.shares.toLocaleString()}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{money(fill.price)}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{compactMoney(fill.notional)}
										</TableCell>
										<TableCell className="text-xs text-muted-foreground">
											{fill.source}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : (
						<EmptyState
							title="No transactions yet"
							description={
								book === "paper"
									? "Paper fills appear here when the engine auto-fills a recommendation."
									: "Fills appear here once Torn logs are ingested or a trade is recorded manually."
							}
						/>
					)}
				</SectionCard>
			</div>

			{settingsDraft && book === "live" ? (
				<div className="mt-4">
					<SectionCard
						title="Settings"
						description="Fee, risk, public visibility and engine switches. Alerts are always sent to your Discord DMs."
						actions={
							<Button
								variant="outline"
								disabled={busy}
								onClick={() =>
									void runAction(() =>
										apiFetch(`/v2/capital/admin/${book}/settings`, {
											method: "PUT",
											body: JSON.stringify({
												publicShowAum: settingsDraft.publicShowAum,
												publicShowTrades: settingsDraft.publicShowTrades,
												publicShowHoldings: settingsDraft.publicShowHoldings,
												publicShowFees: settingsDraft.publicShowFees,
												feeRateDailyBps: settingsDraft.feeRateDailyBps,
												feeRateWeeklyBps: settingsDraft.feeRateWeeklyBps,
												feeRateMonthlyBps: settingsDraft.feeRateMonthlyBps,
												minCashReservePct: settingsDraft.minCashReservePct,
												maxStockWeightPct: settingsDraft.maxStockWeightPct,
												maxPositions: settingsDraft.maxPositions,
												riskPerTradePct: settingsDraft.riskPerTradePct,
												withdrawalExitFeeBps:
													settingsDraft.withdrawalExitFeeBps,
												engineEnabled: settingsDraft.engineEnabled,
												liveEnabled: settingsDraft.liveEnabled,
											}),
										}),
									)
								}
							>
								<Save className="size-4" /> Save settings
							</Button>
						}
					>
						<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
							<div className="space-y-2">
								<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Fees (basis points of distributed profit)
								</p>
								<div className="grid grid-cols-3 gap-2">
									<SettingsNumber
										label="Daily"
										value={settingsDraft.feeRateDailyBps}
										onChange={(value) =>
											patchSettings({ feeRateDailyBps: value })
										}
									/>
									<SettingsNumber
										label="Weekly"
										value={settingsDraft.feeRateWeeklyBps}
										onChange={(value) =>
											patchSettings({ feeRateWeeklyBps: value })
										}
									/>
									<SettingsNumber
										label="Monthly"
										value={settingsDraft.feeRateMonthlyBps}
										onChange={(value) =>
											patchSettings({ feeRateMonthlyBps: value })
										}
									/>
								</div>
								<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Risk
								</p>
								<div className="grid grid-cols-2 gap-2">
									<SettingsNumber
										label="Risk / trade %"
										value={settingsDraft.riskPerTradePct}
										decimals={2}
										onChange={(value) =>
											patchSettings({ riskPerTradePct: value })
										}
									/>
									<SettingsNumber
										label="Max stock weight %"
										value={settingsDraft.maxStockWeightPct}
										decimals={2}
										onChange={(value) =>
											patchSettings({ maxStockWeightPct: value })
										}
									/>
									<SettingsNumber
										label="Max positions"
										value={settingsDraft.maxPositions}
										onChange={(value) => patchSettings({ maxPositions: value })}
									/>
									<SettingsNumber
										label="Cash reserve %"
										value={settingsDraft.minCashReservePct}
										decimals={2}
										onChange={(value) =>
											patchSettings({ minCashReservePct: value })
										}
									/>
								</div>
							</div>
							<div className="space-y-2">
								<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Public visibility
								</p>
								<div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
									<CheckboxField
										label="AUM"
										checked={settingsDraft.publicShowAum}
										onCheckedChange={(checked) =>
											patchSettings({ publicShowAum: checked })
										}
									/>
									<CheckboxField
										label="Trades"
										checked={settingsDraft.publicShowTrades}
										onCheckedChange={(checked) =>
											patchSettings({ publicShowTrades: checked })
										}
									/>
									<CheckboxField
										label="Holdings"
										checked={settingsDraft.publicShowHoldings}
										onCheckedChange={(checked) =>
											patchSettings({ publicShowHoldings: checked })
										}
									/>
									<CheckboxField
										label="Fees"
										checked={settingsDraft.publicShowFees}
										onCheckedChange={(checked) =>
											patchSettings({ publicShowFees: checked })
										}
									/>
								</div>
								<p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Engine
									<HelpTip>
										“Live recommendations enabled” makes the engine score and
										create recommendations for the live book. It never places
										orders automatically — fills are still booked from your Torn
										logs or recorded manually.
									</HelpTip>
								</p>
								<div className="flex flex-wrap gap-3 pt-1">
									<CheckboxField
										label="Engine enabled"
										checked={settingsDraft.engineEnabled}
										onCheckedChange={(checked) =>
											patchSettings({ engineEnabled: checked })
										}
									/>
									<CheckboxField
										label="Live recommendations enabled"
										checked={settingsDraft.liveEnabled}
										onCheckedChange={(checked) =>
											patchSettings({ liveEnabled: checked })
										}
									/>
								</div>
								<p className="text-xs text-muted-foreground">
									All alerts go to your Discord DMs. There are no channel
									settings; paper actions stay on the paper desk so live and
									paper never double-notify.
								</p>
							</div>
						</div>
					</SectionCard>
				</div>
			) : null}
		</PageShell>
	);
}

function SettingsNumber({
	label,
	value,
	decimals = 0,
	onChange,
}: {
	label: string;
	value: number;
	decimals?: number;
	onChange: (value: number) => void;
}) {
	return (
		<div className="space-y-1">
			<Label className="text-xs text-muted-foreground">{label}</Label>
			<NumberInput
				decimals={decimals}
				value={String(value)}
				onValueChange={(next) => onChange(Number(next || 0))}
			/>
		</div>
	);
}
