import type {
	CapitalAdminOverview,
	CapitalSmokeReport,
} from "@sentinel/schemas";
import { FlaskConical, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PerformanceChart } from "../components/PerformanceChart";
import {
	Button,
	Checkbox,
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
import { apiFetch, compactMoney, isoDate, money, pct } from "../lib/api";

type Book = "live" | "paper";

export function DeskPage({ book }: { book: Book }) {
	const { authenticated, loading: authLoading, loginWithDiscord } = useAuth();
	const [data, setData] = useState<CapitalAdminOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [smoke, setSmoke] = useState<CapitalSmokeReport | null>(null);
	const [settingsDraft, setSettingsDraft] = useState<CapitalSettings | null>(
		null,
	);

	const [investorName, setInvestorName] = useState("");
	const [investorTornId, setInvestorTornId] = useState("");
	const [investorKind, setInvestorKind] = useState("user");
	const [depositInvestor, setDepositInvestor] = useState("");
	const [depositAmount, setDepositAmount] = useState("");
	const [depositFrequency, setDepositFrequency] = useState("weekly");
	const [depositPayoutMode, setDepositPayoutMode] = useState("cash");
	const [startingCash, setStartingCash] = useState("150000000000");
	const [intentInvestor, setIntentInvestor] = useState("");
	const [intentAmount, setIntentAmount] = useState("");
	const [intentFrequency, setIntentFrequency] = useState("weekly");
	const [intentPayoutMode, setIntentPayoutMode] = useState("cash");

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
		if (!investorName.trim()) return;
		await runAction(() =>
			apiFetch(`/v2/capital/admin/${book}/investors`, {
				method: "POST",
				body: JSON.stringify({
					kind: investorKind,
					displayName: investorName.trim(),
					tornId: investorTornId ? Number(investorTornId) : undefined,
				}),
			}),
		);
		setInvestorName("");
		setInvestorTornId("");
	};

	const createDeposit = async () => {
		if (!depositInvestor || !depositAmount) return;
		await runAction(() =>
			apiFetch(
				`/v2/capital/admin/${book}/investors/${depositInvestor}/deposits`,
				{
					method: "POST",
					body: JSON.stringify({
						amount: depositAmount,
						frequency: depositFrequency,
						payoutMode: depositPayoutMode,
					}),
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
					frequency: intentFrequency,
					payoutMode: intentPayoutMode,
					expectedAmount: intentAmount,
					counterpartyTornId: investor.tornId ?? undefined,
				}),
			}),
		);
		setIntentAmount("");
	};

	const resetPaper = async () => {
		await runAction(() =>
			apiFetch("/v2/capital/admin/paper/reset", {
				method: "POST",
				body: JSON.stringify({ startingCash }),
			}),
		);
	};

	const runSmoke = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await apiFetch<{
				success: boolean;
				report: CapitalSmokeReport;
			}>("/v2/capital/admin/paper/smoke-test", {
				method: "POST",
				body: JSON.stringify({ startingCash }),
			});
			setSmoke(result.report);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Smoke test failed.");
		} finally {
			setBusy(false);
		}
	};

	const summary = data?.summary;
	const engine = data?.engine;

	return (
		<PageShell>
			<PageHeader
				title={book === "paper" ? "Paper desk" : "Capital desk"}
				description={
					book === "paper"
						? "Simulation only. Every write is isolated from the live book."
						: "Live recommendations, investors, payouts and reconciliation."
				}
				badge={
					<StatusBadge tone={book === "paper" ? "warning" : "success"}>
						{book === "paper" ? "SIMULATION" : "LIVE"}
					</StatusBadge>
				}
				actions={
					<Button
						variant="secondary"
						onClick={() => void load()}
						disabled={busy}
					>
						<RefreshCw className="size-4" /> Refresh
					</Button>
				}
			/>

			{book === "paper" ? (
				<div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
					SIMULATION — no real funds. Paper rows never appear on the public
					page.
				</div>
			) : null}

			{error ? <ErrorBanner message={error} /> : null}

			{summary ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<StatCard label="AUM" value={compactMoney(summary.aum)} />
					<StatCard label="NAV / unit" value={money(summary.navPerUnit)} />
					<StatCard
						label="Cash"
						value={compactMoney(summary.cash)}
						hint={`${data?.investors.length ?? 0} investors`}
					/>
					<StatCard
						label="Open issues"
						value={String(data?.notifications.openIssues ?? 0)}
						tone={
							(data?.notifications.openIssues ?? 0) > 0 ? "warning" : "default"
						}
					/>
				</div>
			) : null}

			<div className="mt-4">
				<SectionCard
					title="NAV per unit"
					description="Daily snapshots recorded by the accounting worker."
				>
					<PerformanceChart points={data?.performance ?? []} />
				</SectionCard>
			</div>

			<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
				<SectionCard
					title="Engine"
					description="The 60-second price/signal cycle."
					actions={
						<StatusBadge tone={engine?.enabled ? "success" : "neutral"}>
							{engine?.enabled ? "enabled" : "paused"}
						</StatusBadge>
					}
				>
					<div className="grid grid-cols-2 gap-2 text-sm">
						<div>
							<p className="text-xs text-muted-foreground">Status</p>
							<p>{engine?.status ?? "—"}</p>
						</div>
						<div>
							<p className="text-xs text-muted-foreground">Last run</p>
							<p className="text-xs">{isoDate(engine?.lastRunAtIso)}</p>
						</div>
						<div>
							<p className="text-xs text-muted-foreground">Data age</p>
							<p className="font-mono text-xs">
								{engine?.dataAgeSeconds !== null &&
								engine?.dataAgeSeconds !== undefined
									? `${engine.dataAgeSeconds}s`
									: "—"}
							</p>
						</div>
						<div>
							<p className="text-xs text-muted-foreground">Scored / orders</p>
							<p className="font-mono text-xs">
								{engine?.stocksScored ?? 0} / {engine?.recommendations ?? 0}
							</p>
						</div>
					</div>
					{engine?.lastError ? (
						<p className="mt-2 text-xs text-destructive">{engine.lastError}</p>
					) : null}
				</SectionCard>

				<SectionCard
					title="Create investor"
					description="Users and factions. Contacts are added separately via the API."
				>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
						<Input
							placeholder="Display name"
							value={investorName}
							onChange={(event) => setInvestorName(event.target.value)}
						/>
						<Input
							placeholder="Torn ID (optional)"
							inputMode="numeric"
							value={investorTornId}
							onChange={(event) => setInvestorTornId(event.target.value)}
						/>
						<Select
							value={investorKind}
							onChange={(event) => setInvestorKind(event.target.value)}
						>
							<option value="user">User</option>
							<option value="faction">Faction</option>
							<option value="test">Test</option>
						</Select>
					</div>
					<Button className="mt-2" onClick={createInvestor} disabled={busy}>
						<Save className="size-4" /> Create
					</Button>
				</SectionCard>
			</div>

			<div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
				<SectionCard
					title="Record a deposit"
					description="Every deposit creates a new lot at the current NAV."
				>
					<div className="space-y-2">
						<Select
							value={depositInvestor}
							onChange={(event) => setDepositInvestor(event.target.value)}
						>
							<option value="">Select investor…</option>
							{(data?.investors ?? []).map((row) => (
								<option key={row.investor.id} value={row.investor.id}>
									{row.investor.displayName} · {compactMoney(row.principal)}
								</option>
							))}
						</Select>
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
							<Input
								placeholder="Amount"
								inputMode="decimal"
								value={depositAmount}
								onChange={(event) => setDepositAmount(event.target.value)}
							/>
							<Select
								value={depositFrequency}
								onChange={(event) => setDepositFrequency(event.target.value)}
							>
								<option value="daily">Daily</option>
								<option value="weekly">Weekly</option>
								<option value="monthly">Monthly</option>
							</Select>
							<Select
								value={depositPayoutMode}
								onChange={(event) => setDepositPayoutMode(event.target.value)}
							>
								<option value="cash">Pay profit out</option>
								<option value="reinvest">Reinvest profit</option>
							</Select>
						</div>
						<Button onClick={createDeposit} disabled={busy || !depositInvestor}>
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
											{money(payout.netAmount)} net · {payout.frequency} ·{" "}
											{payout.status}
										</p>
									</div>
									<Button
										variant="secondary"
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
										Gross {money(request.grossValue)} · fee{" "}
										{money(request.performanceFee)} · exit{" "}
										{money(request.exitFee)} · net {money(request.netAmount)}
										{Number(request.lossAmount) > 0
											? ` · loss ${money(request.lossAmount)}`
											: ""}
									</p>
									{request.liquidityWarning ? (
										<p className="text-xs text-warning">
											{request.liquidityWarning}
										</p>
									) : null}
									<div className="mt-2 flex flex-wrap gap-2">
										<Button
											variant="secondary"
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
					{data?.investors.length ? (
						<div className="overflow-x-auto">
							<table className="w-full min-w-[560px] text-left text-sm">
								<thead className="text-xs uppercase tracking-wide text-muted-foreground">
									<tr>
										<th className="pb-2">Investor</th>
										<th className="pb-2">Principal</th>
										<th className="pb-2">Value</th>
										<th className="pb-2">Profit</th>
										<th className="pb-2">APR</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/60">
									{data.investors.map((row) => (
										<tr key={row.investor.id}>
											<td className="py-2">
												<div className="flex items-center gap-2">
													<span className="truncate">
														{row.investor.displayName}
													</span>
													<StatusBadge tone="neutral">
														{row.investor.kind}
													</StatusBadge>
												</div>
											</td>
											<td className="py-2 font-mono text-xs">
												{money(row.principal)}
											</td>
											<td className="py-2 font-mono text-xs">
												{money(row.currentValue)}
											</td>
											<td className="py-2 font-mono text-xs">
												{money(row.totalProfit)}
											</td>
											<td className="py-2 font-mono text-xs">
												{pct(row.aprPct)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<EmptyState title="No investors yet" />
					)}
				</SectionCard>
			</div>

			<div className="mt-4">
				<SectionCard
					title="Payment intents"
					description="Give the investor a DEP code to include in their Torn transfer; a matching 4810 log books the deposit automatically. Payout/withdrawal codes are created from the desk."
				>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
						<Select
							value={intentInvestor}
							onChange={(event) => setIntentInvestor(event.target.value)}
						>
							<option value="">Investor…</option>
							{(data?.investors ?? []).map((row) => (
								<option key={row.investor.id} value={row.investor.id}>
									{row.investor.displayName}
								</option>
							))}
						</Select>
						<Input
							placeholder="Expected amount"
							inputMode="decimal"
							value={intentAmount}
							onChange={(event) => setIntentAmount(event.target.value)}
						/>
						<Select
							value={intentFrequency}
							onChange={(event) => setIntentFrequency(event.target.value)}
						>
							<option value="daily">Daily</option>
							<option value="weekly">Weekly</option>
							<option value="monthly">Monthly</option>
						</Select>
						<Select
							value={intentPayoutMode}
							onChange={(event) => setIntentPayoutMode(event.target.value)}
						>
							<option value="cash">Pay profit out</option>
							<option value="reinvest">Reinvest profit</option>
						</Select>
						<Button onClick={createIntent} disabled={busy || !intentInvestor}>
							Create deposit intent
						</Button>
					</div>
					{data?.paymentIntentsPending.length ? (
						<div className="mt-3 overflow-x-auto">
							<table className="w-full min-w-[520px] text-left text-sm">
								<thead className="text-xs uppercase tracking-wide text-muted-foreground">
									<tr>
										<th className="pb-2">Reference</th>
										<th className="pb-2">Kind</th>
										<th className="pb-2">Investor</th>
										<th className="pb-2">Expected</th>
										<th className="pb-2">Expires</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/60">
									{data.paymentIntentsPending.map((intent) => (
										<tr key={intent.id}>
											<td className="py-2 font-mono text-xs">
												{intent.referenceCode}
											</td>
											<td className="py-2">{intent.kind}</td>
											<td className="py-2 truncate">
												{intent.investorName ?? "—"}
											</td>
											<td className="py-2 font-mono text-xs">
												{money(intent.expectedAmount)}
											</td>
											<td className="py-2 text-xs text-muted-foreground">
												{isoDate(intent.expiresAtIso)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<EmptyState title="No pending payment intents" />
					)}
				</SectionCard>
			</div>

			{settingsDraft ? (
				<div className="mt-4">
					<SectionCard
						title="Settings"
						description="Fee, risk, public visibility and alert routing. Saved through the same admin API the dashboard reads."
						actions={
							<Button
								variant="secondary"
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
												liveAlertChannelId: settingsDraft.liveAlertChannelId,
												paperAlertChannelId: settingsDraft.paperAlertChannelId,
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
									<label className="text-xs text-muted-foreground">
										Daily
										<Input
											className="mt-1"
											inputMode="numeric"
											value={String(settingsDraft.feeRateDailyBps)}
											onChange={(event) =>
												setSettingsDraft({
													...settingsDraft,
													feeRateDailyBps: Number(event.target.value),
												})
											}
										/>
									</label>
									<label className="text-xs text-muted-foreground">
										Weekly
										<Input
											className="mt-1"
											inputMode="numeric"
											value={String(settingsDraft.feeRateWeeklyBps)}
											onChange={(event) =>
												setSettingsDraft({
													...settingsDraft,
													feeRateWeeklyBps: Number(event.target.value),
												})
											}
										/>
									</label>
									<label className="text-xs text-muted-foreground">
										Monthly
										<Input
											className="mt-1"
											inputMode="numeric"
											value={String(settingsDraft.feeRateMonthlyBps)}
											onChange={(event) =>
												setSettingsDraft({
													...settingsDraft,
													feeRateMonthlyBps: Number(event.target.value),
												})
											}
										/>
									</label>
								</div>
								<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Risk
								</p>
								<div className="grid grid-cols-2 gap-2">
									<label className="text-xs text-muted-foreground">
										Risk / trade %
										<Input
											className="mt-1"
											inputMode="decimal"
											value={String(settingsDraft.riskPerTradePct)}
											onChange={(event) =>
												setSettingsDraft({
													...settingsDraft,
													riskPerTradePct: Number(event.target.value),
												})
											}
										/>
									</label>
									<label className="text-xs text-muted-foreground">
										Max stock weight %
										<Input
											className="mt-1"
											inputMode="decimal"
											value={String(settingsDraft.maxStockWeightPct)}
											onChange={(event) =>
												setSettingsDraft({
													...settingsDraft,
													maxStockWeightPct: Number(event.target.value),
												})
											}
										/>
									</label>
									<label className="text-xs text-muted-foreground">
										Max positions
										<Input
											className="mt-1"
											inputMode="numeric"
											value={String(settingsDraft.maxPositions)}
											onChange={(event) =>
												setSettingsDraft({
													...settingsDraft,
													maxPositions: Number(event.target.value),
												})
											}
										/>
									</label>
									<label className="text-xs text-muted-foreground">
										Cash reserve %
										<Input
											className="mt-1"
											inputMode="decimal"
											value={String(settingsDraft.minCashReservePct)}
											onChange={(event) =>
												setSettingsDraft({
													...settingsDraft,
													minCashReservePct: Number(event.target.value),
												})
											}
										/>
									</label>
								</div>
							</div>
							<div className="space-y-2">
								<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Public visibility
								</p>
								<div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
									<Checkbox
										label="AUM"
										checked={settingsDraft.publicShowAum}
										onChange={(checked) =>
											setSettingsDraft({
												...settingsDraft,
												publicShowAum: checked,
											})
										}
									/>
									<Checkbox
										label="Trades"
										checked={settingsDraft.publicShowTrades}
										onChange={(checked) =>
											setSettingsDraft({
												...settingsDraft,
												publicShowTrades: checked,
											})
										}
									/>
									<Checkbox
										label="Holdings"
										checked={settingsDraft.publicShowHoldings}
										onChange={(checked) =>
											setSettingsDraft({
												...settingsDraft,
												publicShowHoldings: checked,
											})
										}
									/>
									<Checkbox
										label="Fees"
										checked={settingsDraft.publicShowFees}
										onChange={(checked) =>
											setSettingsDraft({
												...settingsDraft,
												publicShowFees: checked,
											})
										}
									/>
								</div>
								<p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Routing
								</p>
								<label className="block text-xs text-muted-foreground">
									Live alert channel ID
									<Input
										className="mt-1"
										value={settingsDraft.liveAlertChannelId ?? ""}
										onChange={(event) =>
											setSettingsDraft({
												...settingsDraft,
												liveAlertChannelId: event.target.value || null,
											})
										}
									/>
								</label>
								<label className="block text-xs text-muted-foreground">
									Paper alert channel ID
									<Input
										className="mt-1"
										value={settingsDraft.paperAlertChannelId ?? ""}
										onChange={(event) =>
											setSettingsDraft({
												...settingsDraft,
												paperAlertChannelId: event.target.value || null,
											})
										}
									/>
								</label>
								<div className="flex flex-wrap gap-3 pt-1">
									<Checkbox
										label="Engine enabled"
										checked={settingsDraft.engineEnabled}
										onChange={(checked) =>
											setSettingsDraft({
												...settingsDraft,
												engineEnabled: checked,
											})
										}
									/>
									<Checkbox
										label="Live trading enabled"
										checked={settingsDraft.liveEnabled}
										onChange={(checked) =>
											setSettingsDraft({
												...settingsDraft,
												liveEnabled: checked,
											})
										}
									/>
								</div>
							</div>
						</div>
					</SectionCard>
				</div>
			) : null}

			{book === "paper" ? (
				<SectionCard
					title="Smoke test"
					description="Resets the paper book, runs one engine cycle and returns a persisted report."
					actions={
						<StatusBadge tone="warning">
							<FlaskConical className="mr-1 inline size-3" /> paper only
						</StatusBadge>
					}
				>
					<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
						<label className="block flex-1 text-xs font-medium text-muted-foreground">
							Starting cash
							<Input
								className="mt-1"
								value={startingCash}
								onChange={(event) => setStartingCash(event.target.value)}
							/>
						</label>
						<Button variant="secondary" onClick={resetPaper} disabled={busy}>
							Reset
						</Button>
						<Button onClick={runSmoke} disabled={busy}>
							Run smoke test
						</Button>
					</div>
					{smoke ? (
						<pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-border/60 bg-background p-3 text-xs">
							{JSON.stringify(smoke, null, 2)}
						</pre>
					) : null}
				</SectionCard>
			) : null}
		</PageShell>
	);
}
