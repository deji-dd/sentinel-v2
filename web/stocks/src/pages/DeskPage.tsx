import type {
	CapitalAdminOverview,
	CapitalPayoutFrequency,
	CapitalSettings,
} from "@sentinel/schemas";
import { Save, Trash2 } from "lucide-react";
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
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
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
import { useCapitalLive } from "../lib/live";

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

export function DeskPage({ book: initialBook = "live" }: { book?: Book }) {
	const [book, setBook] = useState<Book>(initialBook);
	const isPaper = book === "paper";

	return (
		<PageShell>
			<PageHeader
				title="Desk"
				description={
					isPaper
						? "Simulation only. Every write is isolated from the live book."
						: "Live recommendations, investors, payouts and reconciliation."
				}
			/>
			<Tabs value={book} onValueChange={(value) => setBook(value as Book)}>
				<TabsList className="mb-4">
					<TabsTrigger value="live">Live</TabsTrigger>
					<TabsTrigger value="paper">Simulation</TabsTrigger>
				</TabsList>
				<TabsContent value="live">
					<DeskBook book="live" />
				</TabsContent>
				<TabsContent value="paper">
					<DeskBook book="paper" />
				</TabsContent>
			</Tabs>
		</PageShell>
	);
}

function DeskBook({ book }: { book: Book }) {
	const isPaper = book === "paper";
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

	const { markUpdated } = useCapitalLive<CapitalAdminOverview>({
		view: "admin",
		book,
		enabled: authenticated && !authLoading,
		onSnapshot: (overview) => {
			setData(overview);
			setSettingsDraft((current) => current ?? overview.settings);
			setLoading(false);
		},
	});

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
			markUpdated();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load the desk.");
		} finally {
			setLoading(false);
		}
	}, [book, markUpdated]);

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
			<div className="space-y-4">
				<EmptyState
					title="Sign-in required"
					description="Owner-only control surface."
				/>
				<div className="flex justify-center">
					<Button
						onClick={() =>
							loginWithDiscord(`/desk${book === "paper" ? "/paper" : ""}`)
						}
					>
						Sign in with Discord
					</Button>
				</div>
			</div>
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
		setDepositInvestor("");
		setDepositAmount("");
	};

	const saveSettings = async () => {
		if (!settingsDraft) return;
		await runAction(() =>
			apiFetch(`/v2/capital/admin/${book}/settings`, {
				method: "PUT",
				body: JSON.stringify({
					feeRateDailyBps: settingsDraft.feeRateDailyBps,
					feeRateWeeklyBps: settingsDraft.feeRateWeeklyBps,
					feeRateMonthlyBps: settingsDraft.feeRateMonthlyBps,
					withdrawalExitFeeBps: settingsDraft.withdrawalExitFeeBps,
					engineEnabled: settingsDraft.engineEnabled,
					liveEnabled: settingsDraft.liveEnabled,
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

	// Recent trades: combine recent fills and open order actions for a unified view
	const recentTrades = data?.recentFills ?? [];

	return (
		<>
			{book === "paper" ? (
				<div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
					<span>
						SIMULATION — no real funds. Results are public on the Simulation
						tab; trade and risk alerts are sent to your DMs labelled TEST.
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
				<div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
				</div>
			) : null}

			<div className="mt-4">
				<SectionCard
					title={
						book === "paper" ? "Create simulation investor" : "Create investor"
					}
					description={
						book === "paper"
							? "Simulation investors are test-only and do not require a Torn ID. Cadence and profit handling are investor settings; every later deposit inherits them."
							: "Live investors require a Torn ID. Test investors can only be created on the Simulation tab. Cadence and profit handling are investor settings; every later deposit inherits them."
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

			<div className="mt-4">
				<SectionCard title="Investors">
					{investors.length ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Investor</TableHead>
									<TableHead>Amount invested</TableHead>
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
										<TableCell className="font-mono text-xs">
											{compactMoney(row.principal)}
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
												<SelectTrigger size="sm" className="w-26">
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
												<SelectTrigger size="sm" className="w-29">
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
					description="Pending recommendations. Accepting is advisory for live; simulation auto-fills. Orders expire after the configured validity window."
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
					title="Recent trades"
					description={isPaper ? "Simulated fills." : "Confirmed live fills."}
				>
					{recentTrades.length ? (
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
								{recentTrades.map((trade) => (
									<TableRow key={trade.id}>
										<TableCell>{trade.stockName}</TableCell>
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
												{isoDate(trade.occurredAtIso)}
											</span>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : (
						<EmptyState title="No trades yet" />
					)}
				</SectionCard>
			</div>

			{book === "paper" ? (
				<div className="mt-4">
					<SectionCard
						title="Reset simulation"
						description="Deletes all simulation data — investors, lots, positions, orders, fills, payouts, snapshots. The live book is never touched. Nothing is seeded afterwards; add investors and deposits yourself."
						actions={
							<Button
								variant="destructive"
								disabled={busy}
								onClick={() => setResetOpen(true)}
							>
								<Trash2 className="size-4" /> Reset simulation
							</Button>
						}
					>
						<p className="text-xs text-muted-foreground">
							Current: {money(data?.summary.cash ?? "0")} cash,{" "}
							{data?.positions.length ?? 0} positions,{" "}
							{data?.investors.length ?? 0} investors. Cannot be undone.
						</p>
					</SectionCard>
				</div>
			) : null}

			<Dialog open={resetOpen} onOpenChange={setResetOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Reset the simulation?</DialogTitle>
						<DialogDescription>
							This permanently deletes all simulation investors, lots,
							positions, orders, fills and NAV history. No operator or starting
							cash is created; the simulation book starts empty. Type{" "}
							<strong>RESET</strong> to continue.
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
							{busy ? "Resetting…" : "Reset simulation"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{settingsDraft && book === "live" ? (
				<div className="mt-4">
					<SectionCard
						title="Settings"
						description="Fees and engine switches. Alerts are always sent to your Discord DMs."
						actions={
							<Button
								variant="outline"
								disabled={busy}
								onClick={() => void saveSettings()}
							>
								<Save className="size-4" /> Save settings
							</Button>
						}
					>
						<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
							<div className="space-y-2">
								<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Fees (% of distributed profit)
								</p>
								<div className="grid grid-cols-3 gap-2">
									<SettingsNumber
										label="Daily"
										value={settingsDraft.feeRateDailyBps / 100}
										decimals={2}
										onChange={(value) =>
											patchSettings({
												feeRateDailyBps: Math.round(value * 100),
											})
										}
									/>
									<SettingsNumber
										label="Weekly"
										value={settingsDraft.feeRateWeeklyBps / 100}
										decimals={2}
										onChange={(value) =>
											patchSettings({
												feeRateWeeklyBps: Math.round(value * 100),
											})
										}
									/>
									<SettingsNumber
										label="Monthly"
										value={settingsDraft.feeRateMonthlyBps / 100}
										decimals={2}
										onChange={(value) =>
											patchSettings({
												feeRateMonthlyBps: Math.round(value * 100),
											})
										}
									/>
								</div>
								<p className="text-xs text-muted-foreground">
									Withdrawal exit fee:{" "}
									{pct(settingsDraft.withdrawalExitFeeBps / 100, 2)} (fixed)
								</p>
							</div>
							<div className="space-y-2">
								<p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Engine
									<HelpTip>
										"Live recommendations enabled" makes the engine score and
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
									settings; simulation actions stay on the Simulation tab so
									simulation never double-notify.
								</p>
							</div>
						</div>
					</SectionCard>
				</div>
			) : null}
		</>
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
