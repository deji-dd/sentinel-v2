import type {
	CapitalAdminOverview,
	CapitalPayoutFrequency,
	CapitalSettings,
} from "@sentinel/schemas";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../components/ui/dialog";
import { useAuth } from "../contexts/AuthContext";
import {
	apiFetch,
	compactMoney,
	exitReasonLabel,
	isoDate,
	money,
	pct,
} from "../lib/api";

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
	const [resetOpen, setResetOpen] = useState(false);
	const [resetConfirm, setResetConfirm] = useState("");

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
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : "Action failed.");
			return false;
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

	const resetPaper = async () => {
		const ok = await runAction(() =>
			apiFetch("/v2/capital/admin/paper/reset", {
				method: "POST",
				body: "{}",
			}),
		);
		if (!ok) return;
		setResetOpen(false);
		setResetConfirm("");
		// The old ids are gone; clear the pickers so a stale selection cannot
		// post a deposit against a deleted investor.
		setDepositInvestor("");
		setIntentInvestor("");
		setDepositAmount("");
		setIntentAmount("");
	};

	const saveRisk = async () => {
		if (!settingsDraft) return;
		await runAction(() =>
			apiFetch(`/v2/capital/admin/${book}/settings`, {
				method: "PUT",
				body: JSON.stringify({
					drawdownHaltPct: settingsDraft.drawdownHaltPct,
					drawdownDeriskPct: settingsDraft.drawdownDeriskPct,
					dailyLossHaltPct: settingsDraft.dailyLossHaltPct,
					stopCooldownDays: settingsDraft.stopCooldownDays,
					staleDataSeconds: settingsDraft.staleDataSeconds,
					regimeSmaDays: settingsDraft.regimeSmaDays,
				}),
			}),
		);
	};

	const openOrders =
		data?.orders.filter(
			(order) =>
				order.status === "recommended" ||
				order.status === "accepted" ||
				order.status === "partially_filled",
		) ?? [];

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
				<div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
					<span>
						SIMULATION — no real funds. Results are public on the Paper page;
						trade and risk alerts are sent to your DMs labelled TEST.
					</span>
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() =>
							void runAction(() =>
								apiFetch("/v2/capital/admin/paper/test-alert", {
									method: "POST",
									body: "{}",
								}),
							)
						}
					>
						Send test alert
					</Button>
				</div>
			) : null}

			{error ? <ErrorBanner message={error} /> : null}

			{data?.summary ? (
				<div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<StatCard
						label="Available cash"
						value={money(data.summary.cash)}
						hint="Liquid and ready to deploy"
						tone="info"
						help="Cash in the book. The engine keeps a reserve of 15% of NAV plus any unpaid payouts; the rest can fund new positions."
					/>
					<StatCard
						label="Capital deployed"
						value={money(data.summary.positionsValue)}
						hint={
							Number(data.summary.aum) > 0
								? `${pct((Number(data.summary.positionsValue) / Number(data.summary.aum)) * 100, 1)} of NAV at market`
								: "No capital deployed yet"
						}
						help="Market value of the open stock positions at the last price. AUM is this plus available cash."
					/>
					<StatCard
						label="Portfolio value"
						value={money(data.summary.aum)}
						hint="Cash + positions at market"
					/>
					<StatCard
						label="Open positions"
						value={String(data.positions.length)}
						hint={`${data.settings.maxPositions} slots, 12% max each`}
					/>
				</div>
			) : null}

			{data?.engine.risk &&
			(data.engine.risk.entriesPaused ||
				data.engine.risk.sizeScale < 1 ||
				data.engine.risk.cooldownStockCount > 0) ? (
				<div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
					{data.engine.risk.entriesPaused
						? `New entries paused: ${data.engine.risk.pauseReasons.join("; ")}. Exits and stops still run.`
						: data.engine.risk.sizeScale < 1
							? `Drawdown ${pct(data.engine.risk.drawdownPct)} — new entries are sized at ${pct(data.engine.risk.sizeScale * 100, 0)}.`
							: `${data.engine.risk.cooldownStockCount} stock(s) in post-stop cooldown.`}
				</div>
			) : null}

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
								group={false}
								placeholder="e.g. 1934909"
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
					title="Open positions"
					description="Frozen entry stop and target from the entry order, plus the since-entry high-water mark. The engine never recomputes the stop."
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
									<TableHead>Unrealized</TableHead>
									<TableHead>Weight</TableHead>
									<TableHead>Stop</TableHead>
									<TableHead>Target</TableHead>
									<TableHead>Peak</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.positions.map((position) => (
									<TableRow key={position.stockId}>
										<TableCell className="truncate">
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
										<TableCell className="font-mono text-xs">
											{pct(position.weightPct, 1)}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{position.stopPrice ? money(position.stopPrice) : "—"}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{position.targetPrice ? money(position.targetPrice) : "—"}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{position.peakPrice ? money(position.peakPrice) : "—"}
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

			<div className="mt-4">
				<SectionCard
					title="Open orders"
					description="Pending recommendations. Accepting is advisory for live; paper auto-fills. Orders expire after the configured validity window."
				>
					{openOrders.length ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Generated</TableHead>
									<TableHead>Stock</TableHead>
									<TableHead>Side</TableHead>
									<TableHead>Shares</TableHead>
									<TableHead>Price</TableHead>
									<TableHead>Stop</TableHead>
									<TableHead>Target</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Expires</TableHead>
									<TableHead>Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{openOrders.map((order) => (
									<TableRow key={order.id}>
										<TableCell className="text-xs text-muted-foreground">
											{isoDate(order.generatedAtIso)}
										</TableCell>
										<TableCell className="truncate">
											{order.acronym} {order.stockName}
										</TableCell>
										<TableCell>
											<StatusBadge
												tone={order.side === "buy" ? "success" : "danger"}
											>
												{order.side}
											</StatusBadge>
										</TableCell>
										<TableCell className="font-mono text-xs">
											{order.recommendedShares.toLocaleString()}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{money(order.priceGuide)}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{order.stopPrice ? money(order.stopPrice) : "—"}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{order.targetPrice ? money(order.targetPrice) : "—"}
										</TableCell>
										<TableCell className="text-xs">{order.status}</TableCell>
										<TableCell className="text-xs text-muted-foreground">
											{isoDate(order.expiresAtIso)}
										</TableCell>
										<TableCell>
											<div className="flex gap-1">
												<Button
													size="xs"
													variant="outline"
													disabled={busy}
													onClick={() =>
														void runAction(() =>
															apiFetch(
																`/v2/capital/admin/${book}/orders/${order.id}/accept`,
																{ method: "POST", body: "{}" },
															),
														)
													}
												>
													Accept
												</Button>
												<Button
													size="xs"
													variant="ghost"
													disabled={busy}
													onClick={() =>
														void runAction(() =>
															apiFetch(
																`/v2/capital/admin/${book}/orders/${order.id}/cancel`,
																{ method: "POST", body: "{}" },
															),
														)
													}
												>
													Cancel
												</Button>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : (
						<EmptyState title="No open orders" />
					)}
				</SectionCard>
			</div>

			<div className="mt-4">
				<SectionCard
					title="Recent fills"
					description="Every fill with its exit reason. Paper fills are simulated; live fills are booked from Torn logs."
				>
					{data?.recentFills.length ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>When</TableHead>
									<TableHead>Stock</TableHead>
									<TableHead>Side</TableHead>
									<TableHead>Shares</TableHead>
									<TableHead>Price</TableHead>
									<TableHead>Value</TableHead>
									<TableHead>Reason</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.recentFills.map((fill) => (
									<TableRow key={fill.id}>
										<TableCell className="text-xs text-muted-foreground">
											{isoDate(fill.occurredAtIso)}
										</TableCell>
										<TableCell className="truncate">
											<span className="font-mono text-xs text-muted-foreground">
												{fill.stockId}
											</span>{" "}
											{fill.stockName}
										</TableCell>
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
										<TableCell className="text-xs">
											{fill.side === "sell"
												? exitReasonLabel(fill.exitReason)
												: "—"}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : (
						<EmptyState title="No fills yet" />
					)}
				</SectionCard>
			</div>

			{book === "paper" ? (
				<div className="mt-4">
					<SectionCard
						title="Reset simulation"
						description="Deletes every paper investor, lot, position, order, fill, payout and snapshot. Nothing is seeded afterwards: add investors and deposits yourself. The live book is never touched."
						actions={
							<Button
								variant="destructive"
								disabled={busy}
								onClick={() => setResetOpen(true)}
							>
								<Trash2 className="size-4" /> Reset paper book
							</Button>
						}
					>
						<p className="text-xs text-muted-foreground">
							Current book: {money(data?.summary.cash ?? "0")} cash,{" "}
							{data?.positions.length ?? 0} open positions,{" "}
							{data?.investors.length ?? 0} investors. A reset cannot be undone.
						</p>
					</SectionCard>
				</div>
			) : null}

			<Dialog open={resetOpen} onOpenChange={setResetOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Reset the paper simulation?</DialogTitle>
						<DialogDescription>
							This permanently deletes all paper investors, lots, positions,
							orders, fills and NAV history. No operator or starting cash is
							created; the paper book starts empty. Type <strong>RESET</strong>{" "}
							to continue.
						</DialogDescription>
					</DialogHeader>
					<Input
						placeholder="RESET"
						value={resetConfirm}
						onChange={(event) => setResetConfirm(event.target.value)}
					/>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setResetOpen(false)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							disabled={busy || resetConfirm !== "RESET"}
							onClick={() => void resetPaper()}
						>
							{busy ? "Resetting…" : "Reset paper book"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{settingsDraft ? (
				<div className="mt-4">
					<SectionCard
						title="Risk overlay"
						description="Enforced by the engine every cycle. De-risk halves new entry size; halt pauses new entries. Exits and stops always run."
						actions={
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => void saveRisk()}
							>
								<Save className="size-4" /> Save risk
							</Button>
						}
					>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
							<SettingsNumber
								label="Drawdown halt %"
								value={settingsDraft.drawdownHaltPct}
								decimals={1}
								onChange={(value) => patchSettings({ drawdownHaltPct: value })}
							/>
							<SettingsNumber
								label="Drawdown de-risk %"
								value={settingsDraft.drawdownDeriskPct}
								decimals={1}
								onChange={(value) =>
									patchSettings({ drawdownDeriskPct: value })
								}
							/>
							<SettingsNumber
								label="Daily loss halt %"
								value={settingsDraft.dailyLossHaltPct}
								decimals={1}
								onChange={(value) => patchSettings({ dailyLossHaltPct: value })}
							/>
							<SettingsNumber
								label="Stop cooldown days"
								value={settingsDraft.stopCooldownDays}
								onChange={(value) => patchSettings({ stopCooldownDays: value })}
							/>
							<SettingsNumber
								label="Stale data seconds"
								value={settingsDraft.staleDataSeconds}
								onChange={(value) => patchSettings({ staleDataSeconds: value })}
							/>
							<SettingsNumber
								label="Regime SMA days"
								value={settingsDraft.regimeSmaDays}
								onChange={(value) => patchSettings({ regimeSmaDays: value })}
							/>
						</div>
						<p className="mt-2 text-xs text-muted-foreground">
							Drawdown and daily loss use NAV per unit, so deposits and
							withdrawals do not look like performance. A stopped-out name is
							blocked for the cooldown window. Stale data pauses entries but
							never exits.
						</p>
					</SectionCard>
				</div>
			) : null}

			{settingsDraft && book === "live" ? (
				<div className="mt-4">
					<SectionCard
						title="Settings"
						description="Fee, public visibility and engine switches. Position sizing is fixed policy and shown read-only. Alerts are always sent to your Discord DMs."
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
									Position sizing (fixed policy)
								</p>
								<div className="rounded-lg border border-border/60 p-2 text-xs text-muted-foreground">
									<p>
										{settingsDraft.maxPositions} slots ·{" "}
										{settingsDraft.maxStockWeightPct}% max per name ·{" "}
										{settingsDraft.riskPerTradePct}% risk per trade ·{" "}
										{settingsDraft.minCashReservePct}% cash reserve.
									</p>
									<p className="mt-1">
										These are code-level invariants so the slot count and
										per-name weight cannot drift out of sync with the equity
										cap. Change them in <code>capital-policy.ts</code>.
									</p>
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
